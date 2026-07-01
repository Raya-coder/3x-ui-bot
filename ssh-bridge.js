#!/usr/bin/env node
/**
 * SSH Bridge for 3x-ui Bot — Enhanced with interactive session support
 * 
 * Features:
 * - One-shot command execution (POST /exec)
 * - Interactive session support (POST /session/start, /session/send, /session/read, /session/close)
 * - Context detection (confirm dialogs, nano, vim, apt, etc.)
 * - Returns suggested buttons for interactive prompts
 * 
 * Setup:
 *   npm install ssh2
 *   node ssh-bridge.js
 * 
 * Or without ssh2 (uses system ssh command):
 *   node ssh-bridge.js
 */

const http = require('http');
const { exec, execSync } = require('child_process');

// ═══ CONFIGURATION ═══════════════════════════════════════════
const PORT = process.env.PORT || 8022;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "CHANGE_ME";
const MAX_OUTPUT = 4000;
const TIMEOUT_MS = 30000;
const SESSION_TIMEOUT_MS = 120000; // 2 minutes idle = session expires
// ═════════════════════════════════════════════════════════════

// ─── Context Detection (inspired by eazy-ssh) ───────────────
const CONTEXT_PATTERNS = {
  confirm: [/\[Y\/n\]/i, /\[y\/N\]/i, /\(y\/n\)/i, /\(Y\/N\)/i, /yes\/no/i, /Continue\?/i, /\[OK\]/i, /\[Cancel\]/i, /<OK>/i, /<Cancel>/i],
  apt_dialog: [/Daemons using outdated libraries/i, /Which services should be restarted/i, /Configuring/i, /dpkg/i],
  nano: [/GNU nano/i, /\[ New File \]/i, /\^X Exit/i],
  vim: [/-- INSERT --/i, /-- VISUAL --/i, /E37:/i],
  htop: [/PID\s+USER\s+PRI/i, /CPU%/i],
  top: [/top -/i, /load average/i],
  less: [/\(END\)/i, /lines /i],
  password_prompt: [/password/i, /Password/i, /passphrase/i],
  input_prompt: [/: $/, /:$/m, /\?\s*$/m],
};

function detectContext(output) {
  const lower = output.toLowerCase();
  for (const [ctx, patterns] of Object.entries(CONTEXT_PATTERNS)) {
    for (const p of patterns) {
      if (p.test(output) || p.test(lower)) {
        return ctx;
      }
    }
  }
  return 'shell';
}

function getSuggestedButtons(context, originalCommand) {
  switch (context) {
    case 'confirm':
      return [
        { label: "✅ Y + ⏎", input: "y" },
        { label: "❌ N + ⏎", input: "n" },
        { label: "⏎ Enter", input: "" },
        { label: "🔄 yes | (auto-confirm all)", input: "__yes_pipe__" },
      ];
    case 'apt_dialog':
      return [
        { label: "✅ ⏎ Enter (OK)", input: "" },
        { label: "❌ Esc (Cancel)", input: "__esc__" },
        { label: "⏎ Tab (next)", input: "__tab__" },
      ];
    case 'nano':
      return [
        { label: "💾 Ctrl+O (Save)", input: "__ctrl_o__" },
        { label: "❌ Ctrl+X (Exit)", input: "__ctrl_x__" },
        { label: "⏎ Enter", input: "" },
      ];
    case 'vim':
      return [
        { label: "💾 :wq (Save+Quit)", input: "__vim_wq__" },
        { label: "❌ :q! (Force Quit)", input: "__vim_q__" },
        { label: "⎋ Esc", input: "__esc__" },
      ];
    case 'password_prompt':
      return [
        { label: "⏎ Enter (skip)", input: "" },
      ];
    case 'less':
      return [
        { label: "❌ q (Quit)", input: "q" },
        { label: "⬇️ Space (Next)", input: " " },
      ];
    case 'input_prompt':
      return [
        { label: "⏎ Enter", input: "" },
      ];
    default:
      return [];
  }
}

function inputToPipedCommand(input, originalCommand) {
  // Convert special inputs to piped commands
  if (input === '__yes_pipe__') return `yes | ${originalCommand}`;
  if (input === '__esc__') return `printf '\\x1b' | ${originalCommand}`;
  if (input === '__tab__') return `printf '\\t' | ${originalCommand}`;
  if (input === '__ctrl_o__') return `printf '\\x0f' | ${originalCommand}`;
  if (input === '__ctrl_x__') return `printf '\\x18' | ${originalCommand}`;
  if (input === '__ctrl_c__') return `printf '\\x03' | ${originalCommand}`;
  if (input === '__vim_wq__') return `printf '\\x1b:wq\\r' | ${originalCommand}`;
  if (input === '__vim_q__') return `printf '\\x1b:q!\\r' | ${originalCommand}`;
  // Regular input: pipe it
  if (input === '') return `echo '' | ${originalCommand}`;
  return `echo '${input.replace(/'/g, "'\\''")}' | ${originalCommand}`;
}

// ─── Session Management ──────────────────────────────────────
const sessions = new Map(); // sessionId -> { output, lastActivity, command }

function createSession(command) {
  const id = Math.random().toString(36).slice(2, 10);
  sessions.set(id, {
    command,
    output: '',
    lastActivity: Date.now(),
    context: 'shell',
  });
  return id;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.lastActivity > SESSION_TIMEOUT_MS) {
    sessions.delete(id);
    return null;
  }
  return s;
}

function updateSession(id, updates) {
  const s = sessions.get(id);
  if (!s) return;
  Object.assign(s, updates, { lastActivity: Date.now() });
}

function closeSession(id) {
  sessions.delete(id);
}

// Cleanup expired sessions every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TIMEOUT_MS) {
      sessions.delete(id);
    }
  }
}, 60000);

// ─── HTTP Server ─────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      
      // Verify token
      if (data.token !== BRIDGE_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
        return;
      }

      const path = req.url;

      // ─── /exec — one-shot command execution ───
      if (path === '/exec') {
        const command = data.command;
        if (!command) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Command required' }));
          return;
        }

        // Block dangerous commands
        const dangerous = ['rm -rf /', 'mkfs', 'dd if=', 'shutdown', 'reboot', 'halt', 'init 0'];
        for (const d of dangerous) {
          if (command.includes(d)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: '❌ Command blocked for safety', context: 'error' }));
            return;
          }
        }

        exec(command, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n' : '') + stderr;
          if (error && !stdout && !stderr) output = error.message;
          
          if (output.length > MAX_OUTPUT) {
            output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
          }

          const context = detectContext(output);
          const buttons = getSuggestedButtons(context, command);
          const sessionId = createSession(command);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            output: output || '(no output)',
            context,
            buttons,
            sessionId,
          }));
        });
        return;
      }

      // ─── /send — send input to a session (re-run with piped input) ───
      if (path === '/send') {
        const { sessionId, input } = data;
        const session = getSession(sessionId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session expired or not found' }));
          return;
        }

        // Build piped command
        const pipedCommand = inputToPipedCommand(input, session.command);

        exec(pipedCommand, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n' : '') + stderr;
          if (error && !stdout && !stderr) output = error.message;
          
          if (output.length > MAX_OUTPUT) {
            output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
          }

          const context = detectContext(output);
          const buttons = getSuggestedButtons(context, session.command);
          updateSession(sessionId, { output, context });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            output: output || '(no output)',
            context,
            buttons,
            sessionId,
          }));
        });
        return;
      }

      // ─── /close — close a session ───
      if (path === '/close') {
        const { sessionId } = data;
        closeSession(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ output: 'Session closed', context: 'closed' }));
        return;
      }

      // ─── /health ───
      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown endpoint' }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SSH Bridge (enhanced) running on port ${PORT}`);
  console.log(`Token: ${BRIDGE_TOKEN.slice(0, 4)}...${BRIDGE_TOKEN.slice(-4)}`);
  console.log('Endpoints: /exec, /send, /close, /health');
});
