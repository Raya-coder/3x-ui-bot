/**
 * ============================================================
 *  3X-UI Telegram Bot — Cloudflare Worker (Complete Rewrite)
 * ============================================================
 *
 *  KV Namespace bindings (wrangler.toml):
 *    BOT_KV    — persistent storage (users, panels, renewals, admins, alerts, backups)
 *    BOT_STATE — action tokens & chat state (callback data >64 bytes, registration flows)
 *
 *  Required Secrets / Environment Variables:
 *    BOT_TOKEN            — Telegram bot token
 *    ADMIN_CHAT_IDS       — Comma-separated admin Telegram IDs (or set via /makeadmin)
 *    PANELS_JSON          — JSON config for panels (or add via /addpanel)
 * ============================================================
 */

// ─── Constants ────────────────────────────────────────────────

const BYTES_PER_GB = 1024 * 1024 * 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

const QR_CODE_API = "https://api.qrserver.com/v1/create-qr-code/";
const QR_CODE_SIZE = 300;

const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const PER_PAGE = 10;

const DEFAULT_CPU_RAM_ALERT_THRESHOLD = 80;
const DEFAULT_ALERT_COOLDOWN_MINUTES = 60;

// KV key prefixes  (BOT_KV)
const KV_USERS_PREFIX = "user:";
const KV_PANELS_KEY = "panels:config";
const KV_RENEWAL_PREFIX = "renewal:";
const KV_ALERT_PREFIX = "alert:";
const KV_BACKUP_PREFIX = "backup:";
const KV_ADMIN_IDS_KEY = "admin:ids";
const KV_ADMIN_ROLE_PREFIX = "admin:role:";
const KV_BANNED_PREFIX = "banned:";
const KV_BANNED_LIST = "banned:list";
const KV_SUSPENDED_PREFIX = "suspended:";
const KV_ERROR_LOG_PREFIX = "error:";
const KV_ERROR_LOG_LIST = "errors:list";
const MAX_ERRORS_STORED = 100;

// KV key prefixes  (BOT_STATE)
const STATE_REG_PREFIX = "reg:";
const STATE_ADDPANEL_PREFIX = "addpanel:";
const STATE_RENEW_PREFIX = "reg:renew:";

// 3x-ui API paths — updated for 3x-ui v3.4.x (the version user is running).
// Source: internal/web/controller/*.go from MHSanaei/3x-ui (commit 3.4.2).
//
// Major changes from older 3x-ui versions:
// - /panel/api/setting/all is now POST (was GET)
// - /panel/api/setting/apiTokens is the new dedicated endpoint for listing
//   API tokens (was /panel/api/api-tokens/list which 404'd on user's panel)
// - /panel/api/setting/restartPanel replaces /panel/api/server/restartPanel
// - /panel/api/clients/onlines (POST) replaces /panel/api/inbounds/onlines
// - /panel/api/server/logs/:count (POST) replaces /panel/api/server/getLogs
// - /panel/api/server/getPanelUpdateInfo is now GET (was POST)
// - /panel/api/users/* endpoints removed — panel users managed via /setting
const API_PATHS = {
  LOGIN: "/login",
  // Inbounds (GET for reads, POST for writes — unchanged in v3.4.x)
  INBOUNDS_LIST: "/panel/api/inbounds/list",
  INBOUNDS_GET: "/panel/api/inbounds/get/",
  INBOUNDS_UPDATE: "/panel/api/inbounds/update/",
  INBOUNDS_ADD: "/panel/api/inbounds/add",
  INBOUNDS_DEL: "/panel/api/inbounds/del/",
  // NOTE: INBOUNDS_ONLINE kept for backward compat, but v3.4.x uses
  // CLIENTS_ONLINES instead. handleOnline tries both.
  INBOUNDS_ONLINE: "/panel/api/inbounds/onlines",
  INBOUNDS_RESET_TRAFFIC: "/panel/api/inbounds/resetAllTraffics",
  // Clients (v3.4.x)
  CLIENTS_LIST: "/panel/api/clients/list",
  CLIENTS_GET: "/panel/api/clients/get/",
  CLIENTS_ADD: "/panel/api/clients/add",
  CLIENTS_UPDATE: "/panel/api/clients/update/",
  CLIENTS_DEL: "/panel/api/clients/del/",
  CLIENTS_RESET_TRAFFIC: "/panel/api/clients/resetTraffic/",  // renamed from reset_traffic in v3
  CLIENTS_IPS: "/panel/api/clients/ips/",
  CLIENTS_RENEW: "/panel/api/clients/renew/",
  CLIENT_TRAFFIC: "/panel/api/clients/traffic/",  // v3: /clients/traffic/:email (was /client/traffic/)
  CLIENTS_TRAFFICS: "/panel/api/clients/traffics",
  CLIENTS_ONLINES: "/panel/api/clients/onlines",  // v3.4.x: replaces /inbounds/onlines
  // Nodes
  NODES_LIST: "/panel/api/nodes/list",
  NODES_ADD: "/panel/api/nodes/add",
  NODES_UPDATE: "/panel/api/nodes/update/",
  NODES_DEL: "/panel/api/nodes/del/",
  NODES_PROBE: "/panel/api/nodes/probe/",
  NODES_SYNC: "/panel/api/nodes/sync/",
  // Hosts
  HOSTS_LIST: "/panel/api/hosts/list",
  HOSTS_ADD: "/panel/api/hosts/add",
  HOSTS_UPDATE: "/panel/api/hosts/update/",
  HOSTS_DEL: "/panel/api/hosts/del/",
  // API Tokens (v3.4.x — moved under /setting)
  API_TOKENS_LIST: "/panel/api/setting/apiTokens",          // GET (was POST /api-tokens/list)
  API_TOKENS_ADD: "/panel/api/setting/apiTokens/create",    // POST
  API_TOKENS_DEL: "/panel/api/setting/apiTokens/delete/",   // POST :id
  API_TOKENS_SET_ENABLED: "/panel/api/setting/apiTokens/setEnabled/", // POST :id
  // Outbounds (v3.4.x — under /xray)
  OUTBOUNDS_LIST: "/panel/api/xray/getOutboundsTraffic",  // GET (was /outbounds/list)
  OUTBOUNDS_TRAFFICS: "/panel/api/xray/getOutboundsTraffic",
  // Server (v3.4.x)
  SERVER_STATUS: "/panel/api/server/status",
  SERVER_GET_DB: "/panel/api/server/getDb",
  SERVER_STOP_XRAY: "/panel/api/server/stopXrayService",
  SERVER_RESTART_XRAY: "/panel/api/server/restartXrayService",
  // NOTE: panel restart moved to /setting/restartPanel (POST)
  SERVER_RESTART_PANEL: "/panel/api/setting/restartPanel",
  // v3.4.x: /server/logs/:count (POST) replaces /server/getLogs (POST/GET)
  SERVER_GET_LOGS: "/panel/api/server/logs/100",
  SERVER_XRAY_LOGS: "/panel/api/server/xraylogs/100",
  SERVER_PANEL_UPDATE: "/panel/api/server/getPanelUpdateInfo",  // GET in v3.4.x (was POST)
  SERVER_GET_XRAY_VERSION: "/panel/api/server/getXrayVersion",
  SERVER_UPDATE_XRAY: "/panel/api/server/installXray/",  // v3: installXray replaces updateXray
  SERVER_INSTALL_XRAY: "/panel/api/server/installXray/",
  // Settings (v3.4.x — all POST now)
  SETTINGS_ALL: "/panel/api/setting/all",
  SETTINGS_UPDATE: "/panel/api/setting/update",
  SETTINGS_UPDATE_USER: "/panel/api/setting/updateUser",  // v3: panel user management
  SETTINGS_RESTART_PANEL: "/panel/api/setting/restartPanel",
  // Users (panel users) — REMOVED in v3.4.x; managed via /setting/updateUser
  // Kept for backward compat with older panels; will 404 on v3.4.x
  USERS_LIST: "/panel/api/users/list",
  USERS_ADD: "/panel/api/users/add",
  USERS_DEL: "/panel/api/users/del/",
  // Database
  DATABASE_BACKUP: "/panel/api/server/getDb",
  DATABASE_RESTORE: "/panel/api/server/importDB",
};

const PANEL_VERSION_PATHS = [
  // v3.4.x: getPanelUpdateInfo is GET (was POST in older versions)
  { path: "/panel/api/server/getPanelUpdateInfo", method: "GET" },
  { path: "/panel/api/server/getPanelUpdateInfo", method: "POST" },  // fallback for older versions
  { path: "/panel/api/panel/version", method: "GET" },
  { path: "/panel/api/version", method: "GET" },
  { path: "/panel/api/server/version", method: "GET" },
  { path: "/panel/api/server/getVersion", method: "GET" },
];

const XRAY_VERSION_PATHS = [
  { path: "/panel/api/server/status", method: "GET" },
  { path: "/panel/api/server/getXrayVersion", method: "GET" },
  { path: "/panel/api/xray/getXrayVersion", method: "GET" },
  { path: "/panel/api/xray/version", method: "GET" },
];

// ─── Entry Point ──────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  },
};

// ─── Fetch Handler ────────────────────────────────────────────

async function handleFetch(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── Health check ──
    if (path === "/health") {
      return jsonResponse({ status: "ok", version: "4.0.0" });
    }

    // ── Telegram webhook ──
    if (path === "/webhook" && method === "POST") {
      const body = await request.json();
      ctx.waitUntil(handleTelegramUpdate(body, env));
      return new Response("ok", { status: 200 });
    }

    // ── Legacy usage API ──
    if (path === "/api/usage" && method === "GET") {
      return await handleUsageAPI(url, env);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("handleFetch error:", shortError(error));
    return new Response("Internal Server Error", { status: 500 });
  }
}

// ─── JSON Response Helper ─────────────────────────────────────

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
      ...extraHeaders,
    },
  });
}

// ─── Telegram initData Verification ───────────────────────────

async function verifyTelegramInitData(initDataStr, env) {
  if (!initDataStr || typeof initDataStr !== "string") {
    console.error("verifyTelegramInitData: empty initData");
    return null;
  }
  try {
    const botToken = getBotToken(env);
    if (!botToken) {
      console.error("verifyTelegramInitData: no bot token");
      return null;
    }

    // Parse initData manually to preserve original encoding
    // initData format: key1=value1&key2=value2&...
    // Telegram uses %20 for spaces (not +), so we just decode %XX sequences
    const pairs = initDataStr.split("&");
    const params = {};
    let hash = "";
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);
      if (key === "hash") {
        hash = value;
      } else {
        // Decode percent-encoded characters
        // Telegram uses standard percent-encoding (not application/x-www-form-urlencoded)
        try {
          params[key] = decodeURIComponent(value);
        } catch {
          // If decoding fails, use raw value
          params[key] = value;
        }
      }
    }

    if (!hash) {
      console.error("verifyTelegramInitData: no hash in initData");
      return null;
    }

    // Build data-check-string: sorted keys, format key=value (value is URL-decoded)
    // Telegram expects decoded values in the data-check-string
    const dataCheckString = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("\n");

    // Create secret_key = HMAC-SHA256(key="WebAppData", data=bot_token)
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secretBytes = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));

    // Create hash = HMAC-SHA256(key=secret_key, data=data_check_string)
    const hashKey = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const computedHash = await crypto.subtle.sign("HMAC", hashKey, encoder.encode(dataCheckString));

    // Convert to hex
    const computedHex = [...new Uint8Array(computedHash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (computedHex !== hash) {
      console.error("verifyTelegramInitData: hash mismatch");
      console.error("expected:", hash);
      console.error("computed:", computedHex);
      console.error("dataCheckString:", dataCheckString);
      return null;
    }

    // Parse user (params.user is already decoded)
    const userStr = params.user;
    if (!userStr) {
      console.error("verifyTelegramInitData: no user in initData");
      return null;
    }
    const user = JSON.parse(userStr);
    return user;
  } catch (error) {
    console.error("verifyTelegramInitData error:", shortError(error));
    return null;
  }
}

// ─── Mini App API Handler ─────────────────────────────────────

async function handleMiniAppApi(request, env, path, method, url) {
  try {
    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
        },
      });
    }

    // Verify Telegram initData
    // initData can come from header or query param
    let initData = request.headers.get("X-Telegram-Init-Data") || "";

    // If not in header, try query param (may be URL-encoded)
    if (!initData) {
      const queryInitData = url.searchParams.get("initData");
      if (queryInitData) {
        // URL.searchParams already decodes, so use the raw value
        initData = queryInitData;
      }
    }

    // Debug endpoint
    if (path === "/api/app/debug") {
      return jsonResponse({
        hasInitData: Boolean(initData),
        initDataLength: initData.length,
        initDataPreview: initData ? initData.slice(0, 200) : null,
        hasUser: initData.includes("user="),
        hasHash: initData.includes("hash="),
        hasAuthDate: initData.includes("auth_date="),
        method,
      });
    }

    const user = await verifyTelegramInitData(initData, env);
    if (!user) {
      return jsonResponse({
        error: "Unauthorized",
        message: "Invalid Telegram initData",
        debug: {
          hasInitData: Boolean(initData),
          initDataLength: initData.length,
          hint: "Make sure you opened this from Telegram WebApp button",
        },
      }, 401);
    }

    const chatId = String(user.id);
    const admin = await isAdminAsync(chatId, env);

    // ── Auth check ──
    if (path === "/api/app/auth") {
      const registeredUser = await getUser(env, chatId);
      return jsonResponse({
        user: {
          id: user.id,
          username: user.username || "",
          firstName: user.first_name || "",
          lastName: user.last_name || "",
          photoUrl: user.photo_url || "",
        },
        isAdmin: admin,
        registered: Boolean(registeredUser),
        clientEmail: registeredUser?.clientEmail || null,
        panelId: registeredUser?.panelId || null,
        supportUsername: getSupportUsername(env) || "",
      });
    }

    // ── User: My usage ──
    if (path === "/api/app/my-usage" && method === "GET") {
      const registeredUser = await getUser(env, chatId);
      if (!registeredUser) {
        return jsonResponse({ error: "Not registered" }, 404);
      }
      // Use Promise.race with timeout to prevent hanging
      const client = await Promise.race([
        getClientByIdentifier(registeredUser.clientEmail, env, registeredUser.panelId),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout (20s)")), 20000)),
      ]).catch(() => null);
      const panel = await resolvePanelAsync(env, registeredUser.panelId);
      if (!client || !panel) {
        // Return backup info if panel/client unavailable
        const backup = await getUserBackup(env, chatId);
        if (backup) {
          return jsonResponse({
            client: {
              email: backup.clientEmail,
              totalGB: backup.totalGB,
              usedGB: backup.usedGB,
              remainingGB: backup.remainingGB,
              uploadGB: backup.uploadGB,
              downloadGB: backup.downloadGB,
              expiryTime: backup.expiryTime,
              enabled: backup.enabled,
              expired: backup.expiryTime ? backup.expiryTime < Date.now() : false,
              depleted: false,
            },
            panel: { id: backup.panelId, name: backup.panelName },
            subLink: null,
            fromBackup: true,
            lastUpdated: backup.lastUpdated,
          });
        }
        return jsonResponse({ error: "Client not found" }, 404);
      }
      const traffic = getClientTraffic(client);
      const totalBytes = getClientTotalBytes(client);
      const usedBytes = traffic.up + traffic.down;

      // Update user backup
      try {
        await updateUserBackup(env, chatId, {
          email: getIdentifierFromClient(client),
          panelId: registeredUser.panelId,
          totalGB: totalBytes > 0 ? totalBytes / BYTES_PER_GB : null,
          usedGB: usedBytes / BYTES_PER_GB,
          remainingGB: totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) / BYTES_PER_GB : null,
          uploadGB: traffic.up / BYTES_PER_GB,
          downloadGB: traffic.down / BYTES_PER_GB,
          expiryTime: client.expiryTime > 0 ? Number(client.expiryTime) : null,
          enabled: isClientEnabled(client),
          registeredAt: registeredUser.registeredAt,
        }, panel);
      } catch { /* ignore backup errors */ }

      return jsonResponse({
        client: {
          email: getIdentifierFromClient(client),
          totalGB: totalBytes > 0 ? totalBytes / BYTES_PER_GB : null,
          usedGB: usedBytes / BYTES_PER_GB,
          remainingGB: totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) / BYTES_PER_GB : null,
          uploadGB: traffic.up / BYTES_PER_GB,
          downloadGB: traffic.down / BYTES_PER_GB,
          expiryTime: client.expiryTime > 0 ? Number(client.expiryTime) : null,
          enabled: isClientEnabled(client),
          expired: isClientExpired(client),
          depleted: isClientDepleted(client),
        },
        panel: { id: panel.id, name: panel.name },
        subLink: (client.subId || client.subid)
          ? await buildSubLinkAsync(client.subId || client.subid, panel, env).catch(() => null)
          : null,
      });
    }

    // ── User: Request renewal ──
    if (path === "/api/app/request-renewal" && method === "POST") {
      const registeredUser = await getUser(env, chatId);
      if (!registeredUser) {
        return jsonResponse({ error: "Not registered" }, 404);
      }
      // Check rate limit
      const rateLimitKey = `renewal_ratelimit:${chatId}`;
      const lastRequest = await kvGet(env, rateLimitKey);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (lastRequest && lastRequest.timestamp && (now - lastRequest.timestamp) < oneHour) {
        const remaining = oneHour - (now - lastRequest.timestamp);
        return jsonResponse({
          error: "Rate limited",
          message: `لطفاً ${Math.ceil(remaining / (60 * 1000))} دقیقه دیگر صبر کنید`,
          retryAfterMinutes: Math.ceil(remaining / (60 * 1000)),
        }, 429);
      }
      const body = await request.json().catch(() => ({}));
      const days = Number(body.days) || 0;
      const gb = Number(body.gb) || 0;
      if (days <= 0 && gb <= 0) {
        return jsonResponse({ error: "Invalid amount" }, 400);
      }
      const requestObj = await createRenewalRequest(env, chatId, registeredUser.clientEmail, registeredUser.panelId, days, gb);
      await kvPut(env, rateLimitKey, { timestamp: now });

      // Notify admins
      const adminIds = await getSuperAdminIds(env);
      const panel = await resolvePanelAsync(env, registeredUser.panelId);
      const panelName = panel ? panel.name : registeredUser.panelId;
      const message =
        `🔄 درخواست تمدید جدید\n\n` +
        `👤 کاربر: ${registeredUser.clientEmail}\n` +
        `🖥️ سرور: ${panelName}\n` +
        `${days ? `📅 روز: +${days}\n` : ""}` +
        `${gb ? `📦 حجم: +${gb} GB\n` : ""}` +
        `🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
      const btns = [[
        { text: "✅ تایید", callback_data: `renewal_approve:${requestObj.id}` },
        { text: "❌ رد", callback_data: `renewal_reject:${requestObj.id}` },
      ]];
      for (const adminId of adminIds) {
        try { await sendTelegram(adminId, message, env, btns); } catch { /* ignore */ }
      }
      return jsonResponse({ success: true, requestId: requestObj.id });
    }

    // ── Admin-only endpoints ──
    if (!admin) {
      return jsonResponse({ error: "Forbidden", message: "Admin access required" }, 403);
    }

    // ── Admin: Panels list ──
    if (path === "/api/app/panels" && method === "GET") {
      const panels = await getPanels(env);
      return jsonResponse({ panels: panels.map((p) => ({ id: p.id, name: p.name, url: p.panelUrl, subBaseUrl: p.subBaseUrl || "" })) });
    }

    // ── Admin: Server status ──
    if (path === "/api/app/status" && method === "GET") {
      const panels = await getPanels(env);
      // Use Promise.allSettled for parallel requests with timeout
      const statusPromises = panels.map(async (panel) => {
        try {
          const status = await Promise.race([
            getServerStatus(panel),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout (15s)")), 15000)),
          ]);
          const obj = status?.obj || status;
          return {
            panelId: panel.id,
            panelName: panel.name,
            cpu: Number(obj?.cpu || 0),
            memCurrent: Number(obj?.mem?.current || 0),
            memTotal: Number(obj?.mem?.total || 0),
            diskCurrent: Number(obj?.disk?.current || 0),
            diskTotal: Number(obj?.disk?.total || 0),
            uptime: Number(obj?.uptime || 0),
            xrayRunning: obj?.xray?.running ?? true,
            xrayVersion: obj?.xray?.version || "",
          };
        } catch (error) {
          return { panelId: panel.id, panelName: panel.name, error: shortError(error) };
        }
      });
      const results = await Promise.allSettled(statusPromises);
      /** @type {any[]} */
      const statuses = results.map((r) => {
        if (r.status === "fulfilled") return r.value;
        return { error: r.reason?.message || "Unknown" };
      });
      return jsonResponse({ statuses });
    }

    // ── Admin: List clients ──
    if (path === "/api/app/clients" && method === "GET") {
      const panelId = url.searchParams.get("panelId");
      const search = url.searchParams.get("search");
      const panels = panelId ? [await resolvePanelAsync(env, panelId)].filter(Boolean) : await getPanels(env);

      // Use parallel requests with timeout
      const clientPromises = panels.map(async (panel) => {
        try {
          const clients = search
            ? (await searchClientAcrossPanels(search, env)).filter((r) => r.panel.id === panel.id).map((r) => r.client)
            : await Promise.race([
                listAllClients(panel),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
              ]);
          return clients.map((client) => {
            const traffic = getClientTraffic(client);
            const totalBytes = getClientTotalBytes(client);
            const usedBytes = traffic.up + traffic.down;
            return {
              panelId: panel.id,
              panelName: panel.name,
              email: getIdentifierFromClient(client),
              totalGB: totalBytes > 0 ? totalBytes / BYTES_PER_GB : null,
              usedGB: usedBytes / BYTES_PER_GB,
              uploadGB: traffic.up / BYTES_PER_GB,
              downloadGB: traffic.down / BYTES_PER_GB,
              expiryTime: client.expiryTime > 0 ? Number(client.expiryTime) : null,
              enabled: isClientEnabled(client),
              expired: isClientExpired(client),
              depleted: isClientDepleted(client),
              subId: client.subId || client.subid || "",
            };
          });
        } catch (error) {
          return [];
        }
      });
      const settledResults = await Promise.allSettled(clientPromises);
      /** @type {any[]} */
      const results = settledResults.flatMap((r) => {
        if (r.status === "fulfilled" && Array.isArray(r.value)) return r.value;
        return [];
      });
      return jsonResponse({ clients: results });
    }

    // ── Admin: Create client ──
    if (path === "/api/app/clients/create" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { panelId, email, days, gb } = body;
      if (!panelId || !email || !days) {
        return jsonResponse({ error: "Missing required fields" }, 400);
      }
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        return jsonResponse({ error: "Panel not found" }, 404);
      }
      try {
        await createClient(panel, email, Number(days), Number(gb) || 0);
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: shortError(error) }, 500);
      }
    }

    // ── Admin: Update client (enable/disable) ──
    if (path === "/api/app/clients/update" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { panelId, email, enable, addGB, addDays, resetTraffic } = body;
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) return jsonResponse({ error: "Panel not found" }, 404);
      const client = await getClientByIdentifier(email, env, panelId);
      if (!client) return jsonResponse({ error: "Client not found" }, 404);
      try {
        if (enable !== undefined) await updateClient(panel, client, { enable: Boolean(enable) });
        if (addGB) await addGBToClient(panel, client, Number(addGB));
        if (addDays) await addDaysToClient(panel, client, Number(addDays));
        if (resetTraffic) await resetClientTraffic(panel, email, env);
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: shortError(error) }, 500);
      }
    }

    // ── Admin: Delete client ──
    if (path === "/api/app/clients/delete" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { panelId, email } = body;
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) return jsonResponse({ error: "Panel not found" }, 404);
      try {
        await deleteClient(panel, email, env);
        const user = await findUserByEmail(env, email, panel.id);
        if (user) await deleteUser(env, user.chatId);
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: shortError(error) }, 500);
      }
    }

    // ── Admin: Outbounds list ──
    if (path === "/api/app/outbounds" && method === "GET") {
      const panels = await getPanels(env);
      const results = [];
      for (const panel of panels) {
        try {
          const outbounds = await Promise.race([
            listOutbounds(panel),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
          ]);
          for (const ob of outbounds) {
            results.push({ panelId: panel.id, panelName: panel.name, tag: ob.tag, protocol: ob.protocol });
          }
        } catch (error) {
          // skip
        }
      }
      return jsonResponse({ outbounds: results });
    }

    // ── Admin: Outbound traffic ──
    if (path === "/api/app/outbound-traffic" && method === "GET") {
      const panels = await getPanels(env);
      const results = [];
      for (const panel of panels) {
        try {
          const traffics = await Promise.race([
            getOutboundsTraffic(panel),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
          ]);
          for (const t of traffics) {
            results.push({
              panelId: panel.id,
              panelName: panel.name,
              tag: t.tag,
              up: t.up,
              down: t.down,
              total: t.total,
              usedGB: (t.up + t.down) / BYTES_PER_GB,
              totalGB: t.total > 0 ? t.total / BYTES_PER_GB : null,
            });
          }
        } catch (error) {
          // skip
        }
      }
      return jsonResponse({ traffics: results });
    }

    // ── Admin: API tokens ──
    if (path === "/api/app/api-tokens" && method === "GET") {
      const panels = await getPanels(env);
      const results = [];
      for (const panel of panels) {
        try {
          const tokens = await Promise.race([
            listApiTokens(panel),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
          ]);
          for (const token of tokens) {
            results.push({
              panelId: panel.id,
              panelName: panel.name,
              id: token.id,
              name: token.name,
              enabled: token.enabled,
              tokenPreview: token.token ? token.token.slice(0, 8) + "..." + token.token.slice(-4) : "",
            });
          }
        } catch (error) {
          // skip
        }
      }
      return jsonResponse({ tokens: results });
    }

    // ── Admin: Settings ──
    if (path === "/api/app/settings" && method === "GET") {
      const panelId = url.searchParams.get("panelId");
      if (!panelId) return jsonResponse({ error: "panelId required" }, 400);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) return jsonResponse({ error: "Panel not found" }, 404);
      try {
        const settings = await Promise.race([
          getAllSettings(panel),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
        ]);
        return jsonResponse({ settings: settings || {} });
      } catch (error) {
        return jsonResponse({ error: shortError(error) }, 500);
      }
    }

    // ── Admin: Online users ──
    if (path === "/api/app/online" && method === "GET") {
      const panels = await getPanels(env);
      const onlinePromises = panels.map(async (panel) => {
        try {
          const onlineResponse = await Promise.race([
            panelApi(panel, API_PATHS.INBOUNDS_ONLINE, "GET"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000)),
          ]);
          const users = extractOnlineUsers(onlineResponse);
          return { panelId: panel.id, panelName: panel.name, users, count: users.length };
        } catch (error) {
          return { panelId: panel.id, panelName: panel.name, users: [], count: 0, error: shortError(error) };
        }
      });
      const results = await Promise.allSettled(onlinePromises);
      /** @type {any[]} */
      const panels2 = results.map((r) => {
        if (r.status === "fulfilled") return r.value;
        return { users: [], count: 0, error: r.reason?.message || "Unknown" };
      });
      const totalCount = panels2.reduce((sum, p) => sum + (p.count || 0), 0);
      return jsonResponse({ totalCount, panels: panels2 });
    }

    // ── Admin: Pending renewals ──
    if (path === "/api/app/renewals" && method === "GET") {
      const pending = await getPendingRenewals(env);
      return jsonResponse({ renewals: pending });
    }

    // ── Admin: Approve/Reject renewal ──
    if (path === "/api/app/renewals/act" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { requestId, action } = body;
      const renewalRequest = await getRenewalRequest(env, requestId);
      if (!renewalRequest || renewalRequest.status !== "pending") {
        return jsonResponse({ error: "Request not found" }, 404);
      }
      if (action === "approve") {
        try {
          const panel = await resolvePanelAsync(env, renewalRequest.panelId);
          const client = await getClientByIdentifier(renewalRequest.clientEmail, env, renewalRequest.panelId);
          if (panel && client) {
            if (renewalRequest.daysRequested) await addDaysToClient(panel, client, renewalRequest.daysRequested);
            if (renewalRequest.gbRequested) await addGBToClient(panel, client, renewalRequest.gbRequested);
          }
          await updateRenewalStatus(env, requestId, "approved");
          try { await sendTelegram(renewalRequest.chatId, "✅ درخواست تمدید شما تایید شد!", env); } catch { /* ignore */ }
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({ error: shortError(error) }, 500);
        }
      } else if (action === "reject") {
        await updateRenewalStatus(env, requestId, "rejected");
        try { await sendTelegram(renewalRequest.chatId, "❌ درخواست تمدید شما رد شد.", env); } catch { /* ignore */ }
        return jsonResponse({ success: true });
      }
      return jsonResponse({ error: "Invalid action" }, 400);
    }

    // ── Admin: Xray restart ──
    if (path === "/api/app/xray/restart" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { panelId } = body;
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) return jsonResponse({ error: "Panel not found" }, 404);
      try {
        await restartXray(panel);
        await kvPut(env, `${KV_ALERT_PREFIX}xray:${panelId}`, { timestamp: Date.now(), status: "running" });
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: shortError(error) }, 500);
      }
    }

    // ── Admin: Panel restart ──
    if (path === "/api/app/panel/restart" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { panelId } = body;
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) return jsonResponse({ error: "Panel not found" }, 404);
      try {
        await restartPanel(panel);
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: shortError(error) }, 500);
      }
    }

    // ── Admin: Get backup ──
    if (path === "/api/app/backup" && method === "GET") {
      const panelId = url.searchParams.get("panelId");
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) return jsonResponse({ error: "Panel not found" }, 404);
      try {
        const headers = buildAuthHeaders(panel);
        const candidates = buildApiUrlCandidates(panel, API_PATHS.SERVER_GET_DB);
        for (const u of candidates) {
          try {
            const resp = await fetch(u, { method: "GET", headers });
            if (resp.ok) {
              const buffer = await resp.arrayBuffer();
              return new Response(buffer, {
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Content-Disposition": `attachment; filename="backup_${slugify(panel.name)}_${new Date().toISOString().slice(0, 10)}.db"`,
                },
              });
            }
          } catch { /* try next */ }
        }
        return jsonResponse({ error: "Backup failed" }, 500);
      } catch (error) {
        return jsonResponse({ error: shortError(error) }, 500);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("handleMiniAppApi error:", shortError(error));
    return jsonResponse({ error: "Internal server error", message: shortError(error) }, 500);
  }
}

// ─── Scheduled Handler ────────────────────────────────────────

async function handleScheduled(event, env, ctx) {
  const cron = event.cron || "";

  if (cron === "*/5 * * * *" || !cron) {
    ctx.waitUntil(checkXrayHealthAllPanels(env));
  }
  if (cron === "*/10 * * * *" || !cron) {
    ctx.waitUntil(checkResourceAlertsAllPanels(env));
    ctx.waitUntil(checkClientAlertsAllPanels(env));
  }
  if (cron === "0 9 * * *" || !cron) {
    ctx.waitUntil(sendDailyReportAllPanels(env));
  }
  if (cron === "0 */6 * * *" || !cron) {
    ctx.waitUntil(autoBackupAllPanels(env));
  }
  if (cron === "*/30 * * * *" || !cron) {
    ctx.waitUntil(processPendingRenewals(env));
  }
}

// ─── Utility Functions ────────────────────────────────────────

function parseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function assertOk(response, label) {
  if (!response.ok) {
    let errorText = "";
    try { errorText = await response.text(); } catch { errorText = response.statusText; }
    throw new Error(`${label} error ${response.status}: ${errorText || response.statusText}`);
  }
  return response;
}

function assertPanelPayload(data) {
  if (data && typeof data === "object" && data.success === false) {
    const message = data.msg || data.message || data.error || data.reason || JSON.stringify(data);
    throw new Error(`Panel API error: ${message}`);
  }
  return data;
}

function trimUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function normalizeApiPrefix(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  return v.startsWith("/") ? v : `/${v}`;
}

function joinUrl(...parts) {
  return parts
    .map((part) => String(part ?? "").trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim().replace(/,/g, "");
}

function sameIdentifier(a, b) {
  const x = normalizeIdentifier(a);
  const y = normalizeIdentifier(b);
  if (!x || !y) return false;
  return x === y || x.toLocaleLowerCase() === y.toLocaleLowerCase();
}

function slugify(value) {
  return normalizeIdentifier(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "panel";
}

function readNumberValue(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "string") value = value.replace(/,/g, "").trim();
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(String(value).replace(/,/g, ""));
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function formatGB(bytes) {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${(safeBytes / BYTES_PER_GB).toFixed(2)} GB`;
}

function formatPercent(used, total) {
  if (!total || total <= 0) return "نامحدود";
  return `${((used / total) * 100).toFixed(1)}%`;
}

function formatDate(timestamp) {
  if (!timestamp || timestamp <= 0) return "نامحدود";
  const date = new Date(timestamp);
  return date.toLocaleDateString("fa-IR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatRemainingTime(timestamp) {
  if (!timestamp || timestamp <= 0) return "نامحدود";
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return "منقضی شده";
  const days = Math.floor(remaining / MS_PER_DAY);
  const hours = Math.floor((remaining % MS_PER_DAY) / MS_PER_HOUR);
  if (days > 0) return `${days} روز و ${hours} ساعت`;
  return `${hours} ساعت`;
}

function formatUptime(ms) {
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return `${days}d ${hours}h ${minutes}m`;
}

function shortError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 300);
}

function generateToken(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function generateSubId(length = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function generateClientId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* fallback */ }
  return generateToken(36);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function byteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

function safeCallbackData(action, identifier) {
  const data = `${action}:${identifier}`;
  if (byteLength(data) > 64) return null;
  return data;
}

function splitCallbackData(data) {
  const parts = String(data || "").split(":");
  return { action: parts[0], param: parts.slice(1).join(":") };
}

function normalizeIdList(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [String(value)].filter(Boolean);
}

function parseInboundIds(value) {
  return normalizeIdList(value);
}

// ─── Parse Command Payload ────────────────────────────────────

const COMMAND_ALIASES = {
  search: ["search", "s", "جستجو"],
  user: ["user", "u", "کاربر"],
  create: ["create", "adduser", "add", "new", "ساخت", "افزودن"],
  delete: ["delete", "del", "rm", "remove", "حذف"],
  enable: ["enable", "en", "فعال"],
  disable: ["disable", "dis", "غیرفعال"],
  addgb: ["addgb", "addtraffic", "volume", "حجم"],
  renew: ["renew", "extend", "تمدید"],
  link: ["link", "sub", "subscription", "لینک"],
  clients: ["clients", "list", "کاربران"],
  status: ["status", "وضعیت"],
  online: ["online", "آنلاین"],
  report: ["report", "گزارش"],
  versions: ["versions", "ver", "نسخه"],
  xray_restart: ["xray_restart", "xrayrestart", "restart_xray"],
  xray_stop: ["xray_stop", "xraystop", "stop_xray"],
  xray_version: ["xray_version", "xrayversion"],
  xray_update: ["xray_update", "xrayupdate"],
  panel_version: ["panel_version", "panelversion"],
  panel_update: ["panel_update", "panelupdate"],
  export: ["export", "خروجی"],
  addpanel: ["addpanel", "addserver"],
  dellpanel: ["dellpanel", "delpanel", "dellserver"],
  panels: ["panels", "servers", "سرورها"],
  makeadmin: ["makeadmin"],
  adminadd: ["adminadd"],
  admindel: ["admindel"],
  backup: ["backup", "بکاپ"],
  ban: ["ban","مسدود"],
  unban: ["unban","رفع_مسدود"],
  suspend: ["suspend","تعلیق"],
  unsuspend: ["unsuspend","رفع_تعلیق"],
  bannedlist: ["bannedlist","banned"],
  addadmin: ["addadmin"],
  removeadmin: ["removeadmin","deladmin"],
  admins: ["admins","adminlist"],
};

function parseCommandPayload(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const rawCmd = parts[0].replace(/^\/+/, "").split("@")[0].toLowerCase();
  const args = parts.slice(1);

  for (const [canonical, aliases] of Object.entries(COMMAND_ALIASES)) {
    if (aliases.includes(rawCmd)) {
      return { command: canonical, args, raw: trimmed };
    }
  }
  return { command: rawCmd, args, raw: trimmed };
}

// ─── Subscription Link ────────────────────────────────────────

function buildSubLink(subId, panel) {
  const base = panel.subBaseUrl ? String(panel.subBaseUrl).replace(/\/+$/, "") : null;
  if (!base) throw new Error("SUB_BASE_URL برای این سرور تنظیم نشده است");
  const rawSubPath = String(panel.subPath ?? "sub").replace(/^\/+|\/+$/g, "");
  const subPath = rawSubPath || "sub";
  const baseLastSegment = base.split("/").filter(Boolean).pop();
  const parts = [base];
  if (subPath && baseLastSegment !== subPath) parts.push(subPath);
  parts.push(String(subId).replace(/^\/+|\/+$/g, ""));
  return parts.join("/");
}

/**
 * Resolve subscription base URL + subPath for a panel.
 *
 * Priority:
 * 1. panel.subBaseUrl (explicitly set in panel config) — use as-is
 * 2. KV-cached value from previous settings fetch (5 min TTL)
 * 3. Fetch /panel/api/setting/all and derive:
 *    - host: settings.subDomain (if set) OR hostname from panel.panelUrl
 *    - port: settings.subPort (omit if 80/443/0)
 *    - protocol: https if port=443, else http
 *    - subPath: settings.subPath (stripped of slashes) — overrides panel.subPath
 * Returns { baseUrl, subPath, subEnable } or null on failure.
 */
async function resolveSubConfig(panel, env) {
  // 1. Explicit config
  if (panel.subBaseUrl) {
    const rawSubPath = String(panel.subPath ?? "sub").replace(/^\/+|\/+$/g, "");
    return { baseUrl: String(panel.subBaseUrl).replace(/\/+$/, ""), subPath: rawSubPath || "sub", subEnable: true };
  }

  // 2. KV cache (5 min TTL)
  const cacheKey = `subcfg:${panel.id}`;
  try {
    const cached = await kvGet(env, cacheKey);
    if (cached && cached.baseUrl) {
      return cached;
    }
  } catch { /* ignore */ }

  // 3. Fetch settings
  try {
    const settings = await panelApi(panel, API_PATHS.SETTINGS_ALL, "POST");
    const obj = settings?.obj || settings;
    const subEnable = obj?.subEnable !== false;
    const subDomain = String(obj?.subDomain || "").trim();
    const subPort = Number(obj?.subPort || 0);
    const settingsSubPath = String(obj?.subPath ?? panel.subPath ?? "sub").replace(/^\/+|\/+$/g, "");
    const subPath = settingsSubPath || "sub";

    // Derive host: subDomain if set, else hostname from panel URL
    let host = subDomain;
    if (!host) {
      try {
        const url = new URL(panel.panelUrl);
        host = url.hostname;
      } catch {
        return null;
      }
    }

    // Determine protocol:
    // - If subCertFile is set → HTTPS (sub server uses TLS)
    // - Else if subPort is 443 → HTTPS
    // - Else → HTTP
    const hasCert = Boolean(obj?.subCertFile);
    const proto = hasCert || subPort === 443 ? "https" : "http";
    const portPart = (subPort === 80 || subPort === 443 || subPort === 0) ? "" : `:${subPort}`;
    const baseUrl = `${proto}://${host}${portPart}`;

    const result = { baseUrl, subPath, subEnable };
    // Cache for 5 minutes
    try { await kvPut(env, cacheKey, result, 5 * 60 * 1000); } catch { /* ignore */ }
    return result;
  } catch {
    return null;
  }
}

/**
 * Build a subscription link, auto-deriving subBaseUrl from panel settings
 * when not explicitly configured. Async version of buildSubLink.
 */
async function buildSubLinkAsync(subId, panel, env) {
  const config = await resolveSubConfig(panel, env);
  if (!config || !config.baseUrl) {
    throw new Error("لینک اشتراک برای این سرور قابل ساخت نیست (subBaseUrl تنظیم نشده و تنظیمات پنل در دسترس نیست)");
  }
  const base = config.baseUrl;
  const subPath = config.subPath;
  const baseLastSegment = base.split("/").filter(Boolean).pop();
  const parts = [base];
  if (subPath && baseLastSegment !== subPath) parts.push(subPath);
  parts.push(String(subId).replace(/^\/+|\/+$/g, ""));
  return parts.join("/");
}

// ─── KV Storage Helpers (BOT_KV) ─────────────────────────────

async function kvGet(env, key) {
  try {
    const value = await env.BOT_KV.get(key);
    return parseJson(value);
  } catch { return null; }
}

async function kvPut(env, key, value, ttlMs) {
  try {
    const opts = {};
    if (ttlMs && ttlMs > 0) opts.expirationTtl = Math.max(60, Math.floor(ttlMs / 1000));
    await env.BOT_KV.put(key, JSON.stringify(value), opts);
  } catch (error) {
    console.error(`KV put error for key ${key}:`, shortError(error));
  }
}

async function kvDelete(env, key) {
  try { await env.BOT_KV.delete(key); } catch (error) {
    console.error(`KV delete error for key ${key}:`, shortError(error));
  }
}

async function kvList(env, prefix) {
  try {
    const list = await env.BOT_KV.list({ prefix });
    return list.keys.map((key) => key.name);
  } catch (error) {
    console.error(`KV list error for prefix ${prefix}:`, shortError(error));
    return [];
  }
}

// ─── KV Storage Helpers (BOT_STATE) ──────────────────────────

async function stateGet(env, key) {
  try {
    const value = await env.BOT_STATE.get(key);
    return parseJson(value);
  } catch { return null; }
}

async function statePut(env, key, value, ttlMs) {
  try {
    const opts = {};
    if (ttlMs && ttlMs > 0) opts.expirationTtl = Math.max(60, Math.floor(ttlMs / 1000));
    await env.BOT_STATE.put(key, JSON.stringify(value), opts);
  } catch (error) {
    console.error(`STATE put error for key ${key}:`, shortError(error));
  }
}

async function stateDelete(env, key) {
  try { await env.BOT_STATE.delete(key); } catch (error) {
    console.error(`STATE delete error for key ${key}:`, shortError(error));
  }
}

// ─── Action Tokens (BOT_STATE) ───────────────────────────────

async function setAction(chatId, action, param, env, panelId) {
  const token = generateToken(8);
  const stateKey = String(chatId);
  const state = (await stateGet(env, stateKey)) || { actions: {} };

  // `param` historically carries the combined "panelId:identifier" string
  // (see makeCallbackData, delete_confirm, reset_traffic_confirm callers).
  // We must store ONLY the identifier portion — otherwise downstream code
  // that reads `actionObj.identifier` ends up calling
  // getClientByIdentifier("US:Pp", ...) instead of getClientByIdentifier("Pp", ...),
  // which fails to find the client (or worse, finds a stray one).
  let identifier = param;
  if (panelId && typeof param === "string" && param.startsWith(panelId + ":")) {
    identifier = param.slice(panelId.length + 1);
  }

  state.actions[token] = {
    action,
    panelId: panelId || "",
    identifier,
    createdAt: Date.now(),
  };
  // Clean old actions
  const now = Date.now();
  for (const [k, v] of Object.entries(state.actions)) {
    if (now - (v.createdAt || 0) > ACTION_TTL_MS) delete state.actions[k];
  }
  await statePut(env, stateKey, state, ACTION_TTL_MS);
  return token;
}

async function getAction(chatId, token, env) {
  const stateKey = String(chatId);
  const state = await stateGet(env, stateKey);
  if (!state || !state.actions || !state.actions[token]) return null;
  return state.actions[token];
}

async function deleteAction(chatId, token, env) {
  const stateKey = String(chatId);
  const state = await stateGet(env, stateKey);
  if (!state || !state.actions) return;
  delete state.actions[token];
  await statePut(env, stateKey, state, ACTION_TTL_MS);
}

async function makeCallbackData(chatId, action, panel, identifier, env) {
  const raw = `${panel.id}:${identifier}`;
  const direct = safeCallbackData(action, raw);
  if (direct) return direct;
  const token = await setAction(chatId, action, raw, env, panel.id);
  return `act:${token}`;
}

async function resolveCallbackData(chatId, data, env) {
  if (data.startsWith("act:")) {
    const token = data.slice(4);
    const actionObj = await getAction(chatId, token, env);
    if (!actionObj) return null;
    return actionObj;
  }
  const { action, param } = splitCallbackData(data);
  const parts = param.split(":");
  return {
    action,
    panelId: parts[0] || "",
    identifier: parts.slice(1).join(":"),
    token: null,
  };
}

// ─── User Management (KV) ────────────────────────────────────

async function registerUser(env, chatId, clientEmail, panelId, createdBy) {
  const key = `${KV_USERS_PREFIX}${chatId}`;
  const user = {
    chatId: String(chatId),
    clientEmail: normalizeIdentifier(clientEmail),
    panelId: String(panelId),
    registeredAt: Date.now(),
    language: "fa",
    notificationsEnabled: true,
    createdBy: createdBy || null,
  };
  await kvPut(env, key, user);
  return user;
}

async function getUser(env, chatId) {
  return await kvGet(env, `${KV_USERS_PREFIX}${chatId}`);
}

async function deleteUser(env, chatId) {
  // Cascade cleanup — wipe ALL data related to this chatId so the user
  // is truly gone and no orphan state can come back to bite us later.
  // Order matters: backup first (so we can't accidentally lose it mid-cleanup),
  // then indexes, then per-state keys.
  try { await deleteUserBackup(env, chatId); } catch (e) { console.error("deleteUser: backup cleanup failed:", shortError(e)); }

  // User record itself
  try { await kvDelete(env, `${KV_USERS_PREFIX}${chatId}`); } catch (e) { console.error("deleteUser: user record cleanup failed:", shortError(e)); }

  // Banned / suspended state (if any)
  try { await kvDelete(env, `${KV_BANNED_PREFIX}${chatId}`); } catch {}
  try { await kvDelete(env, `${KV_SUSPENDED_PREFIX}${chatId}`); } catch {}

  // Admin role (in case the deleted account was an admin)
  try { await removePanelAdmin(env, chatId); } catch {}

  // Renewal / alert records that reference this chatId
  try { await kvDelete(env, `${KV_RENEWAL_PREFIX}${chatId}`); } catch {}
  try { await kvDelete(env, `${KV_ALERT_PREFIX}${chatId}`); } catch {}

  // FSM / conversation state — same list as the `admin_back` handler
  const stateKeys = [
    `${STATE_REG_PREFIX}${chatId}`,
    `${STATE_ADDPANEL_PREFIX}${chatId}`,
    `${STATE_RENEW_PREFIX}${chatId}`,
    `addgb_action:${chatId}`,
    `renew_action:${chatId}`,
    `search_action:${chatId}`,
    `create_action:${chatId}`,
    `xray_update_action:${chatId}`,
    `ban_action:${chatId}`,
    `ban_reason:${chatId}`,
    `suspend_action:${chatId}`,
    `suspend_min:${chatId}`,
    `suspend_reason:${chatId}`,
    `addadmin_action:${chatId}`,
    `node_add_action:${chatId}`,
    `cf_add_action:${chatId}`,
    `stars_add_action:${chatId}`,
    `ssh_action:${chatId}`,
  ];
  for (const key of stateKeys) {
    try { await stateDelete(env, key); } catch {}
  }
}

async function findUserByEmail(env, clientEmail, panelId) {
  const keys = await kvList(env, KV_USERS_PREFIX);
  const email = normalizeIdentifier(clientEmail);
  for (const key of keys) {
    const user = await kvGet(env, key);
    if (user && sameIdentifier(user.clientEmail, email) && (!panelId || user.panelId === panelId)) {
      return user;
    }
  }
  return null;
}

async function getAllUsers(env) {
  const keys = await kvList(env, KV_USERS_PREFIX);
  const users = [];
  for (const key of keys) {
    const user = await kvGet(env, key);
    if (user) users.push(user);
  }
  return users;
}

// ─── User Backup (for disaster recovery) ──────────────────────

const KV_USER_BACKUP_PREFIX = "userbackup:";
const KV_USER_BACKUPS_LIST = "userbackups:list";

async function updateUserBackup(env, chatId, clientData, panel) {
  const now = Date.now();
  const backup = {
    chatId: String(chatId),
    clientEmail: clientData.email || clientData.clientEmail || "",
    panelId: panel?.id || clientData.panelId || "",
    panelName: panel?.name || "",
    panelUrl: panel?.panelUrl || "",
    totalGB: clientData.totalGB ?? null,
    usedGB: clientData.usedGB ?? 0,
    remainingGB: clientData.remainingGB ?? null,
    uploadGB: clientData.uploadGB ?? 0,
    downloadGB: clientData.downloadGB ?? 0,
    expiryTime: clientData.expiryTime ?? null,
    daysRemaining: clientData.expiryTime ? Math.max(0, Math.ceil((clientData.expiryTime - now) / MS_PER_DAY)) : null,
    enabled: clientData.enabled ?? true,
    registeredAt: clientData.registeredAt || now,
    lastUpdated: now,
  };
  await kvPut(env, `${KV_USER_BACKUP_PREFIX}${chatId}`, backup);

  // Update the list of all backups
  const list = (await kvGet(env, KV_USER_BACKUPS_LIST)) || [];
  if (!list.includes(String(chatId))) {
    list.push(String(chatId));
    await kvPut(env, KV_USER_BACKUPS_LIST, list);
  }
  return backup;
}

async function getUserBackup(env, chatId) {
  return await kvGet(env, `${KV_USER_BACKUP_PREFIX}${chatId}`);
}

async function getAllUserBackups(env) {
  const list = (await kvGet(env, KV_USER_BACKUPS_LIST)) || [];
  const backups = [];
  for (const chatId of list) {
    const backup = await kvGet(env, `${KV_USER_BACKUP_PREFIX}${chatId}`);
    if (backup) backups.push(backup);
  }
  return backups;
}

async function deleteUserBackup(env, chatId) {
  await kvDelete(env, `${KV_USER_BACKUP_PREFIX}${chatId}`);
  const list = (await kvGet(env, KV_USER_BACKUPS_LIST)) || [];
  const newList = list.filter((id) => String(id) !== String(chatId));
  await kvPut(env, KV_USER_BACKUPS_LIST, newList);
}

function formatUserBackup(backup) {
  if (!backup) return "❌ اطلاعات پشتیبان یافت نشد.";
  const lines = [
    `📋 اطلاعات پشتیبان کاربر`,
    ``,
    `🔹 شناسه: ${backup.clientEmail || "نامشخص"}`,
    `🖥 سرور: ${backup.panelName || "نامشخص"}`,
    ``,
    `📦 حجم کل: ${backup.totalGB !== null ? backup.totalGB.toFixed(2) + " GB" : "نامحدود"}`,
    `📊 مصرف شده: ${(backup.usedGB || 0).toFixed(2)} GB`,
    `💾 باقیمانده: ${backup.remainingGB !== null ? backup.remainingGB.toFixed(2) + " GB" : "نامحدود"}`,
    ``,
    `📅 تاریخ انقضا: ${backup.expiryTime ? formatDate(backup.expiryTime) : "نامحدود"}`,
    `⏳ روزهای باقیمانده: ${backup.daysRemaining !== null ? backup.daysRemaining + " روز" : "نامحدود"}`,
    ``,
    `🕐 آخرین بروزرسانی: ${new Date(backup.lastUpdated).toLocaleString("fa-IR")}`,
    `${backup.enabled ? "🟢 فعال" : "⛔ غیرفعال"}`,
  ];
  return lines.join("\n");
}

// ─── Renewal Request Management (KV) ─────────────────────────

async function createRenewalRequest(env, chatId, clientEmail, panelId, days, gb) {
  const id = generateToken(12);
  const request = {
    id,
    chatId: String(chatId),
    clientEmail: normalizeIdentifier(clientEmail),
    panelId: String(panelId),
    requestType: days && gb ? "both" : days ? "days" : "gb",
    daysRequested: Number(days) || 0,
    gbRequested: Number(gb) || 0,
    status: "pending",
    createdAt: Date.now(),
    resolvedAt: null,
  };
  await kvPut(env, `${KV_RENEWAL_PREFIX}${id}`, request);
  return request;
}

async function getRenewalRequest(env, requestId) {
  return await kvGet(env, `${KV_RENEWAL_PREFIX}${requestId}`);
}

async function updateRenewalStatus(env, requestId, status) {
  const key = `${KV_RENEWAL_PREFIX}${requestId}`;
  const request = await kvGet(env, key);
  if (!request) return null;
  request.status = status;
  request.resolvedAt = Date.now();
  await kvPut(env, key, request);
  return request;
}

async function getPendingRenewals(env) {
  const keys = await kvList(env, KV_RENEWAL_PREFIX);
  const pending = [];
  for (const key of keys) {
    const request = await kvGet(env, key);
    if (request && request.status === "pending") pending.push(request);
  }
  return pending;
}

// ─── Panel Configuration (KV + Env) ──────────────────────────

function parsePanelsConfigFromEnv(env) {
  const raw = env?.PANELS_JSON;
  if (raw) {
    const parsed = parseJson(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        botToken: parsed.botToken || parsed.BOT_TOKEN || "",
        adminChatIds: normalizeIdList(parsed.adminChatIds ?? parsed.ADMIN_CHAT_IDS),
        alertChatIds: normalizeIdList(parsed.alertChatIds ?? parsed.ALERT_CHAT_IDS),
        alertCooldownMinutes: firstPositiveNumber(parsed.alertCooldownMinutes, parsed.ALERT_COOLDOWN_MINUTES),
        cpuRamAlertThreshold: firstPositiveNumber(parsed.cpuRamAlertThreshold, parsed.CPU_RAM_ALERT_THRESHOLD),
        dailyReportEnabled: parsed.dailyReportEnabled ?? parsed.DAILY_REPORT_ENABLED,
        backupIntervalHours: firstPositiveNumber(parsed.backupIntervalHours, parsed.BACKUP_INTERVAL_HOURS),
        panelsRaw: parsed.panels || parsed.servers || [],
      };
    }
    if (Array.isArray(parsed)) {
      return {
        botToken: "", adminChatIds: [], alertChatIds: [],
        alertCooldownMinutes: null, cpuRamAlertThreshold: null,
        dailyReportEnabled: undefined, backupIntervalHours: null,
        panelsRaw: parsed,
      };
    }
  }
  return {
    botToken: env?.BOT_TOKEN || env?.TELEGRAM_BOT_TOKEN || "",
    adminChatIds: normalizeIdList(env?.ADMIN_CHAT_IDS),
    alertChatIds: normalizeIdList(env?.ALERT_CHAT_IDS),
    alertCooldownMinutes: firstPositiveNumber(env?.ALERT_COOLDOWN_MINUTES),
    cpuRamAlertThreshold: firstPositiveNumber(env?.CPU_RAM_ALERT_THRESHOLD),
    dailyReportEnabled: env?.DAILY_REPORT_ENABLED,
    backupIntervalHours: firstPositiveNumber(env?.BACKUP_INTERVAL_HOURS),
    panelsRaw: [],
  };
}

function buildPanelObject(item, index, env) {
  const name = String(item.name || item.server || item.title || `Server ${index + 1}`);
  const panelUrl = item.panelUrl || item.url || item.host;
  const apiToken = item.apiToken || item.token;
  if (!panelUrl || !apiToken) throw new Error(`Panel "${name}" missing panelUrl or apiToken`);
  return {
    id: String(item.id || slugify(name) || `p${index + 1}`),
    name,
    panelUrl: trimUrl(panelUrl),
    apiPrefix: normalizeApiPrefix(item.apiPrefix ?? env?.PANEL_API_PREFIX ?? ""),
    apiToken: String(apiToken),
    inboundIds: parseInboundIds(item.inboundIds ?? item.INBOUND_IDS),
    subBaseUrl: item.subBaseUrl || "",
    subPath: item.subPath ?? "sub",
    adminChatIds: normalizeIdList(item.adminChatIds ?? item.ADMIN_CHAT_IDS),
    alertChatIds: normalizeIdList(item.alertChatIds ?? item.ALERT_CHAT_IDS),
    alertCooldownMinutes: firstPositiveNumber(item.alertCooldownMinutes, item.ALERT_COOLDOWN_MINUTES),
    cpuRamAlertThreshold: firstPositiveNumber(item.cpuRamAlertThreshold, item.CPU_RAM_ALERT_THRESHOLD),
    authType: item.authType || "bearer",
    authHeader: item.authHeader || "",
    sshBridgeUrl: item.sshBridgeUrl || "",
    sshBridgeToken: item.sshBridgeToken || "",
    sshHost: item.sshHost || "",
    sshPort: item.sshPort || 22,
    sshUsername: item.sshUsername || "root",
    sshPassword: item.sshPassword || "",
    sshPrivateKey: item.sshPrivateKey || "",
    sshPassphrase: item.sshPassphrase || "",
    botToken: item.botToken || "",
    apiDebug: item.apiDebug ?? item.API_DEBUG ?? env?.API_DEBUG ?? "",
  };
}

async function getPanels(env) {
  // First try KV (dynamic panels added via bot)
  try {
    const kvPanels = await kvGet(env, KV_PANELS_KEY);
    if (kvPanels && Array.isArray(kvPanels) && kvPanels.length) {
      return kvPanels.map((item, i) => buildPanelObject(item, i, env));
    }
  } catch { /* ignore */ }

  // Fallback to env config
  const config = parsePanelsConfigFromEnv(env);
  const panels = [];
  if (config.panelsRaw.length) {
    config.panelsRaw.forEach((item, index) => {
      panels.push(buildPanelObject(item, index, env));
    });
  }

  // Legacy single-panel env vars
  const panelUrl = env?.PANEL_URL;
  const apiToken = env?.API_TOKEN;
  if (panelUrl && apiToken) {
    const legacyPanel = {
      id: String(env.PANEL_ID || "default"),
      name: String(env.PANEL_NAME || "پنل اصلی"),
      panelUrl: trimUrl(panelUrl),
      apiPrefix: normalizeApiPrefix(env.PANEL_API_PREFIX ?? ""),
      apiToken: String(apiToken),
      inboundIds: parseInboundIds(env.INBOUND_IDS),
      subBaseUrl: env.SUB_BASE_URL || "",
      subPath: env.SUB_PATH ?? "sub",
      adminChatIds: normalizeIdList(env.ADMIN_CHAT_IDS),
      alertChatIds: normalizeIdList(env.ALERT_CHAT_IDS),
      alertCooldownMinutes: firstPositiveNumber(env.ALERT_COOLDOWN_MINUTES),
      cpuRamAlertThreshold: firstPositiveNumber(env.CPU_RAM_ALERT_THRESHOLD),
      authType: env.API_AUTH_TYPE || "bearer",
      authHeader: env.API_AUTH_HEADER || "",
      sshBridgeUrl: env.SSH_BRIDGE_URL || "",
      sshBridgeToken: env.SSH_BRIDGE_TOKEN || "",
      sshHost: env.SSH_HOST || "",
      sshPort: Number(env.SSH_PORT) || 22,
      sshUsername: env.SSH_USERNAME || "root",
      sshPassword: env.SSH_PASSWORD || "",
      sshPrivateKey: env.SSH_PRIVATE_KEY || "",
      sshPassphrase: env.SSH_PASSPHRASE || "",
      botToken: env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "",
      apiDebug: env.API_DEBUG || "",
    };
    if (!panels.some((p) => p.id === legacyPanel.id || p.panelUrl === legacyPanel.panelUrl)) {
      panels.push(legacyPanel);
    }
  }

  if (!panels.length) throw new Error("No panel configured");
  return panels;
}

async function savePanelsToKV(env, panelsRaw) {
  await kvPut(env, KV_PANELS_KEY, panelsRaw);
}

async function addPanel(env, panelConfig) {
  const current = (await kvGet(env, KV_PANELS_KEY)) || [];
  current.push(panelConfig);
  await savePanelsToKV(env, current);
}

async function removePanel(env, panelId) {
  const current = (await kvGet(env, KV_PANELS_KEY)) || [];
  const filtered = current.filter((p) => (p.id || slugify(p.name || "")) !== panelId);
  await savePanelsToKV(env, filtered);
}

async function updatePanelKV(env, panelId, updates) {
  const current = (await kvGet(env, KV_PANELS_KEY)) || [];
  const index = current.findIndex((p) => (p.id || slugify(p.name || "")) === panelId);
  if (index === -1) throw new Error("Panel not found");
  current[index] = { ...current[index], ...updates };
  await savePanelsToKV(env, current);
}

async function resolvePanelAsync(env, ref) {
  const panels = await getPanels(env);
  if (!ref) return panels.length === 1 ? panels[0] : null;
  const value = String(ref).trim();
  return (
    panels.find((p) => p.id === value) ||
    panels.find((p) => slugify(p.name) === slugify(value)) ||
    panels.find((p) => p.name.toLocaleLowerCase() === value.toLocaleLowerCase()) ||
    panels.find((_, i) => String(i + 1) === value) ||
    null
  );
}

function getBotToken(env) {
  const config = parsePanelsConfigFromEnv(env);
  const token = config.botToken || env?.BOT_TOKEN || env?.TELEGRAM_BOT_TOKEN || "";
  if (!token) throw new Error("Telegram bot token is not configured");
  return String(token);
}

function getGlobalAdminIds(env) {
  return parsePanelsConfigFromEnv(env).adminChatIds;
}

// ─── Admin Detection (Async) ─────────────────────────────────

async function isAdminAsync(chatId, env) {
  const id = String(chatId);

  // 1. Check env-level admin IDs
  const envAdmins = getGlobalAdminIds(env);
  if (envAdmins.includes(id)) return true;

  // 2. Check adminChatIds from panels in PANELS_JSON env
  const config = parsePanelsConfigFromEnv(env);
  if (Array.isArray(config.panelsRaw)) {
    for (const panel of config.panelsRaw) {
      for (const adminId of normalizeIdList(panel.adminChatIds)) {
        if (String(adminId) === id) return true;
      }
    }
  }

  // 3. Check KV-stored admin list
  try {
    const kvAdmins = await kvGet(env, KV_ADMIN_IDS_KEY);
    if (Array.isArray(kvAdmins) && kvAdmins.includes(id)) return true;
  } catch { /* ignore */ }

  // 4. Check KV-stored panels for adminChatIds
  try {
    const kvPanels = await kvGet(env, KV_PANELS_KEY);
    if (Array.isArray(kvPanels)) {
      for (const panel of kvPanels) {
        for (const adminId of normalizeIdList(panel.adminChatIds ?? panel.ADMIN_CHAT_IDS)) {
          if (String(adminId) === id) return true;
        }
      }
    }
  } catch { /* ignore */ }

  return false;
}

async function getAllAdminIdsAsync(env) {
  const ids = new Set(getGlobalAdminIds(env));

  const config = parsePanelsConfigFromEnv(env);
  if (Array.isArray(config.panelsRaw)) {
    for (const panel of config.panelsRaw) {
      for (const id of normalizeIdList(panel.adminChatIds)) ids.add(String(id));
    }
  }

  try {
    const kvAdmins = await kvGet(env, KV_ADMIN_IDS_KEY);
    if (Array.isArray(kvAdmins)) for (const id of kvAdmins) ids.add(String(id));
  } catch { /* ignore */ }

  try {
    const kvPanels = await kvGet(env, KV_PANELS_KEY);
    if (Array.isArray(kvPanels)) {
      for (const panel of kvPanels) {
        for (const id of normalizeIdList(panel.adminChatIds ?? panel.ADMIN_CHAT_IDS)) ids.add(String(id));
      }
    }
  } catch { /* ignore */ }

  return [...ids];
}

async function addAdminId(env, chatId) {
  const current = (await kvGet(env, KV_ADMIN_IDS_KEY)) || [];
  const id = String(chatId);
  if (!current.includes(id)) {
    current.push(id);
    await kvPut(env, KV_ADMIN_IDS_KEY, current);
  }
}

async function removeAdminId(env, chatId) {
  const current = (await kvGet(env, KV_ADMIN_IDS_KEY)) || [];
  const id = String(chatId);
  const filtered = current.filter((x) => x !== id);
  await kvPut(env, KV_ADMIN_IDS_KEY, filtered);
}
// ─── Admin Role System ────────────────────────────────────────

async function getAdminRole(env, chatId) {
  const id = String(chatId);
  const envAdmins = getGlobalAdminIds(env);
  if (envAdmins.includes(id)) return { role: "super", panelIds: [], maxUsers: 0 };
  try {
    const role = await kvGet(env, `${KV_ADMIN_ROLE_PREFIX}${id}`);
    if (role) return role;
  } catch {}
  try {
    const kvAdmins = await kvGet(env, KV_ADMIN_IDS_KEY);
    if (Array.isArray(kvAdmins) && kvAdmins.includes(id)) return { role: "super", panelIds: [], maxUsers: 0 };
  } catch {}
  return null;
}

async function isSuperAdmin(env, chatId) {
  // Env-configured admins (ADMIN_CHAT_IDS, panel adminChatIds) are always super.
  const envAdmins = getGlobalAdminIds(env);
  if (envAdmins.includes(String(chatId))) return true;

  const config = parsePanelsConfigFromEnv(env);
  if (Array.isArray(config.panelsRaw)) {
    for (const panel of config.panelsRaw) {
      for (const adminId of normalizeIdList(panel.adminChatIds)) {
        if (String(adminId) === String(chatId)) return true;
      }
    }
  }

  // KV-stored role: only "admin" role is non-super. No role = super (default).
  const role = await getAdminRole(env, chatId);
  if (!role) return true; // no role stored → treat as super (env admin or first-time admin)
  return role.role === "super";
}

/**
 * Reject panel admins (non-super admins) from performing super-admin-only
 * actions. Returns true if the action should be blocked (already answered
 * the callback and sent a denial message); false if access is allowed.
 *
 * Usage in callback handlers:
 *   if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
 */
async function rejectIfNotSuper(chatId, callbackQueryId, env) {
  const isSuper = await isSuperAdmin(env, chatId);
  if (!isSuper) {
    try { await answerCallbackQuery(callbackQueryId, env, "⛔ فقط سوپر ادمین"); } catch { /* ignore */ }
    try {
      await sendTelegram(chatId, "⛔ این گزینه فقط برای سوپر ادمین قابل دسترسی است.", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
    } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Same as rejectIfNotSuper but for command handlers (no callback query).
 * Returns true if blocked.
 *
 * Usage in command handlers:
 *   if (await rejectCommandIfNotSuper(chatId, env)) return;
 */
async function rejectCommandIfNotSuper(chatId, env) {
  const isSuper = await isSuperAdmin(env, chatId);
  if (!isSuper) {
    await sendTelegram(chatId, "⛔ این دستور فقط برای سوپر ادمین قابل دسترسی است.", env,
      [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]
    );
    return true;
  }
  return false;
}

/**
 * Smart back button — returns the appropriate "back" callback_data based on
 * the user's role and context:
 * - Super admin with CF token → "admin_back" (which goes to choice menu)
 * - Super admin without CF token → "admin_back" (goes to admin menu)
 * - Panel admin → "admin_back" (goes to limited admin menu)
 * - Regular user → "user_back"
 *
 * Usage:
 *   const back = await smartBackButton(chatId, env);
 *   await sendTelegram(chatId, msg, env, [[{ text: "🔙 منوی اصلی", callback_data: back }]]);
 */
async function smartBackButton(chatId, env) {
  const admin = await isAdminAsync(chatId, env);
  if (admin) return "admin_back";
  return "user_back";
}

/**
 * Send a Telegram message WITH a back button. Drops in for the common pattern
 * of `await sendTelegram(chatId, msg, env);` — adds a smart back button so
 * the user is never stranded on a text-only message.
 *
 * Usage:
 *   await sendTelegramWithBack(chatId, msg, env);
 *   await sendTelegramWithBack(chatId, msg, env, "cf_back");  // override back target
 */
async function sendTelegramWithBack(chatId, text, env, backOverride = null) {
  const back = backOverride || await smartBackButton(chatId, env);
  await sendTelegram(chatId, text, env, [[{ text: "🔙 منوی اصلی", callback_data: back }]]);
}

async function getAdminPanelIds(env, chatId) {
  const role = await getAdminRole(env, chatId);
  if (!role) return [];
  if (role.role === "super") { const p = await getPanels(env); return p.map(x=>x.id); }
  return role.panelIds || [];
}

async function getAdminCreatedCount(env, chatId) {
  try {
    const panels = await getPanels(env);
    const myMarker = `TG:${String(chatId)}`;
    let count = 0;
    for (const panel of panels) {
      try {
        const clients = await listAllClients(panel);
        for (const c of clients) {
          const comment = String(c?.comment || "").trim();
          if (comment === myMarker || comment.startsWith(myMarker + " ")) count++;
        }
      } catch { /* ignore panel errors */ }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Get total traffic used by all clients an admin created (in GB).
 * Used for maxTrafficGB limit enforcement.
 */
async function getAdminCreatedTrafficGB(env, chatId) {
  try {
    const panels = await getPanels(env);
    const myMarker = `TG:${String(chatId)}`;
    let totalBytes = 0;
    for (const panel of panels) {
      try {
        const clients = await listAllClients(panel);
        for (const c of clients) {
          const comment = String(c?.comment || "").trim();
          if (comment === myMarker || comment.startsWith(myMarker + " ")) {
            const t = getClientTraffic(c);
            totalBytes += t.up + t.down;
          }
        }
      } catch { /* ignore panel errors */ }
    }
    return totalBytes / BYTES_PER_GB;
  } catch {
    return 0;
  }
}

async function addPanelAdmin(env, chatId, panelIds, maxUsers, maxTrafficGB) {
  const id = String(chatId);
  await kvPut(env, `${KV_ADMIN_ROLE_PREFIX}${id}`, {
    role: "admin",
    panelIds: panelIds||[],
    maxUsers: maxUsers||0,
    maxTrafficGB: maxTrafficGB||0,  // 0 = unlimited
    createdAt: Date.now()
  });
  await addAdminId(env, id);
}

async function setSuperAdmin(env, chatId) {
  const id = String(chatId);
  await kvPut(env, `${KV_ADMIN_ROLE_PREFIX}${id}`, { role: "super", panelIds: [], maxUsers: 0, createdAt: Date.now() });
  await addAdminId(env, id);
}

async function removePanelAdmin(env, chatId) {
  await kvDelete(env, `${KV_ADMIN_ROLE_PREFIX}${String(chatId)}`);
  await removeAdminId(env, chatId);
}

async function getAllAdminsWithRoles(env) {
  const ids = await getAllAdminIdsAsync(env);
  const result = [];
  for (const id of ids) {
    const role = await getAdminRole(env, id);
    const cnt = await getAdminCreatedCount(env, id);
    const trafficGB = await getAdminCreatedTrafficGB(env, id);
    result.push({
      chatId: id,
      role: role?.role||"super",
      panelIds: role?.panelIds||[],
      maxUsers: role?.maxUsers||0,
      maxTrafficGB: role?.maxTrafficGB||0,
      createdCount: cnt,
      usedTrafficGB: trafficGB,
    });
  }
  return result;
}

async function getSuperAdminIds(env) {
  const ids = await getAllAdminIdsAsync(env);
  const supers = [];
  for (const id of ids) { const r = await getAdminRole(env, id); if (!r || r.role === "super") supers.push(id); }
  return supers;
}

// ─── Ban/Suspend System ───────────────────────────────────────

async function banUser(env, chatId, reason = "") {
  await kvPut(env, `${KV_BANNED_PREFIX}${chatId}`, { chatId: String(chatId), reason, bannedAt: Date.now() });
  const list = (await kvGet(env, KV_BANNED_LIST)) || [];
  if (!list.includes(String(chatId))) { list.push(String(chatId)); await kvPut(env, KV_BANNED_LIST, list); }
}
async function unbanUser(env, chatId) {
  await kvDelete(env, `${KV_BANNED_PREFIX}${chatId}`);
  const list = (await kvGet(env, KV_BANNED_LIST)) || [];
  await kvPut(env, KV_BANNED_LIST, list.filter(id => String(id) !== String(chatId)));
}
async function isUserBanned(env, chatId) { return await kvGet(env, `${KV_BANNED_PREFIX}${chatId}`); }
async function getBannedUsers(env) {
  const list = (await kvGet(env, KV_BANNED_LIST)) || [];
  const r = []; for (const id of list) { const b = await kvGet(env, `${KV_BANNED_PREFIX}${id}`); if (b) r.push(b); } return r;
}
async function suspendUser(env, chatId, mins, reason = "") {
  await kvPut(env, `${KV_SUSPENDED_PREFIX}${chatId}`, { chatId: String(chatId), reason, until: Date.now()+mins*60000, suspendedAt: Date.now() }, mins*60000);
}
async function unsuspendUser(env, chatId) { await kvDelete(env, `${KV_SUSPENDED_PREFIX}${chatId}`); }
async function isUserSuspended(env, chatId) {
  const s = await kvGet(env, `${KV_SUSPENDED_PREFIX}${chatId}`);
  if (!s) return null;
  if (s.until && s.until < Date.now()) { await kvDelete(env, `${KV_SUSPENDED_PREFIX}${chatId}`); return null; }
  return s;
}

// ─── Error Logging (KV) ───────────────────────────────────────

async function logError(env, action, error, context = {}) {
  const errorMsg = shortError(error);
  console.error(`[BOT_ERROR] action=${action} error=${errorMsg}`);
  try {
    if (!env || !env.BOT_KV) return;
    const id = generateToken(8);
    const ts = Date.now();
    await env.BOT_KV.put(`${KV_ERROR_LOG_PREFIX}${id}`, JSON.stringify({ id, timestamp: ts, time: new Date(ts).toLocaleString("fa-IR"), action, error: errorMsg, context: JSON.stringify(context).slice(0, 500) }));
    let list = [];
    try { const raw = await env.BOT_KV.get(KV_ERROR_LOG_LIST); if (raw) { list = JSON.parse(raw); if (!Array.isArray(list)) list = []; } } catch {}
    list.unshift(id);
    if (list.length > MAX_ERRORS_STORED) { for (const oldId of list.slice(MAX_ERRORS_STORED)) { try { await env.BOT_KV.delete(`${KV_ERROR_LOG_PREFIX}${oldId}`); } catch {} } list.length = MAX_ERRORS_STORED; }
    await env.BOT_KV.put(KV_ERROR_LOG_LIST, JSON.stringify(list));
  } catch (e) { console.error("[BOT_ERROR] logError failed:", shortError(e)); }
}

async function getErrorLogs(env, limit = 20) {
  if (!env || !env.BOT_KV) return [];
  try {
    const raw = await env.BOT_KV.get(KV_ERROR_LOG_LIST);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const errors = [];
    for (const id of list.slice(0, limit)) {
      try { const er = await env.BOT_KV.get(`${KV_ERROR_LOG_PREFIX}${id}`); if (er) { const e = JSON.parse(er); if (e) errors.push(e); } } catch {}
    }
    return errors;
  } catch { return []; }
}

async function clearErrorLogs(env) {
  if (!env || !env.BOT_KV) return;
  try {
    const raw = await env.BOT_KV.get(KV_ERROR_LOG_LIST);
    if (raw) { const list = JSON.parse(raw); if (Array.isArray(list)) { for (const id of list) { try { await env.BOT_KV.delete(`${KV_ERROR_LOG_PREFIX}${id}`); } catch {} } } }
    await env.BOT_KV.delete(KV_ERROR_LOG_LIST);
  } catch {}
}
// ─── Telegram API ─────────────────────────────────────────────

async function sendTelegram(chatId, text, env, buttons = null, parseMode = null) {
  const token = getBotToken(env);
  const payload = {
    chat_id: String(chatId),
    text: String(text ?? "").slice(0, 4000),
  };
  if (parseMode) payload.parse_mode = parseMode;
  if (buttons) payload.reply_markup = JSON.stringify({ inline_keyboard: buttons });
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return assertOk(response, "Telegram sendMessage");
}

// Get support username from env
function getSupportUsername(env) {
  const username = String(env?.SUPPORT_USERNAME || env?.SUPPORT_ID || "").trim();
  return username.replace(/^@/, "");
}

async function editMessage(chatId, messageId, text, env, buttons = null) {
  const token = getBotToken(env);
  const payload = {
    chat_id: String(chatId),
    message_id: messageId,
    text: String(text ?? "").slice(0, 4000),
  };
  if (buttons) payload.reply_markup = JSON.stringify({ inline_keyboard: buttons });
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* ignore */ }
}

async function sendDocument(chatId, fileUrl, caption, env, buttons = null) {
  const token = getBotToken(env);
  const payload = {
    chat_id: String(chatId),
    document: fileUrl,
    caption: String(caption || "").slice(0, 1024),
  };
  if (buttons) payload.reply_markup = JSON.stringify({ inline_keyboard: buttons });
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return assertOk(response, "Telegram sendDocument");
}

async function sendDocumentBuffer(chatId, buffer, filename, caption, env, buttons = null) {
  const token = getBotToken(env);
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("document", new Blob([buffer]), filename);
  if (caption) formData.append("caption", String(caption).slice(0, 1024));
  if (buttons) formData.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  return assertOk(response, "Telegram sendDocument");
}

async function sendPhoto(chatId, photoUrl, caption, env, buttons = null) {
  const token = getBotToken(env);
  const payload = {
    chat_id: String(chatId),
    photo: photoUrl,
    caption: String(caption || "").slice(0, 1024),
  };
  if (buttons) payload.reply_markup = JSON.stringify({ inline_keyboard: buttons });
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return assertOk(response, "Telegram sendPhoto");
}

async function answerCallbackQuery(callbackQueryId, env, text = "") {
  const token = getBotToken(env);
  const payload = {
    callback_query_id: String(callbackQueryId),
    text: String(text || "").slice(0, 200),
  };
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function deleteMessage(chatId, messageId, env) {
  const token = getBotToken(env);
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: String(chatId), message_id: messageId }),
  });
}

// ─── Panel API ────────────────────────────────────────────────

/**
 * @param {any} panel
 * @returns {Record<string, string>}
 */
function buildAuthHeaders(panel) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (panel.authHeader) {
    headers.Authorization = panel.authHeader;
  } else if ((panel.authType || "bearer").toLowerCase() === "x-api-token") {
    headers["X-API-Token"] = panel.apiToken;
  } else if ((panel.authType || "bearer").toLowerCase() === "cookie") {
    headers.Cookie = panel.apiToken;
  } else {
    headers.Authorization = `Bearer ${panel.apiToken}`;
  }
  return headers;
}

function buildApiUrlCandidates(panel, path) {
  const panelUrl = trimUrl(panel.panelUrl || "");
  const apiPrefix = normalizeApiPrefix(panel.apiPrefix ?? "");
  const cleanPath = String(path || "").replace(/^\/+|\/+$/g, "");
  const candidates = [];

  const pathWithoutPanel = cleanPath.startsWith("panel/api/")
    ? cleanPath.replace(/^panel\/api\//, "api/")
    : cleanPath;
  const apiPrefixWithoutPanel = apiPrefix.replace(/\/panel$/, "");

  candidates.push(joinUrl(panelUrl, apiPrefix, cleanPath));
  candidates.push(joinUrl(panelUrl, cleanPath));

  if (pathWithoutPanel !== cleanPath) {
    candidates.push(joinUrl(panelUrl, apiPrefix, pathWithoutPanel));
    candidates.push(joinUrl(panelUrl, pathWithoutPanel));
    if (apiPrefixWithoutPanel !== apiPrefix) {
      candidates.push(joinUrl(panelUrl, apiPrefixWithoutPanel, pathWithoutPanel));
    }
  }

  if (apiPrefixWithoutPanel !== apiPrefix) {
    candidates.push(joinUrl(panelUrl, apiPrefixWithoutPanel, cleanPath));
  }

  // Legacy 1.x API path
  if (cleanPath.includes("inbounds/list")) {
    candidates.push(joinUrl(panelUrl, "xui", "API", "inbounds", "list"));
  }

  return [...new Set(candidates)];
}

async function panelApi(panel, path, method, body = null) {
  const methodUpper = String(method || "GET").toUpperCase();
  const debug = String(panel.apiDebug || "").toLowerCase() === "true";

  try {
    return await panelApiOnce(panel, path, methodUpper, body, debug);
  } catch (error) {
    // Defensive method-swap fallback: if the original method returns
    // 404 (route not found) or 405 (method not allowed), retry with
    // the opposite HTTP method (GET↔POST). Different 3x-ui versions
    // register some endpoints with different methods (e.g. /server/getLogs
    // is POST in newer versions, GET in some older forks). The swap
    // gracefully handles these version differences.
    const msg = String(error?.message || error || "");
    const isMethodIssue = msg.includes("404") || msg.includes("405") ||
                          msg.includes("Not Found") || msg.includes("Method Not Allowed");
    if (isMethodIssue && methodUpper !== (methodUpper === "GET" ? "POST" : "GET")) {
      const swapped = methodUpper === "GET" ? "POST" : "GET";
      if (debug) console.error(`[API METHOD SWAP] ${panel.name} ${methodUpper}→${swapped} ${path}`);
      return await panelApiOnce(panel, path, swapped, body, debug);
    }
    throw error;
  }
}

async function panelApiOnce(panel, path, methodUpper, body, debug) {
  const headers = buildAuthHeaders(panel);

  if (body !== null || methodUpper === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const candidates = buildApiUrlCandidates(panel, path);
  let lastError = null;

  for (const url of candidates) {
    /** @type {RequestInit} */
    const options = { method: methodUpper, headers };
    if (body !== null) options.body = JSON.stringify(body);

    if (debug) console.error(`[API TRY] ${panel.name} ${methodUpper} ${url}`);

    try {
      const response = await fetch(url, options);
      const text = await response.text();
      const data = parseJson(text);

      if (debug) console.error(`[API RESULT] ${panel.name} ${response.status} ${url}`);

      if (!response.ok) {
        const error = new Error(`Panel API error ${response.status}: ${text || response.statusText}`);
        if (response.status === 404 && candidates.length > 1) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return assertPanelPayload(data ?? text);
    } catch (error) {
      if (debug) console.error(`[API ERROR] ${panel.name} ${String(error?.message || error)}`);
      if (candidates.length > 1 && (
        String(error?.message || "").includes("Panel API error 404") ||
        String(error?.message || "").includes("fetch failed")
      )) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error(`Panel API failed: ${panel.name} ${path}`);
}

async function tryPanelApi(panel, path, method, body = null) {
  try {
    const response = await panelApi(panel, path, method, body);
    return { ok: true, path, response };
  } catch (error) {
    return { ok: false, path, error: shortError(error) };
  }
}

// ─── Client Data Extraction ───────────────────────────────────

function flattenCandidates(value, list = []) {
  if (value === null || value === undefined) return list;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== null) flattenCandidates(parsed, list);
    return list;
  }
  if (typeof value !== "object") return list;
  if (Array.isArray(value)) {
    for (const item of value) flattenCandidates(item, list);
    return list;
  }
  list.push(value);
  for (const key of ["obj", "data", "client", "clients", "clientStats", "client_stats", "stats", "traffic", "trafficStats", "traffic_stats", "inbounds", "nodes", "node", "settings", "server", "status", "versions", "items", "result", "list"]) {
    const child = value[key];
    if (child !== null && typeof child === "object") flattenCandidates(child, list);
  }
  return list;
}

function getIdentifierFromClient(client) {
  if (!client || typeof client !== "object") return "نامشخص";
  for (const field of ["email", "clientEmail", "client_email", "id", "clientId", "client_id", "uuid", "username", "name", "subId", "subid", "sub_id"]) {
    const value = normalizeIdentifier(client[field]);
    if (value) return value;
  }
  return "نامشخص";
}

function clientMatches(client, identifier) {
  if (!client || typeof client !== "object") return false;
  const expected = normalizeIdentifier(identifier);
  if (!expected) return false;
  for (const field of ["email", "clientEmail", "client_email", "id", "clientId", "client_id", "uuid", "username", "name", "subId", "subid", "sub_id"]) {
    if (sameIdentifier(client[field], expected)) return true;
  }
  return false;
}

function isClientLike(item) {
  if (!item || typeof item !== "object") return false;
  // Client schema: email, enable, expiryTime, id, limitIp, subId, tgId, totalGB, reset, flow, comment, password, auth, security, group
  const email = normalizeIdentifier(item.email || item.clientEmail || item.client_email);
  const clientId = normalizeIdentifier(item.clientId || item.client_id || item.id || item.uuid);
  const hasClientFields = email && (
    clientId || item.subId || item.enable !== undefined || item.totalGB !== undefined ||
    item.total !== undefined || item.expiryTime !== undefined || item.tgId !== undefined ||
    item.limitIp !== undefined || item.flow !== undefined || item.reset !== undefined ||
    item.comment !== undefined || item.password !== undefined || item.auth !== undefined
  );
  return Boolean(hasClientFields || (clientId && !/^\d+$/.test(clientId)));
}

function isInboundLike(item) {
  if (!item || typeof item !== "object") return false;
  // Inbound schema: id, tag, port, protocol, remark, enable, listen, clientStats, settings, streamSettings, sniffing
  return Boolean(
    (item.tag || item.remark || item.port !== undefined || item.protocol !== undefined || item.listen !== undefined) &&
    (item.id !== undefined || item.tag || item.port !== undefined || item.protocol !== undefined)
  );
}

function extractClientsFromPayload(payload) {
  const seen = new Map(); // id -> client object
  const allItems = flattenCandidates(payload);

  for (const item of allItems) {
    if (!isClientLike(item)) continue;
    const id = getIdentifierFromClient(item);
    if (!id || id === "نامشخص") continue;

    if (seen.has(id)) {
      // Already have this client — merge traffic data if the existing one lacks it
      const existing = seen.get(id);
      const existingTraffic = getClientTraffic(existing);
      if (existingTraffic.up === 0 && existingTraffic.down === 0) {
        const newTraffic = getClientTraffic(item);
        if (newTraffic.up > 0 || newTraffic.down > 0) {
          existing.up = (existing.up || 0) + newTraffic.up;
          existing.down = (existing.down || 0) + newTraffic.down;
        }
        // Also merge total if existing doesn't have it
        if (!getClientTotalBytes(existing)) {
          const newTotal = getClientTotalBytes(item);
          if (newTotal > 0) existing.total = newTotal;
        }
      }
    } else {
      seen.set(id, item);
    }
  }

  return Array.from(seen.values());
}

function extractClient(response, identifier) {
  if (!response) return null;
  const candidates = flattenCandidates(response).filter((item) => clientMatches(item, identifier));
  if (!candidates.length) return null;

  // Prefer the candidate that has traffic data
  const withTraffic = candidates.find((item) => {
    const traffic = getClientTraffic(item);
    return traffic.up > 0 || traffic.down > 0;
  });
  return withTraffic || candidates[0];
}

function isNotFoundError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("404") || message.includes("not found") || message.includes("client not found");
}

// ─── Traffic Calculation ──────────────────────────────────────

function getFirstTrafficValue(obj, keys) {
  if (!obj || typeof obj !== "object") return 0;
  for (const key of keys) {
    const value = readNumberValue(obj[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function getClientTraffic(client) {
  if (!client || typeof client !== "object") return { up: 0, down: 0 };
  const upKeys = ["up", "upload", "sent", "tx", "trafficUp"];
  const downKeys = ["down", "download", "recv", "rx", "trafficDown"];

  const directUp = getFirstTrafficValue(client, upKeys);
  const directDown = getFirstTrafficValue(client, downKeys);
  if (directUp > 0 || directDown > 0) return { up: directUp, down: directDown };

  for (const key of ["clientStats", "client_stats", "stats", "traffic", "trafficStats", "traffic_stats"]) {
    const nested = client[key];
    if (Array.isArray(nested)) {
      const matched = nested.filter((item) => clientMatches(item, getIdentifierFromClient(client)));
      let up = 0, down = 0;
      for (const item of matched) {
        up += getFirstTrafficValue(item, upKeys);
        down += getFirstTrafficValue(item, downKeys);
      }
      if (up > 0 || down > 0) return { up, down };
    }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const up = getFirstTrafficValue(nested, upKeys);
      const down = getFirstTrafficValue(nested, downKeys);
      if (up > 0 || down > 0) return { up, down };
    }
  }
  return { up: 0, down: 0 };
}

function getClientTotalBytes(client) {
  if (!client || typeof client !== "object") return 0;
  for (const key of ["totalGB", "total", "trafficLimit", "trafficLimitBytes", "limit"]) {
    const value = readNumberValue(client[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function isClientEnabled(client) {
  const value = client?.enable;
  return value !== false && value !== "false" && value !== 0 && value !== "0";
}

function isClientExpired(client) {
  const expiry = Number(client?.expiryTime ?? 0);
  return expiry > 0 && expiry < Date.now();
}

function isClientDepleted(client) {
  const total = getClientTotalBytes(client);
  if (total <= 0) return false;
  const traffic = getClientTraffic(client);
  return (traffic.up + traffic.down) >= total;
}

// ─── Traffic Merge from clientStats ──────────────────────────
// In 3x-ui, traffic data (up/down) is often stored in clientStats
// objects, not directly on the client object. These functions merge
// traffic from clientStats into the client objects so that
// getClientTraffic() can find the values.

function mergeTrafficIntoClient(client, rawPayload) {
  if (!client || !rawPayload) return;
  // If client already has traffic data, skip
  const existingTraffic = getClientTraffic(client);
  if (existingTraffic.up > 0 || existingTraffic.down > 0) return;

  const identifier = getIdentifierFromClient(client);

  // Strategy 1: Find matching clientStats entries in the raw payload
  const allStats = flattenCandidates(rawPayload).filter((item) => {
    if (!item || typeof item !== "object") return false;
    return (item.up !== undefined || item.down !== undefined ||
           item.upload !== undefined || item.download !== undefined) &&
           (item.email || item.clientEmail || item.client_email);
  });

  let totalUp = 0, totalDown = 0;
  for (const stat of allStats) {
    if (clientMatches(stat, identifier)) {
      totalUp += Number(stat.up || stat.upload || stat.sent || stat.tx || 0);
      totalDown += Number(stat.down || stat.download || stat.recv || stat.rx || 0);
    }
  }

  if (totalUp > 0 || totalDown > 0) {
    client.up = (client.up || 0) + totalUp;
    client.down = (client.down || 0) + totalDown;
  }
}

function mergeTrafficFromPayload(clients, rawPayload) {
  if (!clients.length || !rawPayload) return;
  const allStats = flattenCandidates(rawPayload).filter((item) => {
    if (!item || typeof item !== "object") return false;
    return (item.up !== undefined || item.down !== undefined ||
           item.upload !== undefined || item.download !== undefined) &&
           (item.email || item.clientEmail || item.client_email);
  });

  for (const client of clients) {
    const existingTraffic = getClientTraffic(client);
    if (existingTraffic.up > 0 || existingTraffic.down > 0) continue;

    const identifier = getIdentifierFromClient(client);
    let totalUp = 0, totalDown = 0;
    for (const stat of allStats) {
      if (clientMatches(stat, identifier)) {
        totalUp += Number(stat.up || stat.upload || stat.sent || stat.tx || 0);
        totalDown += Number(stat.down || stat.download || stat.recv || stat.rx || 0);
      }
    }
    if (totalUp > 0 || totalDown > 0) {
      client.up = (client.up || 0) + totalUp;
      client.down = (client.down || 0) + totalDown;
    }
  }
}

// ─── Inbound/Client Operations ────────────────────────────────

async function listAllInbounds(panel) {
  const response = await panelApi(panel, API_PATHS.INBOUNDS_LIST, "GET");
  return flattenCandidates(response).filter(isInboundLike);
}

async function listAllClients(panel) {
  let lastError = null;
  const direct = await tryPanelApi(panel, API_PATHS.CLIENTS_LIST, "GET");
  if (direct.ok) {
    const clients = extractClientsFromPayload(direct.response);
    if (clients.length) {
      // Merge traffic from clientStats into client objects
      mergeTrafficFromPayload(clients, direct.response);
      return clients;
    }
  } else {
    lastError = direct.error;
  }
  try {
    const response = await panelApi(panel, API_PATHS.INBOUNDS_LIST, "GET");
    const clients = extractClientsFromPayload(response);
    mergeTrafficFromPayload(clients, response);
    return clients;
  } catch (error) {
    if (lastError) throw new Error(`${lastError}; ${shortError(error)}`);
    throw error;
  }
}

async function getClientByIdentifier(identifier, env, panelId) {
  const id = normalizeIdentifier(identifier);
  if (!id) return null;
  const panel = await resolvePanelAsync(env, panelId);
  if (!panel) return null;

  let client = null;
  try {
    const response = await panelApi(panel, `${API_PATHS.CLIENTS_GET}${encodeURIComponent(id)}`, "GET");
    client = extractClient(response, id);
    // Merge traffic from clientStats if available in the response
    if (client) mergeTrafficIntoClient(client, response);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  if (client) {
    // Try to fetch dedicated traffic data from 3x-ui traffic API
    await enrichClientTraffic(client, panel);
    return client;
  }

  const clients = await listAllClients(panel);
  const found = clients.find((item) => clientMatches(item, id)) || null;
  if (found) await enrichClientTraffic(found, panel);
  return found;
}

// Fetch traffic data for a client from multiple 3x-ui sources
async function enrichClientTraffic(client, panel) {
  const identifier = getIdentifierFromClient(client);

  // Always fetch fresh traffic data from inbound list.
  // This is the most reliable source in all 3x-ui versions.
  // IMPORTANT: always overwrite client.up/down with the fresh sum from
  // clientStats — the client object from /clients/get has no up/down,
  // and any direct up/down on the object might be stale or wrong.
  try {
    const inboundsResponse = await panelApi(panel, API_PATHS.INBOUNDS_LIST, "GET");
    const trafficAndTotal = findTrafficInInbounds(inboundsResponse, identifier);
    // ALWAYS overwrite — fresh data from clientStats is authoritative
    client.up = trafficAndTotal.up;
    client.down = trafficAndTotal.down;

    // If client has no positive totalGB (0 = unlimited), but clientStats
    // has a positive total, use that. This handles edge cases where the
    // /clients/get response didn't include totalGB but clientStats does.
    const currentTotal = getClientTotalBytes(client);
    if (currentTotal === 0 && trafficAndTotal.total > 0) {
      client.total = trafficAndTotal.total;
    }

    // Same for expiryTime and enable — only set if missing
    if (trafficAndTotal.expiryTime > 0 && (client.expiryTime === undefined || client.expiryTime === 0)) {
      client.expiryTime = trafficAndTotal.expiryTime;
    }
    if (trafficAndTotal.enable !== undefined && client.enable === undefined) {
      client.enable = trafficAndTotal.enable;
    }

    // Last online (for "online" indicator in formatClient)
    if (trafficAndTotal.lastOnline > 0) {
      client.lastOnline = trafficAndTotal.lastOnline;
    }
  } catch (error) {
    console.error(`enrichClientTraffic inbound list error for ${panel.name}:`, shortError(error));
  }

  // Fallback: Try dedicated traffic API endpoint if we still have no data
  const existingTraffic = getClientTraffic(client);
  if (existingTraffic.up === 0 && existingTraffic.down === 0) {
    try {
      const trafficData = await panelApi(panel, `${API_PATHS.CLIENT_TRAFFIC}${encodeURIComponent(identifier)}`, "GET");
      if (trafficData) {
        const flat = flattenCandidates(trafficData);
        let totalUp = 0, totalDown = 0;
        for (const item of flat) {
          if (item && typeof item === "object") {
            const up = Number(item.up || item.upload || item.sent || 0);
            const down = Number(item.down || item.download || item.recv || 0);
            if (up > 0) totalUp += up;
            if (down > 0) totalDown += down;
          }
        }
        if (totalUp > 0 || totalDown > 0) {
          client.up = totalUp;
          client.down = totalDown;
        }
      }
    } catch { /* Traffic API not available */ }
  }
}

// Directly search for client traffic in inbound list's clientStats
function findTrafficInInbounds(inboundsData, identifier) {
  let result = { up: 0, down: 0, total: 0, expiryTime: 0, enable: undefined, lastOnline: 0, uuid: "" };
  const seenInboundIds = new Set();
  // Also dedupe by stat id + inbound id, in case the same stat appears twice
  // (some 3x-ui forks return duplicate clientStats entries for the same client).
  const seenStatKeys = new Set();

  // Handle various response formats
  const inbounds = extractInboundsArray(inboundsData);

  for (const inbound of inbounds) {
    if (!inbound || typeof inbound !== "object") continue;

    // Deduplicate inbounds by id to avoid double-counting
    const inboundKey = inbound.id ?? inbound.tag ?? inbound.port ?? JSON.stringify(inbound).slice(0, 50);
    if (seenInboundIds.has(inboundKey)) continue;
    seenInboundIds.add(inboundKey);

    // Check clientStats array directly — ClientTraffic schema: up, down, total, expiryTime, enable, lastOnline, email, uuid, inboundId, reset
    const clientStats = inbound.clientStats || inbound.client_stats || [];
    if (Array.isArray(clientStats)) {
      for (const stat of clientStats) {
        if (!stat || typeof stat !== "object") continue;
        const matches = sameIdentifier(stat.email, identifier) || sameIdentifier(stat.clientEmail, identifier);
        if (matches) {
          // Dedupe by stat.id + inboundId to avoid double-counting duplicate
          // clientStats entries that some 3x-ui forks return.
          const statKey = `${stat.id ?? ""}:${stat.inboundId ?? inbound.id ?? ""}:${stat.email ?? ""}`;
          if (seenStatKeys.has(statKey)) continue;
          seenStatKeys.add(statKey);

          result.up += Number(stat.up || stat.upload || 0);
          result.down += Number(stat.down || stat.download || 0);
          // total is the same across inbounds for the same client — take the max
          if (stat.total && stat.total > 0 && stat.total > result.total) result.total = Number(stat.total);
          // expiryTime is the same across inbounds — take the max
          if (stat.expiryTime && stat.expiryTime > 0 && stat.expiryTime > result.expiryTime) result.expiryTime = Number(stat.expiryTime);
          if (stat.enable !== undefined) result.enable = stat.enable;
          // lastOnline — take the most recent
          if (stat.lastOnline) {
            const lastOnline = Number(stat.lastOnline);
            const lastOnlineMs = lastOnline < 1e12 ? lastOnline * 1000 : lastOnline;
            if (lastOnlineMs > result.lastOnline) result.lastOnline = lastOnlineMs;
          }
          // uuid
          if (stat.uuid && !result.uuid) result.uuid = stat.uuid;
        }
      }
    }
  }

  return result;
}

// Extract inbounds array from various API response formats
function extractInboundsArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  // { success: true, obj: [...] }
  if (data.obj && Array.isArray(data.obj)) return data.obj;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.result && Array.isArray(data.result)) return data.result;
  if (data.inbounds && Array.isArray(data.inbounds)) return data.inbounds;
  if (data.list && Array.isArray(data.list)) return data.list;

  // Check if data itself is an inbound-like object
  if (data.id !== undefined && (data.protocol || data.port !== undefined)) return [data];

  return [];
}

async function searchClientAcrossPanels(identifier, env) {
  const id = normalizeIdentifier(identifier);
  if (!id) return [];
  const panels = await getPanels(env);
  const results = [];
  for (const panel of panels) {
    try {
      const client = await getClientByIdentifier(id, env, panel.id);
      if (client) results.push({ panel, client });
    } catch { /* ignore */ }
  }
  return results;
}

async function getPanelInboundIds(panel) {
  if (panel.inboundIds && panel.inboundIds.length) return panel.inboundIds;
  try {
    const inbounds = await listAllInbounds(panel);
    const ids = inbounds.map((item) => item.id ?? item.port).filter((id) => id !== undefined && id !== null && id !== "");
    if (ids.length) return [...new Set(ids)];
  } catch { /* ignore */ }
  return ["1"];
}

async function findClientInboundIds(panel, email) {
  const normalizedEmail = normalizeIdentifier(email);
  const ids = [];
  if (!normalizedEmail) return ids;
  try {
    const inbounds = await listAllInbounds(panel);
    for (const inbound of inbounds) {
      const inboundId = inbound.id ?? inbound.port;
      if (inboundId === undefined || inboundId === null || inboundId === "") continue;
      const candidates = flattenCandidates(inbound).filter((item) => {
        if (!item || typeof item !== "object" || !isClientLike(item)) return false;
        return sameIdentifier(item.email, normalizedEmail) || sameIdentifier(item.clientEmail, normalizedEmail) || sameIdentifier(item.client_email, normalizedEmail);
      });
      if (candidates.length) ids.push(inboundId);
    }
  } catch { /* ignore */ }
  return [...new Set(ids)];
}

// Settings manipulation helpers
function parseSettingsObject(inbound) {
  const settings = inbound?.settings;
  if (settings && typeof settings === "object" && !Array.isArray(settings)) return JSON.parse(JSON.stringify(settings));
  if (typeof settings === "string") {
    const parsed = parseJson(settings);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return { clients: [] };
}

function writeSettingsObject(inbound, settingsObj) {
  const next = JSON.parse(JSON.stringify(inbound));
  const originalSettings = inbound?.settings;
  if (typeof originalSettings === "string") {
    const parsed = parseJson(originalSettings) || {};
    Object.assign(parsed, settingsObj);
    next.settings = JSON.stringify(parsed);
  } else {
    next.settings = settingsObj;
  }
  return next;
}

function readSettingsClients(inbound) {
  const settingsObj = parseSettingsObject(inbound);
  return Array.isArray(settingsObj.clients) ? settingsObj.clients : [];
}

function writeSettingsClients(inbound, clients) {
  return writeSettingsObject(inbound, { clients });
}

function updateClientInInboundSettings(inbound, email, updates) {
  const clients = readSettingsClients(inbound);
  if (!clients.length) return null;
  let changed = false;
  const nextClients = clients.map((client) => {
    if (!(sameIdentifier(client.email, email) || sameIdentifier(client.clientEmail, email) || sameIdentifier(client.client_email, email) || sameIdentifier(client.id, email) || sameIdentifier(client.uuid, email))) return client;
    changed = true;
    return { ...client, ...updates };
  });
  if (!changed) return null;
  return writeSettingsClients(inbound, nextClients);
}

function addClientToInboundSettings(inbound, client) {
  const clients = readSettingsClients(inbound);
  if (clients.some((item) => sameIdentifier(item.email, client.email) || sameIdentifier(item.id, client.id) || sameIdentifier(item.uuid, client.id))) return null;
  const inboundClient = {
    email: client.email,
    id: client.id || client.uuid || generateClientId(),
    password: client.password || generateToken(16),
    enable: client.enable !== false,
    flow: client.flow ?? "",
    limitIp: client.limitIp ?? client.limitIP ?? 0,
    totalGB: Number(client.totalGB ?? client.total ?? 0),
    expiryTime: Number(client.expiryTime ?? 0),
    tgId: client.tgId ?? client.tgID ?? 0,
    subId: client.subId || client.subid || client.sub_id || "",
    reset: client.reset ?? 0,
    comment: client.comment ?? "",
  };
  return writeSettingsClients(inbound, [...clients, inboundClient]);
}

function removeClientFromInboundSettings(inbound, email) {
  const clients = readSettingsClients(inbound);
  const before = clients.length;
  const nextClients = clients.filter((client) => !(
    sameIdentifier(client.email, email) || sameIdentifier(client.clientEmail, email) ||
    sameIdentifier(client.client_email, email) || sameIdentifier(client.id, email) || sameIdentifier(client.uuid, email)
  ));
  if (nextClients.length === before) return null;
  return writeSettingsClients(inbound, nextClients);
}

async function getInboundById(panel, inboundId) {
  const inbounds = await listAllInbounds(panel);
  return inbounds.find((item) => sameIdentifier(item.id ?? item.port, inboundId)) || null;
}

// ─── Client CRUD Operations ──────────────────────────────────

function buildClientPayload(client, updates = {}) {
  const email = client.email || client.clientEmail || client.client_email || "";
  const idValue = client.id || client.clientId || client.client_id || client.uuid || "";
  const hasTotalGB = Object.prototype.hasOwnProperty.call(updates, "totalGB");
  const hasExpiryTime = Object.prototype.hasOwnProperty.call(updates, "expiryTime");
  const hasEnable = Object.prototype.hasOwnProperty.call(updates, "enable");

  const payload = {
    email,
    flow: client.flow ?? "",
    limitIp: updates.limitIp ?? client.limitIp ?? client.limitIP ?? 0,
    totalGB: hasTotalGB ? Number(updates.totalGB) : Number(client.totalGB ?? client.total ?? 0),
    expiryTime: hasExpiryTime ? Number(updates.expiryTime) : Number(client.expiryTime ?? 0),
    enable: hasEnable ? Boolean(updates.enable) : isClientEnabled(client),
    tgId: client.tgId ?? client.tgID ?? 0,
    subId: client.subId || client.subid || client.sub_id || "",
    reset: client.reset ?? 0,
  };

  if (idValue) payload.id = idValue;
  if (client.password) payload.password = client.password;
  if (client.protocol) payload.protocol = client.protocol;
  if (client.security) payload.security = client.security;
  if (client.auth) payload.auth = client.auth;
  if (client.comment) payload.comment = client.comment;
  return payload;
}

async function createClient(panel, identifier, days, gb, options = {}) {
  const email = normalizeIdentifier(identifier);
  if (!email) throw new Error("شناسه کاربر خالی است");

  const subId = generateSubId(8);
  const allInboundIds = await getPanelInboundIds(panel);
  // Client schema: email, enable, expiryTime, id, limitIp, subId, tgId, totalGB, reset, flow, comment, password, auth, security, group
  const client = {
    email,
    id: generateClientId(),
    password: generateToken(16),
    subId,
    enable: true,
    expiryTime: Date.now() + Number(days) * MS_PER_DAY,
    totalGB: Number(gb) * BYTES_PER_GB,
    limitIp: Number(options.limitIp) || 0,
    tgId: options.tgId || 0,
    reset: 0,
    comment: options.adminChatId ? `TG:${options.adminChatId}` : (options.comment || "Telegram Bot"),
    flow: options.flow || "",
    group: options.group || "",
    security: options.security || "",
  };

  // Try v3.x clients API first
  const direct = await tryPanelApi(panel, API_PATHS.CLIENTS_ADD, "POST", {
    client, inboundIds: allInboundIds.map(Number),
  });
  if (direct.ok) return direct.response;

  // Fallback: try per-inbound
  let lastError = null;
  for (const inboundId of allInboundIds) {
    try {
      return await panelApi(panel, API_PATHS.CLIENTS_ADD, "POST", {
        client, inboundIds: [Number(inboundId)],
      });
    } catch (error) { lastError = error; }

    try {
      return await panelApi(panel, `/panel/api/inbounds/createClient/${encodeURIComponent(inboundId)}`, "POST", client);
    } catch (error) { lastError = error; }
  }

  // Last resort: modify inbound settings directly
  try {
    for (const inboundId of allInboundIds) {
      const inbound = await getInboundById(panel, inboundId);
      if (!inbound) continue;
      const nextInbound = addClientToInboundSettings(inbound, client);
      if (!nextInbound) continue;
      return await panelApi(panel, `${API_PATHS.INBOUNDS_UPDATE}${encodeURIComponent(inboundId)}`, "POST", nextInbound);
    }
  } catch (error) { throw lastError || error; }

  throw lastError || new Error("Client creation failed");
}

async function updateClient(panel, client, updates) {
  const payload = buildClientPayload(client, updates);
  const email = payload.email;

  const direct = await tryPanelApi(panel, `${API_PATHS.CLIENTS_UPDATE}${encodeURIComponent(email)}`, "POST", payload);
  if (direct.ok) return direct.response;

  let lastError = null;
  const inboundIds = await findClientInboundIds(panel, email);
  const fallbackIds = inboundIds.length ? inboundIds : await getPanelInboundIds(panel);

  for (const inboundId of fallbackIds) {
    try {
      const inbound = await getInboundById(panel, inboundId);
      if (!inbound) continue;
      const nextInbound = updateClientInInboundSettings(inbound, email, updates);
      if (!nextInbound) continue;
      return await panelApi(panel, `${API_PATHS.INBOUNDS_UPDATE}${encodeURIComponent(inboundId)}`, "POST", nextInbound);
    } catch (error) { lastError = error; }
  }

  throw lastError || new Error("Client update failed");
}

async function deleteClient(panel, identifier, env) {
  const email = normalizeIdentifier(identifier);
  if (!email) throw new Error("شناسه کاربر خالی است");

  // Find the client first to get its UUID
  let uuid = email;
  if (env) {
    try {
      const client = await getClientByIdentifier(email, env, panel.id || "");
      if (client) {
        uuid = client.id || client.uuid || client.clientId || email;
      }
    } catch { /* ignore, use email */ }
  }

  // Try v3.x clients API with UUID
  const direct = await tryPanelApi(panel, `${API_PATHS.CLIENTS_DEL}${encodeURIComponent(uuid)}`, "POST");
  if (direct.ok) return direct.response;

  // Try with email as fallback
  const directEmail = await tryPanelApi(panel, `${API_PATHS.CLIENTS_DEL}${encodeURIComponent(email)}`, "POST");
  if (directEmail.ok) return directEmail.response;

  // Try POST body with uuids
  const directBody = await tryPanelApi(panel, API_PATHS.CLIENTS_DEL, "POST", { uuids: uuid });
  if (directBody.ok) return directBody.response;

  let lastError = null;
  const inboundIds = await findClientInboundIds(panel, email);
  const fallbackIds = inboundIds.length ? inboundIds : await getPanelInboundIds(panel);

  for (const inboundId of fallbackIds) {
    try {
      const inbound = await getInboundById(panel, inboundId);
      if (!inbound) continue;
      const nextInbound = removeClientFromInboundSettings(inbound, email);
      if (!nextInbound) continue;
      return await panelApi(panel, `${API_PATHS.INBOUNDS_UPDATE}${encodeURIComponent(inboundId)}`, "POST", nextInbound);
    } catch (error) { lastError = error; }
  }

  throw lastError || new Error("Client delete failed");
}

async function resetClientTraffic(panel, identifier, env) {
  const email = normalizeIdentifier(identifier);
  if (!email) throw new Error("شناسه کاربر خالی است");

  // Find the client first to get its UUID
  let uuid = email;
  if (env) {
    try {
      const client = await getClientByIdentifier(email, env, panel.id || "");
      if (client) {
        uuid = client.id || client.uuid || client.clientId || email;
      }
    } catch { /* ignore */ }
  }

  // Try reset_traffic endpoint with UUID
  const direct = await tryPanelApi(panel, `${API_PATHS.CLIENTS_RESET_TRAFFIC}${encodeURIComponent(uuid)}`, "POST");
  if (direct.ok) return direct.response;

  // Try with email
  const directEmail = await tryPanelApi(panel, `${API_PATHS.CLIENTS_RESET_TRAFFIC}${encodeURIComponent(email)}`, "POST");
  if (directEmail.ok) return directEmail.response;

  throw direct.error || directEmail.error || new Error("Reset traffic failed");
}

async function getClientIps(panel, identifier, env) {
  const email = normalizeIdentifier(identifier);
  if (!email) throw new Error("شناسه کاربر خالی است");

  let uuid = email;
  if (env) {
    try {
      const client = await getClientByIdentifier(email, env, panel.id || "");
      if (client) {
        uuid = client.id || client.uuid || client.clientId || email;
      }
    } catch { /* ignore */ }
  }

  const direct = await tryPanelApi(panel, `${API_PATHS.CLIENTS_IPS}${encodeURIComponent(uuid)}`, "GET");
  if (direct.ok) return direct.response;

  const directEmail = await tryPanelApi(panel, `${API_PATHS.CLIENTS_IPS}${encodeURIComponent(email)}`, "GET");
  if (directEmail.ok) return directEmail.response;

  throw direct.error || directEmail.error || new Error("Get client IPs failed");
}

async function restartPanel(panel) {
  return await panelApi(panel, API_PATHS.SERVER_RESTART_PANEL, "POST");
}

async function getServerLogs(panel) {
  // Try multiple log endpoint paths. Different 3x-ui versions expose logs
  // at different paths.
  // v3.4.x: /panel/api/server/logs/:count (POST) and /panel/api/server/xraylogs/:count (POST)
  // Older: /panel/api/server/getLogs (POST/GET)
  const candidates = [
    { path: API_PATHS.SERVER_GET_LOGS,           method: "POST" }, // v3.4.x: /server/logs/100
    { path: API_PATHS.SERVER_XRAY_LOGS,          method: "POST" }, // v3.4.x: /server/xraylogs/100
    { path: "/panel/api/server/getLogs",         method: "POST" }, // older 3x-ui
    { path: "/panel/api/server/getLogs",         method: "GET"  }, // some forks
    { path: "/panel/api/server/getXrayLogs",     method: "POST" }, // alternate name
    { path: "/panel/api/server/getXrayLogs",     method: "GET"  },
    { path: "/panel/api/server/logs",            method: "GET"  }, // shorter alias
    { path: "/panel/api/server/log",             method: "GET"  }, // very short
    { path: "/panel/api/xray/getLogs",           method: "GET"  }, // under /xray/
    { path: "/panel/api/xray/logs",              method: "GET"  },
  ];

  let lastError = null;
  for (const c of candidates) {
    try {
      const result = await panelApi(panel, c.path, c.method);
      // Accept any non-empty response — caller (panel_logs: handler)
      // will extract log lines from it.
      if (result) return result;
    } catch (e) {
      lastError = e;
      // Continue trying next candidate — different versions register
      // different paths, so a 404 here doesn't mean the panel is broken.
    }
  }

  // None of the log endpoints worked. Throw a descriptive error so the
  // admin sees a helpful message instead of just "404".
  throw new Error(
    `این نسخه از 3x-ui لاگ سرور را از طریق API ارائه نمی‌دهد. ` +
    `${candidates.length} مسیر مختلف تست شد. ` +
    `برای مشاهده لاگ‌ها، وارد پنل 3x-ui شوید. `
  );
}

async function addInbound(panel, inboundData) {
  return await panelApi(panel, API_PATHS.INBOUNDS_ADD, "POST", inboundData);
}

async function deleteInbound(panel, inboundId) {
  const direct = await tryPanelApi(panel, `${API_PATHS.INBOUNDS_DEL}${encodeURIComponent(inboundId)}`, "POST");
  if (direct.ok) return direct.response;
  throw direct.error || new Error("Delete inbound failed");
}

// ─── Nodes Management ──────────────────────────────────────────

async function listNodes(panel) {
  const response = await panelApi(panel, API_PATHS.NODES_LIST, "GET");
  return extractNodesFromResponse(response);
}

async function addNode(panel, nodeData) {
  return await panelApi(panel, API_PATHS.NODES_ADD, "POST", nodeData);
}

async function updateNode(panel, nodeId, nodeData) {
  return await panelApi(panel, `${API_PATHS.NODES_UPDATE}${encodeURIComponent(nodeId)}`, "POST", nodeData);
}

async function deleteNode(panel, nodeId) {
  const direct = await tryPanelApi(panel, `${API_PATHS.NODES_DEL}${encodeURIComponent(nodeId)}`, "POST");
  if (direct.ok) return direct.response;
  throw direct.error || new Error("Delete node failed");
}

function extractNodesFromResponse(response) {
  const nodes = [];
  if (!response) return nodes;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // Node schema: guid, id, address, port, remark, name, enable, cpuPct, memPct, onlineCount, status, etc.
    const hasNodeFields = (item.guid !== undefined || item.id !== undefined) &&
                          (item.address || item.port !== undefined || item.remark !== undefined);
    if (hasNodeFields) {
      nodes.push({
        id: item.id ?? item.guid ?? "",
        guid: item.guid ?? item.id ?? "",
        address: item.address || item.host || "",
        port: item.port || 0,
        remark: item.remark || item.name || "",
        name: item.name || item.remark || "",
        enable: item.enable !== false,
        status: item.status || "",
        cpuPct: Number(item.cpuPct || 0),
        memPct: Number(item.memPct || 0),
        onlineCount: Number(item.onlineCount || 0),
        clientCount: Number(item.clientCount || 0),
        inboundCount: Number(item.inboundCount || 0),
        xrayVersion: item.xrayVersion || "",
        panelVersion: item.panelVersion || "",
        latencyMs: Number(item.latencyMs || 0),
        uptimeSecs: Number(item.uptimeSecs || 0),
        xrayState: item.xrayState || "",
        lastError: item.lastError || "",
        scheme: item.scheme || "",
        basePath: item.basePath || "",
      });
    }
  }
  return nodes;
}

// ─── API Tokens Management ────────────────────────────────────

async function listApiTokens(panel) {
  // Try the dedicated endpoint first.
  try {
    const response = await panelApi(panel, API_PATHS.API_TOKENS_LIST, "GET");
    const tokens = extractApiTokensFromResponse(response);
    if (tokens.length) return tokens;
  } catch (e) {
    // 404 expected on some 3x-ui versions — fall through to settings fallback.
  }

  // Fallback: extract API tokens from /panel/api/setting/all.
  // In newer 3x-ui versions, settings response includes `obj.apiTokens`
  // array with fields: { id, name, token, expireAt, lastUseAt }.
  try {
    const settings = await panelApi(panel, API_PATHS.SETTINGS_ALL, "POST");
    const obj = settings?.obj || settings;
    const tokensFromSettings = obj?.apiTokens || obj?.api_tokens || [];
    if (Array.isArray(tokensFromSettings) && tokensFromSettings.length) {
      return tokensFromSettings.map((t, i) => ({
        id: t.id ?? i + 1,
        name: t.name || `Token ${i + 1}`,
        token: t.token || t.key || "",
        enabled: t.enabled !== false,
        createdAt: t.createdAt || 0,
        expireAt: t.expireAt || 0,
      }));
    }
  } catch { /* settings also unavailable */ }

  return [];
}

async function addApiToken(panel, tokenData) {
  return await panelApi(panel, API_PATHS.API_TOKENS_ADD, "POST", tokenData);
}

async function deleteApiToken(panel, tokenId) {
  const direct = await tryPanelApi(panel, `${API_PATHS.API_TOKENS_DEL}${encodeURIComponent(tokenId)}`, "POST");
  if (direct.ok) return direct.response;
  throw direct.error || new Error("Delete API token failed");
}

function extractApiTokensFromResponse(response) {
  const tokens = [];
  if (!response) return tokens;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // ApiToken schema: id, name, token, enabled, createdAt
    if (item.id !== undefined && (item.name !== undefined || item.token !== undefined)) {
      tokens.push({
        id: item.id,
        name: item.name || "",
        token: item.token || "",
        enabled: item.enabled !== false,
        createdAt: item.createdAt || 0,
      });
    }
  }
  return tokens;
}

// ─── Hosts Management ─────────────────────────────────────────

async function listHosts(panel, inboundId) {
  const url = inboundId ? `${API_PATHS.HOSTS_LIST}?inboundId=${encodeURIComponent(inboundId)}` : API_PATHS.HOSTS_LIST;
  const response = await panelApi(panel, url, "GET");
  return extractHostsFromResponse(response);
}

async function addHost(panel, hostData) {
  return await panelApi(panel, API_PATHS.HOSTS_ADD, "POST", hostData);
}

async function deleteHost(panel, hostId) {
  const direct = await tryPanelApi(panel, `${API_PATHS.HOSTS_DEL}${encodeURIComponent(hostId)}`, "POST");
  if (direct.ok) return direct.response;
  throw direct.error || new Error("Delete host failed");
}

function extractHostsFromResponse(response) {
  const hosts = [];
  if (!response) return hosts;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // Host schema: id, inboundId, remark, address, port, sni, security, isDisabled, isHidden
    if (item.id !== undefined && (item.address || item.remark !== undefined || item.inboundId !== undefined)) {
      hosts.push({
        id: item.id,
        inboundId: item.inboundId || 0,
        remark: item.remark || "",
        address: item.address || "",
        port: item.port || 0,
        sni: item.sni || "",
        security: item.security || "",
        isDisabled: item.isDisabled || false,
        isHidden: item.isHidden || false,
        path: item.path || "",
        alpn: item.alpn || "",
        fingerprint: item.fingerprint || "",
      });
    }
  }
  return hosts;
}

// ─── Fallbacks Management ─────────────────────────────────────

async function listFallbacks(panel, inboundId) {
  const url = inboundId ? `${API_PATHS.FALLBACKS_LIST}?inboundId=${encodeURIComponent(inboundId)}` : API_PATHS.FALLBACKS_LIST;
  const response = await panelApi(panel, url, "GET");
  return extractFallbacksFromResponse(response);
}

async function deleteFallback(panel, fallbackId) {
  const direct = await tryPanelApi(panel, `${API_PATHS.FALLBACKS_DEL}${encodeURIComponent(fallbackId)}`, "POST");
  if (direct.ok) return direct.response;
  throw direct.error || new Error("Delete fallback failed");
}

function extractFallbacksFromResponse(response) {
  const fallbacks = [];
  if (!response) return fallbacks;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // InboundFallback schema: id, masterId, childId, name, dest, path, xver, alpn, sortOrder
    if (item.id !== undefined && (item.masterId !== undefined || item.childId !== undefined || item.dest !== undefined)) {
      fallbacks.push({
        id: item.id,
        masterId: item.masterId || 0,
        childId: item.childId || 0,
        name: item.name || "",
        dest: item.dest || "",
        path: item.path || "",
        xver: item.xver || 0,
        alpn: item.alpn || "",
        sortOrder: item.sortOrder || 0,
      });
    }
  }
  return fallbacks;
}

// ─── Outbounds Management ─────────────────────────────────────

async function listOutbounds(panel) {
  const response = await panelApi(panel, API_PATHS.OUTBOUNDS_LIST, "GET");
  return extractOutboundsFromResponse(response);
}

async function getOutboundsTraffic(panel) {
  const response = await panelApi(panel, API_PATHS.OUTBOUNDS_TRAFFICS, "GET");
  return extractOutboundTrafficsFromResponse(response);
}

function extractOutboundsFromResponse(response) {
  const outbounds = [];
  if (!response) return outbounds;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // Outbound: tag, protocol, settings, etc.
    if (item.tag && (item.protocol || item.settings !== undefined)) {
      outbounds.push({
        tag: item.tag,
        protocol: item.protocol || "",
      });
    }
  }
  return outbounds;
}

function extractOutboundTrafficsFromResponse(response) {
  const traffics = [];
  if (!response) return traffics;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // OutboundTraffics schema: id, tag, up, down, total
    if (item.tag !== undefined && (item.up !== undefined || item.down !== undefined || item.total !== undefined)) {
      traffics.push({
        id: item.id || 0,
        tag: item.tag,
        up: Number(item.up || 0),
        down: Number(item.down || 0),
        total: Number(item.total || 0),
      });
    }
  }
  return traffics;
}

// ─── Settings Management ──────────────────────────────────────

async function getAllSettings(panel) {
  const response = await panelApi(panel, API_PATHS.SETTINGS_ALL, "POST");
  return response?.obj || response || null;
}

async function updateSetting(panel, key, value) {
  return await panelApi(panel, API_PATHS.SETTINGS_UPDATE, "POST", { [key]: value });
}

// ─── Panel Users Management ───────────────────────────────────

async function listPanelUsers(panel) {
  // Try the dedicated endpoint first.
  try {
    const response = await panelApi(panel, API_PATHS.USERS_LIST, "GET");
    const users = extractPanelUsersFromResponse(response);
    if (users.length) return users;
  } catch (e) {
    // 404 expected on some 3x-ui versions — fall through to settings fallback.
  }

  // Fallback: extract panel users from /panel/api/setting/all.
  // In newer 3x-ui versions, settings response includes `obj.authConfigs`
  // array with fields: { id, username, password, loginSecret }.
  try {
    const settings = await panelApi(panel, API_PATHS.SETTINGS_ALL, "POST");
    const obj = settings?.obj || settings;
    const usersFromSettings = obj?.authConfigs || obj?.auth_configs || obj?.users || [];
    if (Array.isArray(usersFromSettings) && usersFromSettings.length) {
      return usersFromSettings.map((u, i) => ({
        id: u.id ?? i + 1,
        username: u.username || u.loginSecret || `User ${i + 1}`,
        hasPassword: Boolean(u.password),
      }));
    }
  } catch { /* settings also unavailable */ }

  return [];
}

async function addPanelUser(panel, userData) {
  return await panelApi(panel, API_PATHS.USERS_ADD, "POST", userData);
}

async function deletePanelUser(panel, userId) {
  const direct = await tryPanelApi(panel, `${API_PATHS.USERS_DEL}${encodeURIComponent(userId)}`, "POST");
  if (direct.ok) return direct.response;
  throw direct.error || new Error("Delete panel user failed");
}

function extractPanelUsersFromResponse(response) {
  const users = [];
  if (!response) return users;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // User schema: id, username, password
    if (item.id !== undefined && item.username !== undefined) {
      users.push({
        id: item.id,
        username: item.username || "",
        hasPassword: Boolean(item.password),
      });
    }
  }
  return users;
}

// ─── Database Backup/Restore ──────────────────────────────────

async function restoreDatabase(panel, dbBuffer) {
  const formData = new FormData();
  formData.append("db", new Blob([dbBuffer]), "backup.db");
  return await panelApi(panel, API_PATHS.DATABASE_RESTORE, "POST", formData);
}

async function addDaysToClient(panel, client, days) {
  const currentExpiry = Number(client.expiryTime ?? 0);
  const expiryTime = currentExpiry > Date.now() ? currentExpiry + days * MS_PER_DAY : Date.now() + days * MS_PER_DAY;
  return updateClient(panel, client, { expiryTime });
}

async function addGBToClient(panel, client, gb) {
  const trafficBytes = gb * BYTES_PER_GB;
  const currentTotal = Number(client.totalGB ?? client.total ?? 0);
  const totalGB = currentTotal > 0 ? currentTotal + trafficBytes : trafficBytes;
  return updateClient(panel, client, { totalGB });
}

// ─── Server Status & Xray ────────────────────────────────────

async function getServerStatus(panel) {
  return await panelApi(panel, API_PATHS.SERVER_STATUS, "GET");
}

async function getPanelVersion(panel) {
  for (const item of PANEL_VERSION_PATHS) {
    try {
      const result = await panelApi(panel, item.path, item.method);
      if (result && typeof result === "object") {
        return result.version || result.obj?.version || result.currentVersion || String(result);
      }
    } catch { /* try next */ }
  }
  return "نامشخص";
}

async function getXrayVersion(panel) {
  for (const item of XRAY_VERSION_PATHS) {
    try {
      const result = await panelApi(panel, item.path, item.method);
      if (result && typeof result === "object") {
        return result.obj?.xray?.version || result.xrayVersion || result.version || null;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function restartXray(panel) {
  return await panelApi(panel, API_PATHS.SERVER_RESTART_XRAY, "POST");
}

async function stopXray(panel) {
  return await panelApi(panel, API_PATHS.SERVER_STOP_XRAY, "POST");
}

async function updateXray(panel, version) {
  // v3.4.x: POST /panel/api/server/installXray/:version (version in URL path)
  // Older: POST /panel/api/server/updateXray/:version
  try {
    return await panelApi(panel, `/panel/api/server/installXray/${encodeURIComponent(version)}`, "POST");
  } catch {
    try {
      return await panelApi(panel, `/panel/api/server/updateXray/${encodeURIComponent(version)}`, "POST");
    } catch {
      throw new Error("Xray update failed");
    }
  }
}

async function updatePanel(panel) {
  try {
    return await panelApi(panel, "/panel/api/server/updatePanel", "POST");
  } catch {
    try {
      return await panelApi(panel, API_PATHS.SERVER_PANEL_UPDATE, "POST");
    } catch {
      throw new Error("Panel update failed");
    }
  }
}

// ─── Format Client (Persian) ──────────────────────────────────

function formatClient(client, panel) {
  const traffic = getClientTraffic(client);
  const totalBytes = getClientTotalBytes(client);
  const usedBytes = traffic.up + traffic.down;
  const remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0;
  const expiry = Number(client.expiryTime ?? 0);
  const enabled = isClientEnabled(client);
  const expired = isClientExpired(client);

  let statusIcon, statusText;
  if (expired) {
    statusIcon = "⏰";
    statusText = "منقضی";
  } else if (!enabled) {
    statusIcon = "⛔";
    statusText = "غیرفعال";
  } else if (isClientDepleted(client)) {
    statusIcon = "📦";
    statusText = "اتمام حجم";
  } else {
    statusIcon = "🟢";
    statusText = "فعال";
  }

  // Client schema fields: email, enable, expiryTime, id, limitIp, subId, tgId, totalGB, reset, flow, comment, password, auth, security, group
  const limitIp = Number(client.limitIp || 0);
  const tgId = client.tgId || "";
  const comment = client.comment || "";
  const group = client.group || "";
  const security = client.security || "";
  const flow = client.flow || "";

  const lines = [
    `🖥 سرور: ${panel ? panel.name : "نامشخص"}`,
    ``,
    `🔹 شناسه: ${getIdentifierFromClient(client)}`,
  ];

  // Add optional fields if present
  if (comment) lines.push(`📝 توضیحات: ${comment}`);
  if (group) lines.push(`👥 گروه: ${group}`);
  if (flow) lines.push(`🔄 Flow: ${flow}`);
  if (security) lines.push(`🔐 Security: ${security}`);
  if (limitIp > 0) lines.push(`📱 محدودیت IP: ${limitIp}`);
  if (tgId) lines.push(`🆔 Telegram ID: ${tgId}`);

  // Last online (if available from traffic)
  if (traffic.lastOnline && traffic.lastOnline > 0) {
    const lastOnlineDate = new Date(traffic.lastOnline);
    const minsAgo = Math.floor((Date.now() - traffic.lastOnline) / 60000);
    if (minsAgo < 60) {
      lines.push(`🟢 آخرین فعالیت: ${minsAgo} دقیقه پیش`);
    } else {
      lines.push(`🕐 آخرین فعالیت: ${lastOnlineDate.toLocaleString("fa-IR")}`);
    }
  }

  lines.push(``, `📦 حجم کل: ${totalBytes > 0 ? formatGB(totalBytes) : "نامحدود"}`);
  lines.push(`📊 مصرف شده: ${formatGB(usedBytes)}`);
  lines.push(`⬆️ آپلود: ${formatGB(traffic.up)}`);
  lines.push(`⬇️ دانلود: ${formatGB(traffic.down)}`);
  lines.push(`💾 باقی مانده: ${totalBytes > 0 ? formatGB(remainingBytes) : "نامحدود"}`);
  if (totalBytes > 0) {
    const usagePct = (usedBytes / totalBytes) * 100;
    lines.push(`📈 درصد مصرف: ${formatPercent(usedBytes, totalBytes)}`);
    lines.push(progressBar(usagePct));
  }

  lines.push(``, `📅 تاریخ انقضا: ${expiry > 0 ? formatDate(expiry) : "نامحدود"}`);
  lines.push(`⏳ باقیمانده زمان: ${expiry > 0 ? formatRemainingTime(expiry) : "نامحدود"}`);
  lines.push(``, `${statusIcon} وضعیت: ${statusText}`);

  return lines.join("\n");
}

// ─── Admin Inline Buttons ─────────────────────────────────────

async function buildAdminClientButtons(chatId, client, panel, env) {
  const identifier = getIdentifierFromClient(client);
  const enabled = isClientEnabled(client);

  const cb = async (action) => makeCallbackData(chatId, action, panel, identifier, env);

  // Role check: panel admins only get create/renew/delete/addgb/full_stats/link buttons.
  // Super admins get the full set including enable/disable/reset_traffic/ips.
  const roleInfo = await getAdminRole(env, chatId);
  const isSuper = !roleInfo || roleInfo.role === "super";

  /** @type {any[][]} */
  const buttons = [
    [
      { text: "📊 آمار کامل", callback_data: await cb("full_stats") },
    ],
    [
      { text: "➕ افزایش حجم", callback_data: await cb("addgb") },
      { text: "⏱ تمدید زمان", callback_data: await cb("renew") },
    ],
  ];

  if (isSuper) {
    // Super admin only — these can disrupt service if misused by panel admins.
    buttons.push([
      { text: "🔗 لینک اشتراک", callback_data: await cb("link") },
      { text: "🌐 IPهای کاربر", callback_data: await cb("ips") },
    ]);
    buttons.push([
      { text: "♻️ ریست ترافیک", callback_data: await cb("reset_traffic") },
    ]);
    buttons.push([
      enabled
        ? { text: "⛔ غیرفعال کردن", callback_data: await cb("disable") }
        : { text: "✅ فعال کردن", callback_data: await cb("enable") },
    ]);
  } else {
    // Panel admin still gets the subscription link (useful for giving to clients)
    buttons.push([
      { text: "🔗 لینک اشتراک", callback_data: await cb("link") },
    ]);
  }

  // Both roles can delete users they have access to
  buttons.push([
    { text: "🗑 حذف کاربر", callback_data: await cb("delete") },
  ]);

  return buttons;
}

async function buildUserViewButtons(chatId, email, panelId, env) {
  const supportUser = getSupportUsername(env);
  const lang = await getUserLang(env, chatId).catch(() => "fa");
  const L = (k) => t(lang, k);
  /** @type {any[][]} */
  const buttons = [
    [
      { text: L("refresh"), callback_data: `refresh:${panelId}` },
      { text: L("sub_link"), callback_data: `user_sublink:${panelId}` },
    ],
    [
      { text: L("renew"), callback_data: `user_renew:${panelId}` },
      { text: "📦 +GB", callback_data: `user_addgb:${panelId}` },
    ],
    [
      { text: L("buy_subscription"), callback_data: "user_stars" },
      { text: L("help"), callback_data: "user_help" },
    ],
    [
      { text: L("language"), callback_data: "user_lang" },
      { text: L("github"), url: "https://github.com/Raya-coder/3x-ui-bot" },
    ],
  ];
  if (supportUser) {
    buttons.push([{ text: L("support"), url: `https://t.me/${supportUser}` }]);
  }
  return buttons;
}

async function sendUserMenu(chatId, env) {
  const user = await getUser(env, chatId);
  if (!user) {
    await sendTelegramWithBack(chatId, "❌ شما ثبت‌نام نکرده‌اید. /start را بزنید.", env);
    return;
  }
  const client = await getClientByIdentifier(user.clientEmail, env, user.panelId);
  const panel = await resolvePanelAsync(env, user.panelId);
  if (!client || !panel) {
    // Panel might be deleted - show backup info instead
    const backup = await getUserBackup(env, chatId);
    if (backup) {
      const msg = `⚠️ سرور در دسترس نیست.\n\n${formatUserBackup(backup)}\n\n💡 این اطلاعات از بکاپ داخلی ربات است.`;
      await sendTelegram(chatId, msg, env, await buildUserViewButtons(chatId, user.clientEmail, user.panelId, env));
    } else {
      await sendTelegramWithBack(chatId, "❌ کاربر یافت نشد و بکاپی موجود نیست. لطفاً مجدداً ثبت‌نام کنید.", env);
    }
    return;
  }

  // Update user backup with latest info
  try {
    const traffic = getClientTraffic(client);
    const totalBytes = getClientTotalBytes(client);
    const usedBytes = traffic.up + traffic.down;
    await updateUserBackup(env, chatId, {
      email: getIdentifierFromClient(client),
      panelId: user.panelId,
      totalGB: totalBytes > 0 ? totalBytes / BYTES_PER_GB : null,
      usedGB: usedBytes / BYTES_PER_GB,
      remainingGB: totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) / BYTES_PER_GB : null,
      uploadGB: traffic.up / BYTES_PER_GB,
      downloadGB: traffic.down / BYTES_PER_GB,
      expiryTime: client.expiryTime > 0 ? Number(client.expiryTime) : null,
      enabled: isClientEnabled(client),
      registeredAt: user.registeredAt,
    }, panel);
  } catch { /* ignore backup errors */ }

  const msg = formatClient(client, panel);
  const buttons = await buildUserViewButtons(chatId, user.clientEmail, user.panelId, env);
  await sendTelegram(chatId, msg, env, buttons);
}

// ─── Backup ───────────────────────────────────────────────────

async function autoBackupAllPanels(env) {
  const panels = await getPanels(env);
  const adminIds = await getSuperAdminIds(env);

  for (const panel of panels) {
    try {
      // Download backup from panel API (with auth headers)
      const headers = buildAuthHeaders(panel);
      const candidates = buildApiUrlCandidates(panel, API_PATHS.SERVER_GET_DB);
      let backupBuffer = null;
      let lastError = null;

      for (const url of candidates) {
        try {
          const response = await fetch(url, { method: "GET", headers });
          if (!response.ok) {
            lastError = new Error(`HTTP ${response.status}`);
            continue;
          }
          backupBuffer = await response.arrayBuffer();
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!backupBuffer) {
        throw lastError || new Error("Failed to download backup");
      }

      const filename = `backup_${slugify(panel.name)}_${new Date().toISOString().slice(0, 10)}.db`;
      const caption = `📦 بکاپ خودکار - ${panel.name}\n🕐 ${new Date().toLocaleString("fa-IR")}`;

      for (const adminId of adminIds) {
        try {
          await sendDocumentBuffer(adminId, backupBuffer, filename, caption, env);
        } catch (error) {
          console.error(`Backup send error for ${panel.name}:`, shortError(error));
        }
      }

      await kvPut(env, `${KV_BACKUP_PREFIX}${panel.id}`, { lastBackup: Date.now() });
    } catch (error) {
      console.error(`Backup error for ${panel.name}:`, shortError(error));
      // Try to notify admins of the failure
      for (const adminId of adminIds) {
        try {
          await sendTelegram(adminId, `❌ خطا در بکاپ خودکار ${panel.name}: ${shortError(error)}`, env);
        } catch { /* ignore */ }
      }
    }
  }
}

// ─── Xray Health Check ────────────────────────────────────────

async function checkXrayHealthAllPanels(env) {
  const panels = await getPanels(env);
  const adminIds = await getSuperAdminIds(env);
  const alertIds = new Set([...adminIds]);

  for (const panel of panels) {
    try {
      const status = await getServerStatus(panel);
      const xrayRunning = status?.xray?.running ?? status?.obj?.xray?.running ?? true;

      if (!xrayRunning) {
        const lastAlert = await kvGet(env, `${KV_ALERT_PREFIX}xray:${panel.id}`);
        const now = Date.now();
        const cooldown = (panel.alertCooldownMinutes || DEFAULT_ALERT_COOLDOWN_MINUTES) * MS_PER_MINUTE;

        if (!lastAlert || (now - (lastAlert.timestamp || 0)) > cooldown) {
          const message =
            `🚨 هشدار Xray!\n\n` +
            `❌ Xray در سرور "${panel.name}" متوقف شده است!\n\n` +
            `🔗 پنل: ${panel.panelUrl}\n` +
            `🕐 زمان: ${new Date().toLocaleString("fa-IR")}\n\n` +
            `برای ریستارت خودکار دکمه زیر را بزنید:`;

          const buttons = [
            [{ text: "🔄 ریستارت Xray", callback_data: `xray_restart:${panel.id}` }],
            [{ text: "📊 وضعیت سرور", callback_data: `server_status:${panel.id}` }],
          ];

          for (const chatId of alertIds) {
            try { await sendTelegram(chatId, message, env, buttons); } catch { /* ignore */ }
          }

          await kvPut(env, `${KV_ALERT_PREFIX}xray:${panel.id}`, { timestamp: now, status: "stopped" });
        }
      } else {
        const lastAlert = await kvGet(env, `${KV_ALERT_PREFIX}xray:${panel.id}`);
        if (lastAlert && lastAlert.status === "stopped") {
          const message = `✅ Xray در سرور "${panel.name}" مجدداً راه‌اندازی شد!`;
          for (const chatId of alertIds) {
            try { await sendTelegram(chatId, message, env); } catch { /* ignore */ }
          }
          await kvPut(env, `${KV_ALERT_PREFIX}xray:${panel.id}`, { timestamp: Date.now(), status: "running" });
        }
      }
    } catch (error) {
      console.error(`Xray check error for ${panel.name}:`, shortError(error));
    }
  }
}

// ─── Resource Alerts ──────────────────────────────────────────

async function checkResourceAlertsAllPanels(env) {
  const panels = await getPanels(env);
  const adminIds = await getSuperAdminIds(env);

  for (const panel of panels) {
    try {
      const status = await getServerStatus(panel);
      const obj = status?.obj || status;
      const cpu = Number(obj?.cpu || obj?.cpuPercent || 0);
      const mem = Number(obj?.mem?.current || obj?.memCurrent || obj?.memory || 0);
      const memTotal = Number(obj?.mem?.total || obj?.memTotal || 0);
      const memPercent = memTotal > 0 ? (mem / memTotal) * 100 : 0;
      const threshold = panel.cpuRamAlertThreshold || DEFAULT_CPU_RAM_ALERT_THRESHOLD;

      if (cpu > threshold || memPercent > threshold) {
        const lastAlert = await kvGet(env, `${KV_ALERT_PREFIX}resource:${panel.id}`);
        const now = Date.now();
        const cooldown = (panel.alertCooldownMinutes || DEFAULT_ALERT_COOLDOWN_MINUTES) * MS_PER_MINUTE;

        if (!lastAlert || (now - (lastAlert.timestamp || 0)) > cooldown) {
          const message =
            `⚠️ هشدار منابع سرور!\n\n` +
            `🖥️ سرور: ${panel.name}\n` +
            `💻 CPU: ${cpu.toFixed(1)}%\n` +
            `🧠 RAM: ${memPercent.toFixed(1)}%\n` +
            `📊 آستانه: ${threshold}%\n` +
            `🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;

          for (const chatId of adminIds) {
            try { await sendTelegram(chatId, message, env); } catch { /* ignore */ }
          }

          await kvPut(env, `${KV_ALERT_PREFIX}resource:${panel.id}`, { timestamp: now, cpu, memPercent });
        }
      }
    } catch (error) {
      console.error(`Resource check error for ${panel.name}:`, shortError(error));
    }
  }
}

// ─── Daily Report ─────────────────────────────────────────────

async function sendDailyReportAllPanels(env) {
  const panels = await getPanels(env);
  const adminIds = await getSuperAdminIds(env);

  for (const panel of panels) {
    try {
      const status = await getServerStatus(panel);
      const clients = await listAllClients(panel);
      const obj = status?.obj || status;

      const totalClients = clients.length;
      const activeClients = clients.filter((c) => isClientEnabled(c) && !isClientExpired(c)).length;
      const expiredClients = clients.filter(isClientExpired).length;
      const depletedClients = clients.filter(isClientDepleted).length;

      const cpu = Number(obj?.cpu || obj?.cpuPercent || 0);
      const mem = Number(obj?.mem?.current || obj?.memCurrent || 0);
      const memTotal = Number(obj?.mem?.total || obj?.memTotal || 0);
      const memPercent = memTotal > 0 ? ((mem / memTotal) * 100).toFixed(1) : "0";
      const disk = Number(obj?.disk?.current || 0);
      const diskTotal = Number(obj?.disk?.total || 0);
      const diskPercent = diskTotal > 0 ? ((disk / diskTotal) * 100).toFixed(1) : "0";
      const uptime = Number(obj?.uptime || obj?.xray?.uptime || 0);

      const xrayRunning = obj?.xray?.running ?? true;
      const xrayVersion = obj?.xray?.version || "نامشخص";

      const message =
        `📊 گزارش روزانه\n\n` +
        `🖥️ سرور: ${panel.name}\n` +
        `${xrayRunning ? "✅" : "❌"} Xray: ${xrayRunning ? "فعال" : "متوقف"} (v${xrayVersion})\n` +
        `⏱️ Uptime: ${formatUptime(uptime * 1000)}\n\n` +
        `👥 کل کاربران: ${totalClients}\n` +
        `✅ فعال: ${activeClients}\n` +
        `⏰ منقضی: ${expiredClients}\n` +
        `📦 اتمام حجم: ${depletedClients}\n\n` +
        `💻 CPU: ${cpu.toFixed(1)}%\n` +
        `🧠 RAM: ${memPercent}%\n` +
        `💾 Disk: ${diskPercent}%`;

      for (const chatId of adminIds) {
        try { await sendTelegram(chatId, message, env); } catch { /* ignore */ }
      }
    } catch (error) {
      console.error(`Daily report error for ${panel.name}:`, shortError(error));
    }
  }
}

// ─── Process Pending Renewals ─────────────────────────────────

async function processPendingRenewals(env) {
  const pending = await getPendingRenewals(env);
  const adminIds = await getSuperAdminIds(env);

  for (const request of pending) {
    const notified = await kvGet(env, `${KV_RENEWAL_PREFIX}notified:${request.id}`);
    if (notified) continue;

    const panel = await resolvePanelAsync(env, request.panelId);
    const panelName = panel ? panel.name : request.panelId;

    const message =
      `🔄 درخواست تمدید جدید\n\n` +
      `👤 کاربر: ${request.clientEmail}\n` +
      `🖥️ سرور: ${panelName}\n` +
      `${request.daysRequested ? `📅 روز: +${request.daysRequested}\n` : ""}` +
      `${request.gbRequested ? `📦 حجم: +${request.gbRequested} GB\n` : ""}` +
      `🕐 زمان: ${new Date(request.createdAt).toLocaleString("fa-IR")}`;

    const buttons = [
      [
        { text: "✅ تایید", callback_data: `renewal_approve:${request.id}` },
        { text: "❌ رد", callback_data: `renewal_reject:${request.id}` },
      ],
    ];

    for (const chatId of adminIds) {
      try { await sendTelegram(chatId, message, env, buttons); } catch { /* ignore */ }
    }

    await kvPut(env, `${KV_RENEWAL_PREFIX}notified:${request.id}`, true);
  }
}

// ─── Traffic Charts (QuickChart API) ──────────────────────────
// Uses https://quickchart.io to generate chart images from URL parameters.
// No external dependencies — just build a URL and send as photo.

const QUICKCHART_BASE = "https://quickchart.io/chart";

function buildChartUrl(config) {
  return `${QUICKCHART_BASE}?c=${encodeURIComponent(JSON.stringify(config))}&backgroundColor=white`;
}

/**
 * Generate a bar chart comparing traffic across panels.
 * Returns a QuickChart URL that can be sent via sendPhoto.
 */
function buildPanelComparisonChart(panelsData) {
  // panelsData: [{ name, upGB, downGB, totalGB }]
  const labels = panelsData.map(p => p.name.slice(0, 15));
  const upData = panelsData.map(p => Number(p.upGB || 0).toFixed(2));
  const downData = panelsData.map(p => Number(p.downGB || 0).toFixed(2));

  return buildChartUrl({
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Upload (GB)", data: upData, backgroundColor: "#4CAF50" },
        { label: "Download (GB)", data: downData, backgroundColor: "#2196F3" },
      ],
    },
    options: {
      title: { display: true, text: "Traffic Comparison by Panel", fontSize: 16 },
      scales: { yAxes: [{ ticks: { beginAtZero: true } }] },
    },
  });
}

/**
 * Generate a pie chart showing used vs remaining for a single client.
 */
function buildUsagePieChart(usedGB, totalGB) {
  const remaining = Math.max(0, totalGB - usedGB);
  return buildChartUrl({
    type: "doughnut",
    data: {
      labels: ["Used", "Remaining"],
      datasets: [{
        data: [Number(usedGB.toFixed(2)), Number(remaining.toFixed(2))],
        backgroundColor: ["#f44336", "#4CAF50"],
      }],
    },
    options: {
      title: { display: true, text: "Traffic Usage", fontSize: 16 },
      plugins: {
        datalabels: {
          display: true,
          formatter: (val) => val.toFixed(1) + " GB",
        },
      },
    },
  });
}

/**
 * Handle /chart command — show traffic comparison chart across panels.
 */
async function handleChart(chatId, args, env) {
  const panels = await getPanels(env);
  const panelsData = [];

  for (const panel of panels) {
    try {
      const clients = await listAllClients(panel);
      let upGB = 0, downGB = 0;
      for (const c of clients) {
        const t = getClientTraffic(c);
        upGB += t.up / BYTES_PER_GB;
        downGB += t.down / BYTES_PER_GB;
      }
      panelsData.push({ name: panel.name, upGB, downGB });
    } catch { /* skip panel */ }
  }

  if (!panelsData.length) {
    await sendTelegramWithBack(chatId, "❌ هیچ داده‌ای برای نمایش نمودار در دسترس نیست.", env);
    return;
  }

  const chartUrl = buildPanelComparisonChart(panelsData);
  let caption = "📊 مقایسه ترافیک پنل‌ها\n\n";
  for (const p of panelsData) {
    caption += `🖥 ${p.name}: ⬆️ ${p.upGB.toFixed(2)} GB | ⬇️ ${p.downGB.toFixed(2)} GB\n`;
  }

  try {
    await sendPhoto(chatId, chartUrl, caption, env, [
      [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
    ]);
  } catch (e) {
    // Fallback: send text only
    await sendTelegramWithBack(chatId, `📊 نمودار در دسترس نیست.\n\n${caption}`, env);
  }
}

// ─── Volume Warning (90%) + Expiry Reminder (3 days) ──────────
// Runs as part of the cron job. Checks all clients across all panels
// and sends alerts when:
// - Traffic usage >= 90% of total
// - Expiry is within 3 days

const KV_VOLUME_WARN_PREFIX = "volwarn:";
const KV_EXPIRY_WARN_PREFIX = "expwarn:";

async function checkClientAlertsAllPanels(env) {
  const panels = await getPanels(env);
  const adminIds = await getSuperAdminIds(env);
  const now = Date.now();
  const THREE_DAYS_MS = 3 * MS_PER_DAY;

  for (const panel of panels) {
    try {
      const clients = await listAllClients(panel);
      for (const client of clients) {
        const identifier = getIdentifierFromClient(client);
        if (!identifier || identifier === "نامشخص") continue;

        // === Check 90% volume usage ===
        const totalBytes = getClientTotalBytes(client);
        if (totalBytes > 0) {
          const traffic = getClientTraffic(client);
          const usedBytes = traffic.up + traffic.down;
          const usagePercent = (usedBytes / totalBytes) * 100;

          if (usagePercent >= 90) {
            const warnKey = `${KV_VOLUME_WARN_PREFIX}${panel.id}:${identifier}`;
            const alreadyWarned = await kvGet(env, warnKey);
            if (!alreadyWarned) {
              const msg =
                `⚠️ هشدار حجم!\n\n` +
                `👤 کاربر: ${identifier}\n` +
                `🖥 سرور: ${panel.name}\n` +
                `📊 مصرف: ${usagePercent.toFixed(1)}%\n` +
                `📦 حجم کل: ${formatGB(totalBytes)}\n` +
                `📊 مصرف شده: ${formatGB(usedBytes)}\n` +
                `💾 باقی‌مانده: ${formatGB(Math.max(0, totalBytes - usedBytes))}`;

              for (const chatId of adminIds) {
                try { await sendTelegram(chatId, msg, env); } catch { /* ignore */ }
              }
              // Mark as warned (don't warn again until volume resets)
              await kvPut(env, warnKey, { timestamp: now, percent: usagePercent });
            }
          } else if (usagePercent < 50) {
            // Reset warning state if usage drops below 50% (e.g., after traffic reset)
            const warnKey = `${KV_VOLUME_WARN_PREFIX}${panel.id}:${identifier}`;
            const alreadyWarned = await kvGet(env, warnKey);
            if (alreadyWarned) {
              await kvDelete(env, warnKey);
            }
          }
        }

        // === Check 3-day expiry ===
        const expiry = Number(client.expiryTime ?? 0);
        if (expiry > 0) {
          const timeLeft = expiry - now;
          if (timeLeft > 0 && timeLeft <= THREE_DAYS_MS) {
            const expKey = `${KV_EXPIRY_WARN_PREFIX}${panel.id}:${identifier}`;
            const alreadyWarned = await kvGet(env, expKey);
            if (!alreadyWarned) {
              const daysLeft = Math.ceil(timeLeft / MS_PER_DAY);
              const msg =
                `⏰ یادآوری انقضا!\n\n` +
                `👤 کاربر: ${identifier}\n` +
                `🖥 سرور: ${panel.name}\n` +
                `📅 انقضا: ${formatDate(expiry)}\n` +
                `⏳ باقی‌مانده: ${daysLeft} روز\n\n` +
                `💡 لطفاً اشتراک خود را تمدید کنید.`;

              // Notify ONLY the user (not admins/super admins)
              const user = await findUserByEmail(env, identifier, panel.id);
              if (user) {
                try { await sendTelegram(user.chatId, msg, env); } catch { /* ignore */ }
              }
              await kvPut(env, expKey, { timestamp: now, expiry });
            }
          } else if (timeLeft <= 0) {
            // Expired — clear the warning state so next subscription gets warned again
            const expKey = `${KV_EXPIRY_WARN_PREFIX}${panel.id}:${identifier}`;
            const alreadyWarned = await kvGet(env, expKey);
            if (alreadyWarned) {
              await kvDelete(env, expKey);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Client alerts check error for ${panel.name}:`, shortError(error));
    }
  }
}

// ─── New User Registration Notification ───────────────────────

async function notifyAdminsNewUser(env, chatId, email, panelName) {
  const adminIds = await getSuperAdminIds(env);
  const msg =
    `👋 کاربر جدید ثبت‌نام کرد!\n\n` +
    `👤 شناسه: ${email}\n` +
    `🆔 Chat ID: ${chatId}\n` +
    `🖥 سرور: ${panelName}\n` +
    `🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;

  for (const adminId of adminIds) {
    try { await sendTelegram(adminId, msg, env); } catch { /* ignore */ }
  }
}

// ─── Visual Progress Bar ──────────────────────────────────────

function progressBar(percent, width = 15) {
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${percent.toFixed(1)}%`;
}

// ─── Multi-Language Support ───────────────────────────────────
// Supported: fa (Persian/default), en (English), zh (Chinese), ru (Russian)

const I18N = {
  fa: {
    // Menu titles
    super_admin_menu: "👑 پنل مدیریت سوپر ادمین",
    admin_menu: "🛠️ پنل مدیریت ادمین",
    user_menu: "👤 حساب کاربری",
    cf_menu: "☁️ مدیریت Cloudflare",
    select_option: "👇 انتخاب کنید:",
    // Admin buttons
    server_status: "📊 وضعیت سرورها", search_user: "🔍 جستجوی کاربر",
    user_list: "👥 لیست کاربران", create_user: "➕ ساخت کاربر جدید",
    panel_manage: "🖥️ مدیریت پنل‌ها", inbound_manage: "📦 مدیریت Inbound",
    node_manage: "🌐 مدیریت Nodes", renewals: "🔄 درخواست‌های تمدید",
    xray_manage: "⚡ مدیریت Xray", panel_restart: "🔄 ریستارت پنل",
    backup: "📦 بکاپ", export_config: "📤 خروجی کانفیگ",
    daily_report: "📊 گزارش روزانه", server_logs: "📋 لاگ سرور",
    online_users: "🟢 کاربران آنلاین", versions: "📋 نسخه‌ها",
    user_backups: "💾 بکاپ کاربران", api_tokens: "🔑 توکن‌های API",
    outbounds: "📡 Outbounds", settings: "⚙️ تنظیمات پنل",
    outbound_traffic: "📤 ترافیک Outbound", reset_inbound_traffic: "📥 ریست ترافیک Inbound",
    ban_menu: "🚫 بن/تعلیق", manage_admins: "👥 ادمین‌ها",
    error_logs: "📋 لاگ خطاها", chart_traffic: "📊 نمودار ترافیک",
    stars_payment: "⭐ پرداخت Stars",
    // User buttons
    buy_subscription: "⭐ خرید اشتراک",
    // Common
    main_menu: "🔙 منوی اصلی", back: "🔙", cancel: "❌ انصراف",
    confirm: "✅ تأیید", yes: "✅ بله", no: "❌ خیر",
    delete: "🗑 حذف", refresh: "🔄 بروزرسانی",
    language: "🌐 زبان", github: "🐙 GitHub",
    // Messages
    no_access: "⛔ دسترسی ندارید", super_only: "⛔ فقط سوپر ادمین",
    not_found: "❌ یافت نشد", error: "❌ خطا", success: "✅ موفق",
    select_server: "🖥️ سرور خود را انتخاب کنید:",
    enter_email: "📧 ایمیل/شناسه کاربری خود را وارد کنید:",
    enter_days: "📅 تعداد روز اعتبار را وارد کنید (مثلاً 30):",
    enter_gb: "📦 حجم به گیگابایت را وارد کنید (مثلاً 50 یا 0 برای نامحدود):",
    welcome: "👋 به ربات مدیریت VPN خوش آمدید!",
    reg_success: "✅ ثبت‌نام موفق!",
    reg_cancel: "🔙 شروع مجدد",
    user_created_count: "📊 کاربران ساخته‌شده",
    admin_limit: "💡 شما فقط می‌توانید کاربر بسازید، تمدید کنید یا حذف کنید.",
    admin_own_users: "💡 شما فقط به کاربرانی که خودتان ساخته‌اید دسترسی دارید.",
    // Client info
    server: "🖥 سرور", identifier: "🔹 شناسه", total: "📦 حجم کل",
    used: "📊 مصرف شده", upload: "⬆️ آپلود", download: "⬇️ دانلود",
    remaining: "💾 باقی مانده", percent: "📈 درصد مصرف",
    expiry: "📅 تاریخ انقضا", remaining_time: "⏳ باقیمانده زمان",
    status: "وضعیت", active: "🟢 فعال", expired: "⏰ منقضی",
    disabled: "⛔ غیرفعال", depleted: "📦 اتمام حجم",
    last_activity: "🟢 آخرین فعالیت",
    usage: "📊 مصرف شما", renew: "🔄 درخواست تمدید",
    support: "🎧 پشتیبانی", sub_link: "🔗 لینک اشتراک",
    backup_info: "📋 اطلاعات پشتیبان", help: "❓ راهنما",
    unlimited: "نامحدود",
    // SSH
    ssh_terminal: "🖥️ ترمینال SSH", ssh_select_server: "🖥️ سرور را انتخاب کنید:",
    ssh_enter_command: "💻 دستور را وارد کنید (مثلاً: ls -la):",
    ssh_output: "📤 خروجی:", ssh_connected: "✅ متصل شد",
    ssh_not_configured: "❌ SSH bridge برای این سرور تنظیم نشده است.",
    ssh_running: "⏳ در حال اجرا...",
  },
  en: {
    super_admin_menu: "👑 Super Admin Panel",
    admin_menu: "🛠️ Admin Panel",
    user_menu: "👤 My Account",
    cf_menu: "☁️ Cloudflare Management",
    select_option: "👇 Select:",
    server_status: "📊 Server Status", search_user: "🔍 Search User",
    user_list: "👥 User List", create_user: "➕ Create User",
    panel_manage: "🖥️ Panel Management", inbound_manage: "📦 Inbound Management",
    node_manage: "🌐 Node Management", renewals: "🔄 Renewal Requests",
    xray_manage: "⚡ Xray Management", panel_restart: "🔄 Restart Panel",
    backup: "📦 Backup", export_config: "📤 Export Config",
    daily_report: "📊 Daily Report", server_logs: "📋 Server Logs",
    online_users: "🟢 Online Users", versions: "📋 Versions",
    user_backups: "💾 User Backups", api_tokens: "🔑 API Tokens",
    outbounds: "📡 Outbounds", settings: "⚙️ Panel Settings",
    outbound_traffic: "📤 Outbound Traffic", reset_inbound_traffic: "📥 Reset Inbound Traffic",
    ban_menu: "🚫 Ban/Suspend", manage_admins: "👥 Admins",
    error_logs: "📋 Error Logs", chart_traffic: "📊 Traffic Chart",
    stars_payment: "⭐ Stars Payment",
    buy_subscription: "⭐ Buy Subscription",
    main_menu: "🔙 Main Menu", back: "🔙", cancel: "❌ Cancel",
    confirm: "✅ Confirm", yes: "✅ Yes", no: "❌ No",
    delete: "🗑 Delete", refresh: "🔄 Refresh",
    language: "🌐 Language", github: "🐙 GitHub",
    no_access: "⛔ Access denied", super_only: "⛔ Super admin only",
    not_found: "❌ Not found", error: "❌ Error", success: "✅ Success",
    select_server: "🖥️ Select your server:",
    enter_email: "📧 Enter your email/ID:",
    enter_days: "📅 Enter number of days (e.g. 30):",
    enter_gb: "📦 Enter volume in GB (e.g. 50, or 0 for unlimited):",
    welcome: "👋 Welcome to VPN Management Bot!",
    reg_success: "✅ Registration successful!",
    reg_cancel: "🔙 Restart",
    user_created_count: "📊 Users created",
    admin_limit: "💡 You can only create, renew, or delete users.",
    admin_own_users: "💡 You only have access to users you created.",
    server: "🖥 Server", identifier: "🔹 ID", total: "📦 Total",
    used: "📊 Used", upload: "⬆️ Upload", download: "⬇️ Download",
    remaining: "💾 Remaining", percent: "📈 Usage",
    expiry: "📅 Expiry", remaining_time: "⏳ Time left",
    status: "Status", active: "🟢 Active", expired: "⏰ Expired",
    disabled: "⛔ Disabled", depleted: "📦 Depleted",
    last_activity: "🟢 Last activity",
    usage: "📊 Your Usage", renew: "🔄 Request Renewal",
    support: "🎧 Support", sub_link: "🔗 Subscription Link",
    backup_info: "📋 Backup Info", help: "❓ Help",
    unlimited: "Unlimited",
    ssh_terminal: "🖥️ SSH Terminal", ssh_select_server: "🖥️ Select server:",
    ssh_enter_command: "💻 Enter command (e.g. ls -la):",
    ssh_output: "📤 Output:", ssh_connected: "✅ Connected",
    ssh_not_configured: "❌ SSH bridge not configured for this server.",
    ssh_running: "⏳ Running...",
  },
  zh: {
    super_admin_menu: "👑 超级管理员面板",
    admin_menu: "🛠️ 管理员面板",
    user_menu: "👤 我的账户",
    cf_menu: "☁️ Cloudflare 管理",
    select_option: "👇 请选择:",
    server_status: "📊 服务器状态", search_user: "🔍 搜索用户",
    user_list: "👥 用户列表", create_user: "➕ 创建用户",
    panel_manage: "🖥️ 面板管理", inbound_manage: "📦 Inbound 管理",
    node_manage: "🌐 节点管理", renewals: "🔄 续费请求",
    xray_manage: "⚡ Xray 管理", panel_restart: "🔄 重启面板",
    backup: "📦 备份", export_config: "📤 导出配置",
    daily_report: "📊 日报", server_logs: "📋 服务器日志",
    online_users: "🟢 在线用户", versions: "📋 版本",
    user_backups: "💾 用户备份", api_tokens: "🔑 API 令牌",
    outbounds: "📡 出站", settings: "⚙️ 面板设置",
    outbound_traffic: "📤 出站流量", reset_inbound_traffic: "📥 重置入站流量",
    ban_menu: "🚫 封禁/暂停", manage_admins: "👥 管理员",
    error_logs: "📋 错误日志", chart_traffic: "📊 流量图表",
    stars_payment: "⭐ Stars 支付",
    buy_subscription: "⭐ 购买订阅",
    main_menu: "🔙 主菜单", back: "🔙", cancel: "❌ 取消",
    confirm: "✅ 确认", yes: "✅ 是", no: "❌ 否",
    delete: "🗑 删除", refresh: "🔄 刷新",
    language: "🌐 语言", github: "🐙 GitHub",
    no_access: "⛔ 无权限", super_only: "⛔ 仅超级管理员",
    not_found: "❌ 未找到", error: "❌ 错误", success: "✅ 成功",
    select_server: "🖥️ 请选择您的服务器:",
    enter_email: "📧 请输入您的邮箱/标识:",
    enter_days: "📅 请输入天数 (例如 30):",
    enter_gb: "📦 请输入流量 GB (例如 50, 0 为无限):",
    welcome: "👋 欢迎使用 VPN 管理机器人!",
    reg_success: "✅ 注册成功!",
    reg_cancel: "🔙 重新开始",
    user_created_count: "📊 已创建用户",
    admin_limit: "💡 您只能创建、续费或删除用户。",
    admin_own_users: "💡 您只能访问您创建的用户。",
    server: "🖥 服务器", identifier: "🔹 标识", total: "📦 总量",
    used: "📊 已用", upload: "⬆️ 上传", download: "⬇️ 下载",
    remaining: "💾 剩余", percent: "📈 使用率",
    expiry: "📅 到期", remaining_time: "⏳ 剩余时间",
    status: "状态", active: "🟢 活跃", expired: "⏰ 已过期",
    disabled: "⛔ 已禁用", depleted: "📦 已耗尽",
    last_activity: "🟢 最后活动",
    usage: "📊 您的用量", renew: "🔄 请求续费",
    support: "🎧 支持", sub_link: "🔗 订阅链接",
    backup_info: "📋 备份信息", help: "❓ 帮助",
    unlimited: "无限",
    ssh_terminal: "🖥️ SSH 终端", ssh_select_server: "🖥️ 选择服务器:",
    ssh_enter_command: "💻 输入命令 (例如 ls -la):",
    ssh_output: "📤 输出:", ssh_connected: "✅ 已连接",
    ssh_not_configured: "❌ 此服务器未配置 SSH 桥接。",
    ssh_running: "⏳ 运行中...",
  },
  ru: {
    super_admin_menu: "👑 Панель супер-админа",
    admin_menu: "🛠️ Панель админа",
    user_menu: "👤 Мой аккаунт",
    cf_menu: "☁️ Управление Cloudflare",
    select_option: "👇 Выберите:",
    server_status: "📊 Статус серверов", search_user: "🔍 Поиск пользователя",
    user_list: "👥 Список пользователей", create_user: "➕ Создать пользователя",
    panel_manage: "🖥️ Управление панелями", inbound_manage: "📦 Управление Inbound",
    node_manage: "🌐 Управление узлами", renewals: "🔄 Запросы продления",
    xray_manage: "⚡ Управление Xray", panel_restart: "🔄 Перезапуск панели",
    backup: "📦 Резервная копия", export_config: "📤 Экспорт конфиг",
    daily_report: "📊 Ежедневный отчёт", server_logs: "📋 Логи сервера",
    online_users: "🟢 Онлайн пользователи", versions: "📋 Версии",
    user_backups: "💾 Резервные копии", api_tokens: "🔑 API токены",
    outbounds: "📡 Outbounds", settings: "⚙️ Настройки панели",
    outbound_traffic: "📤 Трафик Outbound", reset_inbound_traffic: "📥 Сброс Inbound трафика",
    ban_menu: "🚫 Бан/Приостановка", manage_admins: "👥 Админы",
    error_logs: "📋 Логи ошибок", chart_traffic: "📊 График трафика",
    stars_payment: "⭐ Оплата Stars",
    buy_subscription: "⭐ Купить подписку",
    main_menu: "🔙 Главное меню", back: "🔙", cancel: "❌ Отмена",
    confirm: "✅ Подтвердить", yes: "✅ Да", no: "❌ Нет",
    delete: "🗑 Удалить", refresh: "🔄 Обновить",
    language: "🌐 Язык", github: "🐙 GitHub",
    no_access: "⛔ Нет доступа", super_only: "⛔ Только супер-админ",
    not_found: "❌ Не найдено", error: "❌ Ошибка", success: "✅ Успешно",
    select_server: "🖥️ Выберите ваш сервер:",
    enter_email: "📧 Введите ваш email/ID:",
    enter_days: "📅 Введите количество дней (напр. 30):",
    enter_gb: "📦 Введите объём в ГБ (напр. 50, 0 для безлимита):",
    welcome: "👋 Добро пожаловать в бот управления VPN!",
    reg_success: "✅ Регистрация успешна!",
    reg_cancel: "🔙 Начать заново",
    user_created_count: "📊 Создано пользователей",
    admin_limit: "💡 Вы можете только создавать, продлевать или удалять пользователей.",
    admin_own_users: "💡 Вы имеете доступ только к созданным вами пользователям.",
    server: "🖥 Сервер", identifier: "🔹 ID", total: "📦 Всего",
    used: "📊 Использовано", upload: "⬆️ Загрузка", download: "⬇️ Скачивание",
    remaining: "💾 Остаток", percent: "📈 Использование",
    expiry: "📅 Истечение", remaining_time: "⏳ Осталось времени",
    status: "Статус", active: "🟢 Активен", expired: "⏰ Истёк",
    disabled: "⛔ Отключён", depleted: "📦 Исчерпан",
    last_activity: "🟢 Последняя активность",
    usage: "📊 Ваше использование", renew: "🔄 Запрос продления",
    support: "🎧 Поддержка", sub_link: "🔗 Ссылка подписки",
    backup_info: "📋 Информация о резервной копии", help: "❓ Помощь",
    unlimited: "Безлимит",
    ssh_terminal: "🖥️ SSH терминал", ssh_select_server: "🖥️ Выберите сервер:",
    ssh_enter_command: "💻 Введите команду (напр. ls -la):",
    ssh_output: "📤 Вывод:", ssh_connected: "✅ Подключено",
    ssh_not_configured: "❌ SSH мост не настроен для этого сервера.",
    ssh_running: "⏳ Выполнение...",
  },
};

function t(lang, key) {
  const l = I18N[lang] || I18N.fa;
  return l[key] || I18N.fa[key] || key;
}

async function getUserLang(env, chatId) {
  const user = await getUser(env, chatId);
  if (user?.language) return user.language;
  // For admins who aren't registered users, check KV
  const adminLang = await kvGet(env, `lang:${chatId}`);
  return adminLang || "fa";
}

async function setUserLang(env, chatId, lang) {
  const user = await getUser(env, chatId);
  if (user) {
    user.language = lang;
    await kvPut(env, `${KV_USERS_PREFIX}${chatId}`, user);
  } else {
    // For admins who aren't registered users
    await kvPut(env, `lang:${chatId}`, lang);
  }
}

// ─── Telegram Stars Payment ───────────────────────────────────
// Allows panel admins to pay super admins using Telegram Stars (XTR).
// Super admin sets up payment plans; panel admins can buy credits.

const KV_STARS_PLANS = "stars:plans";
const KV_STARS_PAYMENTS = "stars:payments";

async function getStarsPlans(env) {
  return (await kvGet(env, KV_STARS_PLANS)) || [];
}

async function saveStarsPlans(env, plans) {
  await kvPut(env, KV_STARS_PLANS, plans);
}

async function recordStarsPayment(env, payment) {
  const payments = (await kvGet(env, KV_STARS_PAYMENTS)) || [];
  payments.unshift(payment);
  if (payments.length > 100) payments.length = 100;
  await kvPut(env, KV_STARS_PAYMENTS, payments);
}

async function getStarsPayments(env) {
  return (await kvGet(env, KV_STARS_PAYMENTS)) || [];
}

/**
 * Send a Telegram Stars invoice.
 * Telegram Stars uses currency="XTR" and provider_token="" (empty).
 */
async function sendStarsInvoice(chatId, title, description, prices, payload, env, photoUrl = null) {
  const token = getBotToken(env);
  const payload_data = {
    chat_id: String(chatId),
    title: String(title).slice(0, 32),
    description: String(description).slice(0, 255),
    payload: JSON.stringify(payload),
    currency: "XTR",
    prices: prices, // [{ label, amount }] — amount in Stars (integer)
  };
  // provider_token must be empty for Stars payments
  payload_data.provider_token = "";
  if (photoUrl) payload_data.photo_url = photoUrl;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendInvoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload_data),
  });
  return assertOk(response, "sendInvoice");
}

/**
 * Super admin: manage Stars payment plans.
 * Plans are stored as: [{ id, name, stars, description }]
 */
async function handleStarsMenu(chatId, env) {
  const plans = await getStarsPlans(env);
  let msg = "⭐ مدیریت پرداخت Stars\n\n";
  if (plans.length) {
    msg += "📋 طرح‌های موجود:\n";
    for (const p of plans) {
      msg += `• ${p.name}: ${p.stars} Stars — ${p.description || ""}\n`;
    }
  } else {
    msg += "❌ هیچ طرحی تعریف نشده است.\n";
  }
  msg += "\n👇 انتخاب کنید:";

  const buttons = [
    [{ text: "➕ افزودن طرح", callback_data: "stars_add" }],
    [{ text: "📋 لیست پرداخت‌ها", callback_data: "stars_payments" }],
    [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
  ];
  await sendTelegram(chatId, msg, env, buttons);
}

/**
 * Show available plans for panel admins to buy.
 */
async function handleStarsBuy(chatId, env) {
  const plans = await getStarsPlans(env);
  if (!plans.length) {
    await sendTelegramWithBack(chatId, "❌ هیچ طرح پرداختی در دسترس نیست.", env);
    return;
  }
  const isAdmin = await isAdminAsync(chatId, env);
  const backTarget = isAdmin ? "admin_back" : "user_back";
  let msg = "⭐ خرید اشتراک\n\n💡 با Stars تلگرام پرداخت کنید:\n";
  const buttons = plans.map(p => [{
    text: `${p.name} — ${p.stars}⭐`,
    callback_data: `stars_buy:${p.id}`,
  }]);
  buttons.push([{ text: "🔙 منوی اصلی", callback_data: backTarget }]);
  await sendTelegram(chatId, msg, env, buttons);
}

// ─── SSH Terminal Module (using ssh-bridge.js with context detection) ───
// Uses ssh-bridge.js deployed on each server to execute commands.
// The bridge detects interactive prompts (apt dialogs, confirm dialogs, etc.)
// and returns suggested buttons so the admin can respond without getting stuck.
//
// Panel config fields:
//   sshBridgeUrl: "http://YOUR_SERVER:8022"
//   sshBridgeToken: "YOUR_BRIDGE_TOKEN"

async function executeSshCommand(panel, command, env) {
  const bridgeUrl = panel.sshBridgeUrl || env?.SSH_BRIDGE_URL;
  const bridgeToken = panel.sshBridgeToken || env?.SSH_BRIDGE_TOKEN;
  if (!bridgeUrl) {
    throw new Error("SSH bridge not configured. Set sshBridgeUrl in panel config or SSH_BRIDGE_URL env var.");
  }

  const response = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: bridgeToken || "", command }),
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { output: text }; }

  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (data.error) throw new Error(data.error);

  return data;
}

/**
 * Send input to an SSH session (for interactive commands).
 * The bridge re-runs the command with the input piped in.
 */
async function sendSshInput(panel, sessionId, input, env) {
  const bridgeUrl = panel.sshBridgeUrl || env?.SSH_BRIDGE_URL;
  const bridgeToken = panel.sshBridgeToken || env?.SSH_BRIDGE_TOKEN;
  if (!bridgeUrl) throw new Error("SSH bridge not configured");

  const response = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: bridgeToken || "", sessionId, input }),
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { output: text }; }

  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (data.error) throw new Error(data.error);

  return data;
}

/**
 * Build Telegram buttons from SSH bridge's suggested buttons.
 * Returns an array of button rows.
 */
function buildSshButtons(suggestedButtons, sessionId, panelId, lang) {
  if (!suggestedButtons || !suggestedButtons.length) {
    // Default buttons when no context detected
    return [
      [
        { text: "⏎ Enter", callback_data: `act:${0}` },
        { text: "Y + ⏎", callback_data: `act:${1}` },
        { text: "N + ⏎", callback_data: `act:${2}` },
      ],
      [
        { text: "⌨️ New Command", callback_data: `ssh_panel:${panelId}` },
        { text: "📋 Quick", callback_data: `ssh_quick:${panelId}` },
      ],
      [{ text: t(lang, "main_menu"), callback_data: "admin_back" }],
    ];
  }

  // Build buttons from suggested inputs (max 3 per row)
  const buttons = [];
  for (let i = 0; i < suggestedButtons.length; i += 3) {
    const row = [];
    for (let j = i; j < Math.min(i + 3, suggestedButtons.length); j++) {
      // Use action token for each button
      // We'll store the input and sessionId in the action
      row.push({
        text: suggestedButtons[j].label,
        callback_data: `act:__placeholder__`, // Will be replaced below
      });
    }
    buttons.push(row);
  }
  buttons.push([
    { text: "⌨️ New Command", callback_data: `ssh_panel:${panelId}` },
    { text: "📋 Quick", callback_data: `ssh_quick:${panelId}` },
  ]);
  buttons.push([{ text: t(lang, "main_menu"), callback_data: "admin_back" }]);

  return buttons;
}

async function sendSshServerSelect(chatId, env, lang = "fa") {
  const panels = await getPanels(env);
  const L = (k) => t(lang, k);
  const buttons = [];
  for (const p of panels) {
    if (p.sshBridgeUrl || env?.SSH_BRIDGE_URL) {
      buttons.push([{ text: `🖥 ${p.name}`, callback_data: `ssh_panel:${p.id}` }]);
    }
  }
  if (!buttons.length) {
    await sendTelegram(chatId,
      t(lang, "ssh_not_configured") +
      "\n\n💡 Setup:\n1. Copy ssh-bridge.js to your server\n2. Run: node ssh-bridge.js\n3. Set sshBridgeUrl in panel config", env, [
      [{ text: L("main_menu"), callback_data: "admin_back" }],
    ]);
    return;
  }
  buttons.push([{ text: L("main_menu"), callback_data: "admin_back" }]);
  await sendTelegram(chatId, L("ssh_select_server"), env, buttons);
}

async function handleSsh(chatId, args, env) {
  const lang = await getUserLang(env, chatId);
  await sendSshServerSelect(chatId, env, lang);
}

// ─── HTTP API ─────────────────────────────────────────────────

async function handleUsageAPI(url, env) {
  const email = url.searchParams.get("email");
  if (!email) {
    return new Response(JSON.stringify({ error: "email parameter required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const results = await searchClientAcrossPanels(email, env);
    if (!results.length) {
      return new Response(JSON.stringify({ error: "Client not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = results.map(({ panel, client }) => {
      const traffic = getClientTraffic(client);
      const totalBytes = getClientTotalBytes(client);
      const usedBytes = traffic.up + traffic.down;
      const remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0;
      const expiry = Number(client.expiryTime ?? 0);

      return {
        panel: panel.name,
        panelId: panel.id,
        identifier: getIdentifierFromClient(client),
        totalGB: totalBytes > 0 ? totalBytes / BYTES_PER_GB : null,
        usedGB: usedBytes / BYTES_PER_GB,
        remainingGB: totalBytes > 0 ? remainingBytes / BYTES_PER_GB : null,
        uploadGB: traffic.up / BYTES_PER_GB,
        downloadGB: traffic.down / BYTES_PER_GB,
        expiryTime: expiry > 0 ? new Date(expiry).toISOString() : null,
        enabled: isClientEnabled(client),
        expired: isClientExpired(client),
        depleted: isClientDepleted(client),
      };
    });

    return new Response(JSON.stringify({ clients: data }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: shortError(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── Cloudflare API Module ────────────────────────────────────
// Allows super admins to manage DNS records on their Cloudflare
// account directly from Telegram. Token is read from env.CLOUDFLARE_API_TOKEN
// (set via `wrangler secret put CLOUDFLARE_API_TOKEN`).

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

function getCfToken(env) {
  return String(env?.CLOUDFLARE_API_TOKEN || "").trim();
}

async function cfApi(env, path, method = "GET", body = null) {
  const token = getCfToken(env);
  if (!token) {
    throw new Error("CLOUDFLARE_API_TOKEN تنظیم نشده است. با `wrangler secret put CLOUDFLARE_API_TOKEN` آن را اضافه کنید.");
  }
  const url = path.startsWith("http") ? path : `${CF_API_BASE}${path}`;
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const options = { method, headers };
  if (body !== null && method !== "GET") options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!response.ok) {
    const errs = data?.errors || [];
    const errMsg = errs.length
      ? errs.map(e => `${e.code}: ${e.message}`).join("; ")
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare API: ${errMsg}`);
  }
  if (data && data.success === false) {
    const errs = data?.errors || [];
    throw new Error(`Cloudflare: ${errs.map(e => e.message).join("; ") || "unknown error"}`);
  }
  return data?.result ?? data;
}

// ─── Cloudflare: Zones ────────────────────────────────────────

async function cfListZones(env) {
  // CF returns paginated zones — fetch first 50 (enough for most users)
  const result = await cfApi(env, `/zones?per_page=50`, "GET");
  return Array.isArray(result) ? result : [];
}

async function cfGetZone(env, zoneId) {
  return await cfApi(env, `/zones/${encodeURIComponent(zoneId)}`, "GET");
}

// ─── Cloudflare: DNS Records ──────────────────────────────────

async function cfListDnsRecords(env, zoneId) {
  const result = await cfApi(env, `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100`, "GET");
  return Array.isArray(result) ? result : [];
}

async function cfCreateDnsRecord(env, zoneId, payload) {
  // payload: { type, name, content, ttl, proxied, priority }
  return await cfApi(env, `/zones/${encodeURIComponent(zoneId)}/dns_records`, "POST", payload);
}

async function cfUpdateDnsRecord(env, zoneId, recordId, payload) {
  return await cfApi(env, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, "PUT", payload);
}

async function cfDeleteDnsRecord(env, zoneId, recordId) {
  return await cfApi(env, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, "DELETE");
}

// ─── Cloudflare: Formatting ───────────────────────────────────

function formatCfZone(zone, lang = "fa") {
  if (!zone) return lang === "en" ? "Zone not found" : "دامنه یافت نشد";
  const status = zone.status === "active"
    ? (lang === "en" ? "🟢 Active" : "🟢 فعال")
    : (lang === "en" ? "⏳ Pending" : "⏳ در انتظار");
  const lines = lang === "en"
    ? [
        `🌐 Zone: ${zone.name}`,
        `🆔 ID: ${zone.id}`,
        `${status}`,
        `👤 Account: ${zone.account?.name || "—"}`,
        ``,
        `📊 Statistics:`,
        `   Records: ${zone.meta?.record_count ?? "?"}`,
      ]
    : [
        `🌐 دامنه: ${zone.name}`,
        `🆔 شناسه: ${zone.id}`,
        `${status}`,
        `👤 اکانت: ${zone.account?.name || "—"}`,
        ``,
        `📊 آمار:`,
        `   رکوردها: ${zone.meta?.record_count ?? "?"}`,
      ];
  return lines.join("\n");
}

function formatCfDnsRecord(rec, lang = "fa") {
  if (!rec) return lang === "en" ? "Record not found" : "رکورد یافت نشد";
  const proxied = rec.proxied
    ? (lang === "en" ? "🟠 Proxied" : "🟠 پروکسی")
    : (lang === "en" ? "⚪ DNS Only" : "⚪ فقط DNS");
  const ttl = rec.ttl === 1
    ? (lang === "en" ? "Auto" : "خودکار")
    : `${rec.ttl}s`;
  return [
    `${lang === "en" ? "🆔 ID" : "🆔 شناسه"}: ${rec.id}`,
    `${lang === "en" ? "🏷 Type" : "🏷 نوع"}: ${rec.type}`,
    `${lang === "en" ? "📛 Name" : "📛 نام"}: ${rec.name}`,
    `${lang === "en" ? "📄 Content" : "📄 محتوا"}: ${rec.content}`,
    `${proxied} | TTL: ${ttl}`,
  ].join("\n");
}

// ─── Cloudflare: Menu Rendering ───────────────────────────────

/**
 * Create a short callback_data for Cloudflare actions that would otherwise
 * exceed Telegram's 64-byte limit.
 *
 * Cloudflare zone IDs are 32-char hex strings, and DNS record IDs are also
 * 32-char hex strings. Combined with the action prefix, callbacks like
 * `cf_dns_toggle:ZONE_ID:RECORD_ID` reach 79 bytes — well over the limit.
 *
 * This function stores the full callback_data in BOT_STATE (via setAction)
 * and returns a short `act:TOKEN` that fits within the limit.
 *
 * Usage:
 *   const cb = await cfCallback(chatId, "cf_dns_toggle", zoneId, recordId, env);
 *   // cb = "act:abc12345" (12 bytes, well under 64)
 */
async function cfCallback(chatId, action, zoneId, recordId, env) {
  // Store as a CF action with zoneId:recordId as the identifier
  // Use "cf_zone" as the panelId so the act: handler knows it's a CF action
  const token = await setAction(chatId, action, `${zoneId}:${recordId}`, env, "cf_zone");
  return `act:${token}`;
}

async function sendCfMainMenu(chatId, env, lang = "fa") {
  const isFa = lang !== "en";
  const menuText = isFa
    ? "☁️ مدیریت Cloudflare\n\n👇 انتخاب کنید:"
    : "☁️ Cloudflare Management\n\n👇 Select:";
  const buttons = [
    [
      { text: isFa ? "🌐 دامنه‌ها (Zones)" : "🌐 Zones",
        callback_data: "cf_zones" },
    ],
    [
      { text: isFa ? "➕ افزودن DNS Record" : "➕ Add DNS Record",
        callback_data: "cf_dns_add_zone" },
    ],
    [
      { text: isFa ? "🌍 تعویض زبان" : "🌍 Switch Language",
        callback_data: "cf_toggle_lang" },
    ],
    [
      { text: isFa ? "🔙 منوی اصلی" : "🔙 Main Menu",
        callback_data: "admin_back" },
    ],
  ];
  await sendTelegram(chatId, menuText, env, buttons);
}

async function sendCfZonesList(chatId, env, lang = "fa") {
  const isFa = lang !== "en";
  try {
    const zones = await cfListZones(env);
    if (!zones.length) {
      await sendTelegram(chatId,
        isFa ? "❌ هیچ دامنه‌ای در اکانت Cloudflare شما یافت نشد." : "❌ No zones found in your Cloudflare account.",
        env,
        [[{ text: isFa ? "🔙" : "🔙", callback_data: "cf_back" }]]
      );
      return;
    }
    let msg = isFa
      ? `🌐 دامنه‌های شما (${zones.length}):\n\n`
      : `🌐 Your zones (${zones.length}):\n\n`;
    for (const z of zones.slice(0, 30)) {
      const icon = z.status === "active" ? "🟢" : "⏳";
      msg += `${icon} ${z.name}\n`;
    }
    if (zones.length > 30) {
      msg += isFa ? `\n... و ${zones.length - 30} دامنه دیگر` : `\n... and ${zones.length - 30} more`;
    }
    msg += `\n\n${isFa ? "👇 یک دامنه را برای مدیریت DNS انتخاب کنید:" : "👇 Select a zone to manage DNS:"}`;

    const buttons = zones.slice(0, 30).map(z => [{
      text: `${z.status === "active" ? "🟢" : "⏳"} ${z.name}`,
      callback_data: `cf_zone:${z.id}`,
    }]);
    buttons.push([{ text: isFa ? "🔙 منوی Cloudflare" : "🔙 CF Menu", callback_data: "cf_back" }]);

    await sendTelegram(chatId, msg, env, buttons);
  } catch (error) {
    await sendTelegram(chatId, `❌ ${shortError(error)}`, env,
      [[{ text: isFa ? "🔙" : "🔙", callback_data: "cf_back" }]]
    );
  }
}

async function sendCfZoneDnsRecords(chatId, env, zoneId, lang = "fa", page = 1) {
  const isFa = lang !== "en";
  try {
    const [zone, records] = await Promise.all([
      cfGetZone(env, zoneId).catch(() => null),
      cfListDnsRecords(env, zoneId),
    ]);
    const zoneName = zone?.name || zoneId;
    if (!records.length) {
      await sendTelegram(chatId,
        isFa ? `❌ هیچ رکورد DNS برای "${zoneName}" یافت نشد.` : `❌ No DNS records for "${zoneName}".`,
        env,
        [
          [{ text: isFa ? "➕ افزودن رکورد" : "➕ Add Record", callback_data: `cf_dns_add_type:${zoneId}` }],
          [{ text: isFa ? "🔙 دامنه‌ها" : "🔙 Zones", callback_data: "cf_zones" }],
        ]
      );
      return;
    }

    const perPage = 15;
    const start = (page - 1) * perPage;
    const pageRecords = records.slice(start, start + perPage);
    const totalPages = Math.ceil(records.length / perPage);

    let msg = isFa
      ? `📋 رکوردهای DNS "${zoneName}" (صفحه ${page}/${totalPages}):\n\n`
      : `📋 DNS Records for "${zoneName}" (page ${page}/${totalPages}):\n\n`;
    for (const r of pageRecords) {
      const proxyIcon = r.proxied ? "🟠" : "⚪";
      msg += `${proxyIcon} ${r.type} | ${r.name} → ${r.content.slice(0, 50)}\n`;
    }

    const buttons = [];
    for (const r of pageRecords.slice(0, 15)) {
      buttons.push([{
        text: `${r.proxied ? "🟠" : "⚪"} ${r.type}: ${r.name.slice(0, 30)}`,
        callback_data: await cfCallback(chatId, "cf_dns", zoneId, r.id, env),
      }]);
    }
    // Pagination
    const navBtns = [];
    if (page > 1) navBtns.push({ text: "◀", callback_data: `cf_dns_page:${zoneId}:${page - 1}` });
    if (page < totalPages) navBtns.push({ text: "▶", callback_data: `cf_dns_page:${zoneId}:${page + 1}` });
    if (navBtns.length) buttons.push(navBtns);
    buttons.push([{ text: isFa ? "➕ افزودن رکورد" : "➕ Add Record", callback_data: `cf_dns_add_type:${zoneId}` }]);
    buttons.push([{ text: isFa ? "🔙 دامنه‌ها" : "🔙 Zones", callback_data: "cf_zones" }]);

    await sendTelegram(chatId, msg, env, buttons);
  } catch (error) {
    await sendTelegram(chatId, `❌ ${shortError(error)}`, env,
      [[{ text: isFa ? "🔙" : "🔙", callback_data: "cf_zones" }]]
    );
  }
}

async function sendCfDnsRecordDetail(chatId, env, zoneId, recordId, lang = "fa") {
  const isFa = lang !== "en";
  try {
    const [zone, records] = await Promise.all([
      cfGetZone(env, zoneId).catch(() => null),
      cfListDnsRecords(env, zoneId),
    ]);
    const record = records.find(r => r.id === recordId);
    if (!record) {
      await sendTelegram(chatId,
        isFa ? "❌ رکورد یافت نشد." : "❌ Record not found.",
        env,
        [[{ text: isFa ? "🔙" : "🔙", callback_data: `cf_zone:${zoneId}` }]]
      );
      return;
    }
    const msg = formatCfDnsRecord(record, lang) +
      `\n\n${isFa ? `🌐 دامنه: ${zone?.name || zoneId}` : `🌐 Zone: ${zone?.name || zoneId}`}`;
    // Use action tokens for toggle/delete — callback_data would exceed 64 bytes
    // because CF zone IDs and record IDs are both 32-char hex strings.
    const toggleCb = await cfCallback(chatId, "cf_dns_toggle", zoneId, recordId, env);
    const delCb = await cfCallback(chatId, "cf_dns_del_confirm", zoneId, recordId, env);
    const buttons = [
      [
        { text: record.proxied
            ? (isFa ? "⚪ غیرفعال‌کردن پروکسی" : "⚪ Disable Proxy")
            : (isFa ? "🟠 فعال‌کردن پروکسی" : "🟠 Enable Proxy"),
          callback_data: toggleCb },
      ],
      [
        { text: isFa ? "🗑 حذف رکورد" : "🗑 Delete Record",
          callback_data: delCb },
      ],
      [
        { text: isFa ? "🔙 رکوردها" : "🔙 Records", callback_data: `cf_zone:${zoneId}` },
      ],
    ];
    await sendTelegram(chatId, msg, env, buttons);
  } catch (error) {
    await sendTelegram(chatId, `❌ ${shortError(error)}`, env,
      [[{ text: isFa ? "🔙" : "🔙", callback_data: `cf_zone:${zoneId}` }]]
    );
  }
}

// ─── Telegram Update Handler ──────────────────────────────────

async function handleTelegramUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
      return;
    }

    // Handle Telegram Stars pre-checkout query (must respond within 10 seconds)
    if (update.pre_checkout_query) {
      const token = getBotToken(env);
      try {
        await fetch(`https://api.telegram.org/bot${token}/answerPreCheckoutQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pre_checkout_query_id: update.pre_checkout_query.id,
            ok: true,
          }),
        });
      } catch (e) {
        console.error("answerPreCheckoutQuery error:", shortError(e));
      }
      return;
    }

    // Handle successful Stars payment
    if (update.message?.successful_payment) {
      const payment = update.message.successful_payment;
      const chatId = String(update.message.chat.id);
      try {
        const payload = JSON.parse(payment.invoice_payload || "{}");
        if (payload.type === "stars_payment") {
          // Record the payment
          await recordStarsPayment(env, {
            chatId,
            stars: payload.stars || payment.total_amount || 0,
            planId: payload.planId,
            planName: payload.planName,
            currency: payment.currency,
            timestamp: Date.now(),
          });

          // Notify all super admins about the payment
          const adminIds = await getSuperAdminIds(env);
          const msg =
            `⭐ پرداخت Stars دریافت شد!\n\n` +
            `👤 از: ${chatId}\n` +
            `📋 طرح: ${payload.planName || "نامشخص"}\n` +
            `⭐ مبلغ: ${payload.stars || payment.total_amount} Stars\n` +
            `🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
          for (const adminId of adminIds) {
            try { await sendTelegram(adminId, msg, env); } catch { /* ignore */ }
          }

          // Confirm to payer
          await sendTelegram(chatId,
            `✅ پرداخت شما با موفقیت ثبت شد!\n\n⭐ ${payload.stars || payment.total_amount} Stars\n📋 ${payload.planName || ""}`, env);
        }
      } catch (e) {
        console.error("Payment processing error:", shortError(e));
      }
      return;
    }

    const message = update.message;
    if (!message) return;

    const chatId = String(message.chat.id);
    const text = String(message.text || "").trim();
    const fromId = String(message.from?.id || chatId);

    // Check ban (admins exempt)
    const isAdminUser = await isAdminAsync(chatId, env);
    if (!isAdminUser) {
      const ban = await isUserBanned(env, chatId);
      if (ban) {
        const banMsg = `🚫 بن شده‌اید.\n${ban.reason ? `📝 ${ban.reason}\n` : ""}🕐 ${new Date(ban.bannedAt).toLocaleString("fa-IR")}`;
        await sendTelegram(chatId, banMsg, env); return;
      }
      const susp = await isUserSuspended(env, chatId);
      if (susp) {
        const rem = Math.ceil((susp.until - Date.now()) / 60000);
        const suspMsg = `⏸ تعلیق موقت.\n${susp.reason ? `📝 ${susp.reason}\n` : ""}⏳ ${rem} دقیقه`;
        await sendTelegram(chatId, suspMsg, env); return;
      }
    }

    // Handle /start
    if (text === "/start") {
      await handleStart(chatId, fromId, env);
      return;
    }

    // Check registration flow state
    const regState = await stateGet(env, `${STATE_REG_PREFIX}${chatId}`);
    if (regState) {
      await handleRegistrationStep(chatId, regState, text, env);
      return;
    }

    // Check add panel flow state
    const addPanelState = await stateGet(env, `${STATE_ADDPANEL_PREFIX}${chatId}`);
    if (addPanelState) {
      await handleAddPanelStep(chatId, addPanelState, text, env);
      return;
    }

    // Check renewal amount input state (user renewal request)
    const renewState = await stateGet(env, `${STATE_RENEW_PREFIX}${chatId}`);
    if (renewState) {
      await handleRenewalAmountInput(chatId, renewState, text, env);
      return;
    }

    // Determine admin status early (needed for action state checks)
    const admin = await isAdminAsync(chatId, env);

    // Check admin addgb action state (from inline button)
    const addgbState = await stateGet(env, `addgb_action:${chatId}`);
    if (addgbState) {
      await stateDelete(env, `addgb_action:${chatId}`);
      if (!admin) {
        await sendTelegramWithBack(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      const gb = Number(text);
      if (isNaN(gb) || gb <= 0) {
        await sendTelegram(chatId, "❌ مقدار نامعتبر. لطفاً عدد معتبر وارد کنید:", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        return;
      }
      const panel = await resolvePanelAsync(env, addgbState.panelId);
      const client = await getClientByIdentifier(addgbState.identifier, env, addgbState.panelId);
      if (!panel || !client) {
        await sendTelegram(chatId, "❌ کاربر یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        return;
      }
      try {
        await addGBToClient(panel, client, gb);
        const updated = await getClientByIdentifier(addgbState.identifier, env, addgbState.panelId);
        const msg = `✅ ${gb} GB حجم اضافه شد.\n\n${updated ? formatClient(updated, panel) : ""}`;
        const buttons = updated ? await buildAdminClientButtons(chatId, updated, panel, env) : [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]];
        await sendTelegram(chatId, msg, env, buttons);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      }
      return;
    }

    // Check admin renew action state (from inline button)
    const renewActionState = await stateGet(env, `renew_action:${chatId}`);
    if (renewActionState) {
      await stateDelete(env, `renew_action:${chatId}`);
      if (!admin) {
        await sendTelegramWithBack(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      const days = Number(text);
      if (isNaN(days) || days <= 0) {
        await sendTelegram(chatId, "❌ مقدار نامعتبر. لطفاً عدد معتبر وارد کنید:", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        return;
      }
      const panel = await resolvePanelAsync(env, renewActionState.panelId);
      const client = await getClientByIdentifier(renewActionState.identifier, env, renewActionState.panelId);
      if (!panel || !client) {
        await sendTelegram(chatId, "❌ کاربر یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        return;
      }
      try {
        await addDaysToClient(panel, client, days);
        const updated = await getClientByIdentifier(renewActionState.identifier, env, renewActionState.panelId);
        const msg = `✅ ${days} روز تمدید شد.\n\n${updated ? formatClient(updated, panel) : ""}`;
        const buttons = updated ? await buildAdminClientButtons(chatId, updated, panel, env) : [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]];
        await sendTelegram(chatId, msg, env, buttons);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      }
      return;
    }

    // Check admin search action state (from interactive menu)
    const searchState = await stateGet(env, `search_action:${chatId}`);
    if (searchState) {
      await stateDelete(env, `search_action:${chatId}`);
      if (!admin) {
        await sendTelegramWithBack(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      const identifier = normalizeIdentifier(text);
      if (!identifier) {
        await sendTelegram(chatId, "❌ شناسه نامعتبر.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        return;
      }
      await handleSearch(chatId, [identifier], env);
      return;
    }

    // Check admin create user action state (from interactive menu)
    const createAction = await stateGet(env, `create_action:${chatId}`);
    if (createAction) {
      if (!admin) {
        await stateDelete(env, `create_action:${chatId}`);
        await sendTelegramWithBack(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      if (createAction.step === "email") {
        createAction.email = normalizeIdentifier(text);
        createAction.step = "days";
        await statePut(env, `create_action:${chatId}`, createAction, MS_PER_HOUR);
        await sendTelegram(chatId, `📅 تعداد روز اعتبار را وارد کنید (مثلاً 30):`, env, [
          [{ text: "❌ انصراف", callback_data: "admin_back" }],
        ]);
        return;
      }
      if (createAction.step === "days") {
        const days = Number(text);
        if (isNaN(days) || days <= 0) {
          await sendTelegramWithBack(chatId, "❌ مقدار نامعتبر. تعداد روز را وارد کنید:", env);
          return;
        }
        createAction.days = days;
        createAction.step = "gb";
        await statePut(env, `create_action:${chatId}`, createAction, MS_PER_HOUR);
        await sendTelegram(chatId, `📦 حجم به گیگابایت را وارد کنید (مثلاً 50 یا 0 برای نامحدود):`, env, [
          [{ text: "❌ انصراف", callback_data: "admin_back" }],
        ]);
        return;
      }
      if (createAction.step === "gb") {
        const gb = Number(text) || 0;
        await stateDelete(env, `create_action:${chatId}`);
        try {
          const panel = await resolvePanelAsync(env, createAction.panelId);
          if (!panel) {
            await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
              [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
            ]);
            return;
          }

          // Check maxUsers and maxTrafficGB limits for panel admins (interactive flow)
          const role = await getAdminRole(env, chatId);
          if (role && role.role === "admin") {
            const cnt = await getAdminCreatedCount(env, chatId);
            const mx = role.maxUsers || 0;
            if (mx > 0 && cnt >= mx) {
              await sendTelegram(chatId, `❌ محدودیت ساخت کاربر رسید (${cnt}/${mx}).\n💡 برای افزایش محدودیت با سوپر ادمین تماس بگیرید.`, env, [
                [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
              ]);
              return;
            }
            // Check maxTrafficGB limit
            const maxTraffic = role.maxTrafficGB || 0;
            if (maxTraffic > 0) {
              const usedTrafficGB = await getAdminCreatedTrafficGB(env, chatId);
              const newClientTrafficGB = (gb > 0 ? gb : 0); // The new client's allocated volume
              if (usedTrafficGB + newClientTrafficGB > maxTraffic) {
                await sendTelegram(chatId,
                  `❌ محدودیت حجم رسید!\n\n` +
                  `📊 حجم مصرفی کاربران شما: ${usedTrafficGB.toFixed(2)} GB\n` +
                  `📦 حجم جدید درخواستی: ${newClientTrafficGB} GB\n` +
                  `🚫 محدودیت کل: ${maxTraffic} GB\n\n` +
                  `💡 برای افزایش محدودیت با سوپر ادمین تماس بگیرید.`, env, [
                    [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
                  ]);
                return;
              }
            }
          }

          await createClient(panel, createAction.email, createAction.days, gb, { adminChatId: chatId });
          const client = await getClientByIdentifier(createAction.email, env, createAction.panelId);
          const msg = `✅ کاربر "${createAction.email}" ساخته شد.\n📅 ${createAction.days} روز | 📦 ${gb > 0 ? gb + " GB" : "نامحدود"}\n🖥️ سرور: ${panel.name}`;
          const buttons = client ? await buildAdminClientButtons(chatId, client, panel, env) : [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]];
          await sendTelegram(chatId, msg, env, buttons);

          // Send subscription link + QR code
          try {
            const subId = client?.subId || client?.subid || "";
            if (subId) {
              const subLink = await buildSubLinkAsync(subId, panel, env);
              const qrUrl = `${QR_CODE_API}?size=${QR_CODE_SIZE}x${QR_CODE_SIZE}&data=${encodeURIComponent(subLink)}`;
              await sendPhoto(chatId, qrUrl, `🔗 لینک اشتراک:\n${subLink}`, env, [
                [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
              ]);
            }
          } catch (e) {
            // Sub link not available — send just the text message without QR
            try {
              await sendTelegram(chatId, `⚠️ لینک اشتراک در دسترس نیست: ${shortError(e)}`, env, [
                [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
              ]);
            } catch { /* ignore */ }
          }
        } catch (error) {
          await sendTelegram(chatId, `❌ خطا در ساخت کاربر: ${shortError(error)}`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
        }
        return;
      }
    }

    // Check admin xray update action state
    const xrayUpdateState = await stateGet(env, `xray_update_action:${chatId}`);
    if (xrayUpdateState) {
      await stateDelete(env, `xray_update_action:${chatId}`);
      if (!admin) {
        await sendTelegramWithBack(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      const version = normalizeIdentifier(text);
      if (!version) {
        await sendTelegram(chatId, "❌ نسخه نامعتبر.", env, [
          [{ text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
        ]);
        return;
      }
      const panels = await getPanels(env);
      let results = "";
      for (const panel of panels) {
        try {
          await updateXray(panel, version);
          results += `✅ ${panel.name}: بروزرسانی شد\n`;
        } catch (error) {
          results += `❌ ${panel.name}: ${shortError(error)}\n`;
        }
      }
      await sendTelegram(chatId, `🔄 بروزرسانی Xray به نسخه ${version}:\n\n${results}`, env, [
        [{ text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
      ]);
      return;
    }

    // Check ban action state (super admin interactive)
    const banAction = await stateGet(env, `ban_action:${chatId}`);
    if (banAction) {
      await stateDelete(env, `ban_action:${chatId}`);
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await sendTelegram(chatId, "❌ فقط سوپر ادمین", env); return; }
      const targetId = normalizeIdentifier(text);
      if (!targetId) { await sendTelegram(chatId, "❌ Chat ID نامعتبر", env, [[{text:"🔙",callback_data:"admin_ban_menu"}]]); return; }
      if (await isAdminAsync(targetId, env)) { await sendTelegram(chatId, "❌ ادمین را نمی‌توان بن کرد", env, [[{text:"🔙",callback_data:"admin_ban_menu"}]]); return; }
      await statePut(env, `ban_reason:${chatId}`, { targetId }, MS_PER_HOUR);
      await sendTelegram(chatId, `📝 دلیل بن "${targetId}" را وارد کنید (یا 0 برای بدون دلیل):`, env, [
        [{ text: "❌ انصراف", callback_data: "admin_ban_menu" }],
      ]);
      return;
    }

    const banReasonState = await stateGet(env, `ban_reason:${chatId}`);
    if (banReasonState) {
      await stateDelete(env, `ban_reason:${chatId}`);
      const reason = text === "0" ? "" : text.trim();
      await banUser(env, banReasonState.targetId, reason);
      await sendTelegram(chatId, `🚫 کاربر "${banReasonState.targetId}" بن شد.${reason ? `\n📝 ${reason}` : ""}`, env, [
        [{ text: "🔙 بن/تعلیق", callback_data: "admin_ban_menu" }],
      ]);
      try { await sendTelegram(banReasonState.targetId, `🚫 بن شدید.${reason ? `\n📝 ${reason}` : ""}`, env); } catch {}
      return;
    }

    // Check suspend action state
    const suspendAction = await stateGet(env, `suspend_action:${chatId}`);
    if (suspendAction) {
      await stateDelete(env, `suspend_action:${chatId}`);
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await sendTelegram(chatId, "❌ فقط سوپر ادمین", env); return; }
      const targetId = normalizeIdentifier(text);
      if (!targetId) { await sendTelegram(chatId, "❌ Chat ID نامعتبر", env, [[{text:"🔙",callback_data:"admin_ban_menu"}]]); return; }
      if (await isAdminAsync(targetId, env)) { await sendTelegram(chatId, "❌ ادمین را نمی‌توان تعلیق کرد", env, [[{text:"🔙",callback_data:"admin_ban_menu"}]]); return; }
      await statePut(env, `suspend_min:${chatId}`, { targetId }, MS_PER_HOUR);
      await sendTelegram(chatId, `⏸ چند دقیقه تعلیق شود؟ (مثلاً 60)`, env, [
        [{ text: "❌ انصراف", callback_data: "admin_ban_menu" }],
      ]);
      return;
    }

    const suspendMinState = await stateGet(env, `suspend_min:${chatId}`);
    if (suspendMinState) {
      const mins = Number(text);
      if (!mins || mins <= 0) { await sendTelegram(chatId, "❌ مقدار نامعتبر. عدد دقیقه را وارد کنید:", env); return; }
      await stateDelete(env, `suspend_min:${chatId}`);
      await statePut(env, `suspend_reason:${chatId}`, { targetId: suspendMinState.targetId, mins }, MS_PER_HOUR);
      await sendTelegram(chatId, `📝 دلیل تعلیق را وارد کنید (یا 0 برای بدون دلیل):`, env, [
        [{ text: "❌ انصراف", callback_data: "admin_ban_menu" }],
      ]);
      return;
    }

    const suspendReasonState = await stateGet(env, `suspend_reason:${chatId}`);
    if (suspendReasonState) {
      await stateDelete(env, `suspend_reason:${chatId}`);
      const reason = text === "0" ? "" : text.trim();
      const { targetId, mins } = suspendReasonState;
      await suspendUser(env, targetId, mins, reason);
      await sendTelegram(chatId, `⏸ "${targetId}" تعلیق شد (${mins} دقیقه).${reason ? `\n📝 ${reason}` : ""}`, env, [
        [{ text: "🔙 بن/تعلیق", callback_data: "admin_ban_menu" }],
      ]);
      try { await sendTelegram(targetId, `⏸ تعلیق ${mins} دقیقه.${reason ? `\n📝 ${reason}` : ""}`, env); } catch {}
      return;
    }

    // Check addadmin action state (super admin interactive)
    const addAdminAction = await stateGet(env, `addadmin_action:${chatId}`);
    if (addAdminAction) {
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await stateDelete(env, `addadmin_action:${chatId}`); await sendTelegram(chatId, "❌ فقط سوپر ادمین", env); return; }
      if (addAdminAction.step === "chatId") {
        addAdminAction.targetId = normalizeIdentifier(text);
        addAdminAction.step = "panels";
        await statePut(env, `addadmin_action:${chatId}`, addAdminAction, MS_PER_HOUR);
        if (addAdminAction.type === "super") {
          // Super admin: no panels needed, ask for confirmation
          await stateDelete(env, `addadmin_action:${chatId}`);
          await setSuperAdmin(env, addAdminAction.targetId);
          await sendTelegram(chatId, `👑 سوپر ادمین "${addAdminAction.targetId}" اضافه شد!`, env, [
            [{ text: "🔙 مدیریت ادمین‌ها", callback_data: "admin_manage_admins" }],
          ]);
          try { await sendTelegram(addAdminAction.targetId, `👑 شما سوپر ادمین شدید! /admin بزنید.`, env); } catch {}
          return;
        }
        const panels = await getPanels(env);
        let msg = "🖥️ پنل‌های موجود:\n";
        for (const p of panels) { msg += `• ${p.id} — ${p.name}\n`; }
        msg += "\n💬 پنل‌ها را با کاما وارد کنید (مثلاً US,DE):";
        await sendTelegram(chatId, msg, env, [
          [{ text: "❌ انصراف", callback_data: "admin_manage_admins" }],
        ]);
        return;
      }
      if (addAdminAction.step === "panels") {
        const panelIds = text.split(",").map(s => s.trim()).filter(Boolean);
        addAdminAction.panelIds = panelIds;
        addAdminAction.step = "maxUsers";
        await statePut(env, `addadmin_action:${chatId}`, addAdminAction, MS_PER_HOUR);
        await sendTelegram(chatId, "📊 حداکثر تعداد کاربر را وارد کنید (یا 0 برای نامحدود):", env, [
          [{ text: "❌ انصراف", callback_data: "admin_manage_admins" }],
        ]);
        return;
      }
      if (addAdminAction.step === "maxUsers") {
        await stateDelete(env, `addadmin_action:${chatId}`);
        const maxUsers = Number(text) || 0;
        const { targetId, panelIds } = addAdminAction;
        await addPanelAdmin(env, targetId, panelIds, maxUsers);
        await sendTelegram(chatId, `✅ ادمین "${targetId}" اضافه شد.\n🖥️ پنل: ${panelIds.join(", ")}\n📊 محدودیت: ${maxUsers > 0 ? maxUsers : "نامحدود"}`, env, [
          [{ text: "🔙 مدیریت ادمین‌ها", callback_data: "admin_manage_admins" }],
        ]);
        try { await sendTelegram(targetId, `✅ ادمین شدید! پنل: ${panelIds.join(", ")}. /admin بزنید.`, env); } catch {}
        return;
      }
    }

    // Check Cloudflare DNS add action state (multi-step FSM)
    const cfAddState = await stateGet(env, `cf_add_action:${chatId}`);
    if (cfAddState) {
      if (!admin) {
        await stateDelete(env, `cf_add_action:${chatId}`);
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env, [[{ text: "🔙 منوی Cloudflare", callback_data: "cf_back" }]]);
        return;
      }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) {
        await stateDelete(env, `cf_add_action:${chatId}`);
        await sendTelegram(chatId, "❌ فقط سوپر ادمین.", env, [[{ text: "🔙 منوی Cloudflare", callback_data: "cf_back" }]]);
        return;
      }

      // Step: name → store, ask for content
      if (cfAddState.step === "name") {
        const name = text.trim();
        if (!name) {
          await sendTelegram(chatId, "❌ نام نامعتبر. دوباره وارد کنید:", env, [[{ text: "🔙 منوی Cloudflare", callback_data: "cf_back" }]]);
          return;
        }
        cfAddState.name = name;
        cfAddState.step = "content";
        await statePut(env, `cf_add_action:${chatId}`, cfAddState, MS_PER_HOUR);
        const example = cfAddState.type === "A" ? "192.168.1.1"
          : cfAddState.type === "AAAA" ? "2001:db8::1"
          : cfAddState.type === "CNAME" ? "target.example.com"
          : cfAddState.type === "MX" ? "10 mail.example.com"
          : cfAddState.type === "TXT" ? "v=spf1 include:_spf.example.com ~all"
          : "value";
        await sendTelegram(chatId,
          `📄 محتوای record را وارد کنید (مثلاً ${example}):\n\n💡 نوع: ${cfAddState.type} | نام: ${name}`,
          env,
          [[{ text: "❌ انصراف", callback_data: "cf_back" }]]
        );
        return;
      }

      // Step: content → store, ask for proxied
      if (cfAddState.step === "content") {
        const content = text.trim();
        if (!content) {
          await sendTelegram(chatId, "❌ محتوا نامعتبر. دوباره وارد کنید:", env, [[{ text: "🔙 منوی Cloudflare", callback_data: "cf_back" }]]);
          return;
        }
        cfAddState.content = content;
        cfAddState.step = "proxied";
        await statePut(env, `cf_add_action:${chatId}`, cfAddState, MS_PER_HOUR);
        await sendTelegram(chatId,
          `🟠 آیا این record از پروکسی Cloudflare استفاده کند؟\n\n💡 پروکسی = ترافیک از Cloudflare عبور می‌کند (پنهان‌کردن IP سرور)\n⚪ فقط DNS = مستقیم به سرور شما`,
          env,
          [
            [
              { text: "🟠 پروکسی (Proxied)", callback_data: "cf_dns_add_proxied:1" },
              { text: "⚪ فقط DNS (DNS Only)", callback_data: "cf_dns_add_proxied:0" },
            ],
            [{ text: "❌ انصراف", callback_data: "cf_back" }],
          ]
        );
        return;
      }
    }

    // Check SSH command input state
    const sshState = await stateGet(env, `ssh_action:${chatId}`);
    if (sshState && sshState.step === "command") {
      if (!admin) {
        await stateDelete(env, `ssh_action:${chatId}`);
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) {
        await stateDelete(env, `ssh_action:${chatId}`);
        await sendTelegram(chatId, "❌ فقط سوپر ادمین.", env);
        return;
      }
      const command = text.trim();
      if (!command) { await sendTelegram(chatId, "❌ Command empty.", env); return; }
      await stateDelete(env, `ssh_action:${chatId}`);
      const lang = await getUserLang(env, chatId);
      const panel = await resolvePanelAsync(env, sshState.panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ Panel not found.", env, [
          [{ text: t(lang, "main_menu"), callback_data: "admin_back" }],
        ]);
        return;
      }
      try {
        await sendTelegram(chatId, t(lang, "ssh_running"), env);
        const result = await executeSshCommand(panel, command, env);

        // Build output message with context info
        const ctxLabel = result.context && result.context !== 'shell' ? ` (${result.context})` : '';
        const msg = `💻 ${command}${ctxLabel}\n\n${t(lang, "ssh_output")}\n\`\`\`\n${(result.output || '(no output)').slice(0, 3500)}\n\`\`\``;

        // Build buttons from bridge's suggested buttons + always show default actions
        const buttons = [];
        const suggested = result.buttons || [];

        if (suggested.length) {
          // Use bridge-suggested buttons (context-specific)
          for (let i = 0; i < suggested.length; i += 3) {
            const row = [];
            for (let j = i; j < Math.min(i + 3, suggested.length); j++) {
              const token = await setAction(chatId, "ssh_interactive",
                `${sshState.panelId}|||${suggested[j].input}|||${result.sessionId || ''}`, env, "ssh");
              row.push({ text: suggested[j].label, callback_data: `act:${token}` });
            }
            buttons.push(row);
          }
        } else {
          // Default buttons (no interactive prompt detected)
          const tEnter = await setAction(chatId, "ssh_interactive", `${sshState.panelId}|||  |||${result.sessionId || ''}`, env, "ssh");
          const tY = await setAction(chatId, "ssh_interactive", `${sshState.panelId}|||y|||${result.sessionId || ''}`, env, "ssh");
          const tN = await setAction(chatId, "ssh_interactive", `${sshState.panelId}|||n|||${result.sessionId || ''}`, env, "ssh");
          buttons.push([
            { text: "⏎ Enter", callback_data: `act:${tEnter}` },
            { text: "Y + ⏎", callback_data: `act:${tY}` },
            { text: "N + ⏎", callback_data: `act:${tN}` },
          ]);
        }

        buttons.push([
          { text: "⌨️ New Command", callback_data: `ssh_panel:${sshState.panelId}` },
          { text: "📋 Quick Commands", callback_data: `ssh_quick:${sshState.panelId}` },
        ]);
        buttons.push([{ text: t(lang, "main_menu"), callback_data: "admin_back" }]);

        await sendTelegram(chatId, msg, env, buttons);
      } catch (e) {
        await sendTelegram(chatId, `❌ SSH error: ${shortError(e)}`, env, [
          [
            { text: "🔄 Retry", callback_data: `ssh_panel:${sshState.panelId}` },
            { text: t(lang, "main_menu"), callback_data: "admin_back" },
          ],
        ]);
      }
      return;
    }

    // Check Stars add plan action state (multi-step FSM)
    const starsAddState = await stateGet(env, `stars_add_action:${chatId}`);
    if (starsAddState) {
      if (!admin) {
        await stateDelete(env, `stars_add_action:${chatId}`);
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) {
        await stateDelete(env, `stars_add_action:${chatId}`);
        await sendTelegram(chatId, "❌ فقط سوپر ادمین.", env);
        return;
      }

      if (starsAddState.step === "name") {
        const name = text.trim();
        if (!name) { await sendTelegram(chatId, "❌ نام نامعتبر.", env); return; }
        starsAddState.name = name;
        starsAddState.step = "stars";
        await statePut(env, `stars_add_action:${chatId}`, starsAddState, MS_PER_HOUR);
        await sendTelegram(chatId, "⭐ تعداد Stars را وارد کنید (مثلاً 100):", env, [
          [{ text: "❌ انصراف", callback_data: "stars_menu" }],
        ]);
        return;
      }
      if (starsAddState.step === "stars") {
        const stars = Number(text);
        if (isNaN(stars) || stars <= 0) {
          await sendTelegram(chatId, "❌ مقدار نامعتبر. عدد Stars را وارد کنید:", env);
          return;
        }
        starsAddState.stars = stars;
        starsAddState.step = "description";
        await statePut(env, `stars_add_action:${chatId}`, starsAddState, MS_PER_HOUR);
        await sendTelegram(chatId, "📝 توضیحات طرح را وارد کنید (یا 0 برای رد کردن):", env, [
          [{ text: "❌ انصراف", callback_data: "stars_menu" }],
        ]);
        return;
      }
      if (starsAddState.step === "description") {
        const description = text.trim() === "0" ? "" : text.trim();
        await stateDelete(env, `stars_add_action:${chatId}`);
        // Save the plan
        const plans = await getStarsPlans(env);
        const planId = generateToken(8);
        plans.push({
          id: planId,
          name: starsAddState.name,
          stars: starsAddState.stars,
          description,
        });
        await saveStarsPlans(env, plans);
        await sendTelegram(chatId,
          `✅ طرح پرداخت اضافه شد!\n\n📋 نام: ${starsAddState.name}\n⭐ Stars: ${starsAddState.stars}\n📝 توضیحات: ${description || "—"}`, env, [
            [{ text: "🔙 مدیریت Stars", callback_data: "stars_menu" }],
          ]);
        return;
      }
    }

    // Check admin node add action state
    const nodeAddState = await stateGet(env, `node_add_action:${chatId}`);
    if (nodeAddState) {
      if (!admin) {
        await stateDelete(env, `node_add_action:${chatId}`);
        await sendTelegramWithBack(chatId, "❌ دسترسی ندارید.", env);
        return;
      }
      const panelId = nodeAddState.panelId;
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await stateDelete(env, `node_add_action:${chatId}`);
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        return;
      }
      if (nodeAddState.step === "address") {
        nodeAddState.address = text.trim();
        nodeAddState.step = "port";
        await statePut(env, `node_add_action:${chatId}`, nodeAddState, MS_PER_HOUR);
        await sendTelegram(chatId, "🔌 پورت node را وارد کنید (مثلاً 62789):", env, [
          [{ text: "❌ انصراف", callback_data: `panel_nodes:${panelId}` }],
        ]);
        return;
      }
      if (nodeAddState.step === "port") {
        const port = Number(text);
        if (isNaN(port) || port <= 0 || port > 65535) {
          await sendTelegramWithBack(chatId, "❌ پورت نامعتبر. عدد بین 1-65535 وارد کنید:", env);
          return;
        }
        nodeAddState.port = port;
        nodeAddState.step = "remark";
        await statePut(env, `node_add_action:${chatId}`, nodeAddState, MS_PER_HOUR);
        await sendTelegram(chatId, "📝 نام (remark) node را وارد کنید:", env, [
          [{ text: "❌ انصراف", callback_data: `panel_nodes:${panelId}` }],
        ]);
        return;
      }
      if (nodeAddState.step === "remark") {
        const remark = text.trim() || `Node-${Date.now()}`;
        nodeAddState.step = "apiToken";
        nodeAddState.remark = remark;
        await statePut(env, `node_add_action:${chatId}`, nodeAddState, MS_PER_HOUR);
        await sendTelegram(chatId, "🔑 توکن API مربوط به node را وارد کنید:\n\n💡 این توکن از پنل node گرفته می‌شود (Settings → API Tokens)", env, [
          [{ text: "❌ انصراف", callback_data: `panel_nodes:${panelId}` }],
        ]);
        return;
      }
      if (nodeAddState.step === "apiToken") {
        await stateDelete(env, `node_add_action:${chatId}`);
        try {
          await addNode(panel, {
            address: nodeAddState.address,
            port: nodeAddState.port,
            remark: nodeAddState.remark,
            name: nodeAddState.remark,
            scheme: "http",
            apiToken: text.trim(),
            enable: true,
          });
          await sendTelegram(chatId, `✅ Node با موفقیت اضافه شد!\n📍 ${nodeAddState.address}:${nodeAddState.port}\n📝 ${nodeAddState.remark}`, env, [
            [{ text: "🔙 مدیریت Nodes", callback_data: `panel_nodes:${panelId}` }],
          ]);
        } catch (error) {
          await sendTelegram(chatId, `❌ خطا در افزودن node: ${shortError(error)}`, env, [
            [{ text: "🔙 مدیریت Nodes", callback_data: `panel_nodes:${panelId}` }],
          ]);
        }
        return;
      }
    }

    // Parse command
    const parsed = parseCommandPayload(text);
    if (!parsed) {
      // Not a command
      return;
    }

    const { command, args } = parsed;

    // ── Admin commands ──

    if (command === "search" && admin) {
      await handleSearch(chatId, args, env);
      return;
    }

    if (command === "user" && admin) {
      await handleUser(chatId, args, env);
      return;
    }

    if (command === "create" && admin) {
      await handleCreate(chatId, args, env);
      return;
    }

    if (command === "delete" && admin) {
      await handleDelete(chatId, args, env);
      return;
    }

    if (command === "enable" && admin) {
      await handleEnable(chatId, args, env);
      return;
    }

    if (command === "disable" && admin) {
      await handleDisable(chatId, args, env);
      return;
    }

    if (command === "addgb" && admin) {
      await handleAddGB(chatId, args, env);
      return;
    }

    if (command === "renew" && admin && args.length >= 2) {
      // Admin renewal: /renew <identifier> <days> [panelId]
      await handleRenewAdmin(chatId, args, env);
      return;
    }

    if (command === "link" && admin) {
      await handleLink(chatId, args, env);
      return;
    }

    if (command === "clients" && admin) {
      await handleClients(chatId, args, env);
      return;
    }

    if (command === "status" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleStatus(chatId, args, env);
      return;
    }

    if (command === "online" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleOnline(chatId, args, env);
      return;
    }

    if (command === "paneltest" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handlePanelTest(chatId, args, env);
      return;
    }

    if (command === "cf" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      if (!getCfToken(env)) {
        await sendTelegram(chatId,
          "❌ CLOUDFLARE_API_TOKEN تنظیم نشده است.\n\n" +
          "💡 با دستور زیر آن را اضافه کنید:\n" +
          "```\nwrangler secret put CLOUDFLARE_API_TOKEN\n```",
          env);
        return;
      }
      await sendCfMainMenu(chatId, env, "fa");
      return;
    }

    if (command === "ssh" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleSsh(chatId, args, env);
      return;
    }

    if (command === "chart" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleChart(chatId, args, env);
      return;
    }

    if (command === "lang") {
      const lang = args[0];
      const validLangs = ["fa", "en", "zh", "ru"];
      if (!lang || !validLangs.includes(lang)) {
        await sendTelegramWithBack(chatId,
          "🌐 انتخاب زبان / Select language / 选择语言 / Выбор языка:\n\n" +
          "/lang fa — فارسی\n" +
          "/lang en — English\n" +
          "/lang zh — 中文\n" +
          "/lang ru — Русский", env);
        return;
      }
      await setUserLang(env, chatId, lang);
      const langNames = { fa: "فارسی", en: "English", zh: "中文", ru: "Русский" };
      await sendTelegramWithBack(chatId, `✅ زبان تنظیم شد: ${langNames[lang]}`, env);
      return;
    }

    if (command === "stars") {
      const isAdmin = await isAdminAsync(chatId, env);
      const isSuper = await isSuperAdmin(env, chatId);
      if (isSuper) {
        await handleStarsMenu(chatId, env);
      } else {
        // Panel admins AND regular users can buy
        await handleStarsBuy(chatId, env);
      }
      return;
    }

    if (command === "report" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await sendDailyReportAllPanels(env);
      await sendTelegramWithBack(chatId, "📊 گزارش روزانه ارسال شد.", env);
      return;
    }

    if (command === "versions" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleVersions(chatId, args, env);
      return;
    }

    if (command === "xray_restart" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleXrayRestart(chatId, args, env);
      return;
    }

    if (command === "xray_stop" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleXrayStop(chatId, args, env);
      return;
    }

    if (command === "xray_version" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleXrayVersionCmd(chatId, args, env);
      return;
    }

    if (command === "xray_update" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleXrayUpdate(chatId, args, env);
      return;
    }

    if (command === "panel_version" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handlePanelVersionCmd(chatId, args, env);
      return;
    }

    if (command === "panel_update" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handlePanelUpdateCmd(chatId, args, env);
      return;
    }

    if (command === "export" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleExportConfig(chatId, env);
      return;
    }

    if (command === "addpanel" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await startAddPanel(chatId, env);
      return;
    }

    if (command === "dellpanel" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleDeletePanel(chatId, args, env);
      return;
    }

    if (command === "panels" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleListPanels(chatId, env);
      return;
    }

    if (command === "backup" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      await handleBackup(chatId, args, env);
      return;
    }

    // ── Ban/Suspend (super admin) ──
    if (command === "ban" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      const t = args[0]; if (!t) { await sendTelegramWithBack(chatId, "استفاده: /ban <chatId> [دلیل]", env); return; }
      if (await isAdminAsync(t, env)) { await sendTelegram(chatId, "❌ ادمین را نمی‌توان بن کرد", env); return; }
      const r = args.slice(1).join(" ") || "";
      await banUser(env, t, r);
      await sendTelegram(chatId, `🚫 "${t}" بن شد.${r?`\n📝 ${r}`:""}`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `🚫 بن شدید.${r?`\n📝 ${r}`:""}`, env); } catch {}
      return;
    }
    if (command === "unban" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      const t = args[0]; if (!t) { await sendTelegramWithBack(chatId, "استفاده: /unban <chatId>", env); return; }
      await unbanUser(env, t);
      await sendTelegram(chatId, `✅ "${t}" رفع بن شد.`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `✅ بن رفع شد.`, env); } catch {}
      return;
    }
    if (command === "suspend" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      const t = args[0]; const m = Number(args[1]);
      if (!t || !m || m<=0) { await sendTelegramWithBack(chatId, "استفاده: /suspend <chatId> <دقیقه> [دلیل]", env); return; }
      if (await isAdminAsync(t, env)) { await sendTelegram(chatId, "❌ ادمین را نمی‌توان تعلیق کرد", env); return; }
      const r = args.slice(2).join(" ") || "";
      await suspendUser(env, t, m, r);
      await sendTelegram(chatId, `⏸ "${t}" تعلیق شد (${m} دقیقه).${r?`\n📝 ${r}`:""}`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `⏸ تعلیق ${m} دقیقه.${r?`\n📝 ${r}`:""}`, env); } catch {}
      return;
    }
    if (command === "unsuspend" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      const t = args[0]; if (!t) { await sendTelegramWithBack(chatId, "استفاده: /unsuspend <chatId>", env); return; }
      await unsuspendUser(env, t);
      await sendTelegram(chatId, `✅ تعلیق "${t}" لغو شد.`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      return;
    }
    if (command === "bannedlist" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      const b = await getBannedUsers(env);
      if (!b.length) { await sendTelegram(chatId, "✅ بن شده‌ای نیست.", env); return; }
      let m = `🚫 بن شده (${b.length}):\n\n`; for (const x of b) m += `• ${x.chatId} — ${x.reason||"-"}\n`;
      await sendTelegram(chatId, m, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      return;
    }

    // ── Admin role management (super admin) ──
    if (command === "addadmin" && admin) {
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await sendTelegram(chatId, "❌ فقط سوپر ادمین", env); return; }
      const t = args[0]; const pids = args[1]||""; const mx = Number(args[2])||0;
      const maxTraffic = Number(args[3])||0; // maxTrafficGB (0 = unlimited)
      if (!t || !pids) {
        await sendTelegramWithBack(chatId,
          "استفاده: /addadmin <chatId> <panelIds> [maxUsers] [maxTrafficGB]\n\n" +
          "مثال: /addadmin 123456789 US,DE 50 1000\n" +
          "(حداکثر ۵۰ کاربر، حداکثر ۱۰۰۰ GB ترافیک)", env);
        return;
      }
      const pl = pids.split(",").map(s=>s.trim()).filter(Boolean);
      await addPanelAdmin(env, t, pl, mx, maxTraffic);
      await sendTelegram(chatId,
        `✅ ادمین "${t}" اضافه شد.\n` +
        `🖥️ پنل: ${pl.join(", ")}\n` +
        `📊 محدودیت کاربر: ${mx>0?mx:"نامحدود"}\n` +
        `📦 محدودیت حجم: ${maxTraffic>0?maxTraffic+" GB":"نامحدود"}`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `✅ ادمین شدید! پنل: ${pl.join(", ")}. /admin بزنید.`, env); } catch {}
      return;
    }
    if (command === "removeadmin" && admin) {
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await sendTelegram(chatId, "❌ فقط سوپر ادمین", env); return; }
      const t = args[0]; if (!t) { await sendTelegramWithBack(chatId, "استفاده: /removeadmin <chatId>", env); return; }
      // Can't remove super admins
      const targetRole = await getAdminRole(env, t);
      if (targetRole && targetRole.role === "super") { await sendTelegram(chatId, "❌ نمی‌توان سوپر ادمین را حذف کرد.", env); return; }
      await removePanelAdmin(env, t);
      await sendTelegram(chatId, `✅ ادمین "${t}" حذف شد.`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      return;
    }
    if (command === "admins" && admin) {
      if (await rejectCommandIfNotSuper(chatId, env)) return;
      const list = await getAllAdminsWithRoles(env);
      let m = `👥 ادمین‌ها (${list.length}):\n\n`;
      for (const a of list) {
        m += `${a.role==="super"?"👑":"🛠️"} ${a.chatId} — ${a.role==="super"?"سوپر":"پنل"}\n`;
        m += `   👤 ${a.createdCount} کاربر${a.maxUsers>0?`/${a.maxUsers}`:""}`;
        if (a.role === "admin") {
          m += ` | 📦 ${a.usedTrafficGB.toFixed(1)} GB${a.maxTrafficGB>0?`/${a.maxTrafficGB}`:""}`;
        }
        m += `\n`;
      }
      await sendTelegram(chatId, m, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      return;
    }

    // ── Admin management ──

    if (command === "makeadmin") {
      await handleMakeAdmin(chatId, env);
      return;
    }

    if (command === "adminadd" && admin) {
      await handleAdminAdd(chatId, args, env);
      return;
    }

    if (command === "admindel" && admin) {
      await handleAdminDel(chatId, args, env);
      return;
    }

    // ── User commands ──

    if (text === "/usage" || text === "/myusage" || text === "/me") {
      await handleUserUsage(chatId, env);
      return;
    }

    if (command === "renew" && !admin) {
      // User renewal request
      await handleRenewalRequest(chatId, env);
      return;
    }

    if (text === "/help" || text === "/start help") {
      await handleHelp(chatId, admin, env);
      return;
    }

    if (command === "admin" && admin) {
      await sendAdminMenu(chatId, env);
      return;
    }

    // Unknown command
    await sendTelegramWithBack(chatId, "دستور ناشناخته. /help را بزنید.", env);
  } catch (error) {
    console.error("handleTelegramUpdate error:", shortError(error));
  }
}

// ─── Start & Registration ─────────────────────────────────────

async function handleStart(chatId, fromId, env) {
  // FIRST: Check if admin — admins skip registration
  const admin = await isAdminAsync(chatId, env);
  if (admin) {
    const isSuper = await isSuperAdmin(env, chatId);
    if (isSuper) {
      // Super admins get a choice between 3x-ui panel management and Cloudflare
      await sendSuperAdminChoiceMenu(chatId, env);
    } else {
      // Panel admins get the limited admin menu directly
      await sendAdminMenu(chatId, env);
    }
    return;
  }

  // SECOND: Check if already registered as normal user
  const existingUser = await getUser(env, chatId);
  if (existingUser) {
    // IMPORTANT: do NOT auto-delete the user when the panel/client is
    // temporarily unreachable. The panel may be restarting, the network
    // may be flaky, or the panel admin may have moved the client.
    // `sendUserMenu()` already handles the missing-client case by showing
    // the locally-cached backup info and prompting re-registration only
    // when no backup exists. Auto-deleting here was a regression that
    // silently wiped accounts on transient outages.
    await sendUserMenu(chatId, env);
    return;
  }

  // THIRD: New user — start registration
  await startRegistration(chatId, env);
}

async function startRegistration(chatId, env) {
  const panels = await getPanels(env).catch(() => []);
  const lang = await getUserLang(env, chatId);
  if (!panels.length) {
    await sendTelegramWithBack(chatId, t(lang, "error") + " " + t(lang, "not_found"), env);
    return;
  }
  if (panels.length === 1) {
    await statePut(env, `${STATE_REG_PREFIX}${chatId}`, { step: "email", panelId: panels[0].id, lang }, MS_PER_HOUR);
    await sendTelegram(chatId, t(lang, "welcome") + "\n\n" + t(lang, "enter_email"), env, [
      [{ text: t(lang, "reg_cancel"), callback_data: "reg_cancel" }],
    ]);
  } else {
    await statePut(env, `${STATE_REG_PREFIX}${chatId}`, { step: "panel", lang }, MS_PER_HOUR);
    const buttons = panels.map((p) => [{ text: p.name, callback_data: `reg_panel:${p.id}` }]);
    await sendTelegram(chatId, t(lang, "welcome") + "\n\n" + t(lang, "select_server"), env, buttons);
  }
}

async function handleRegistrationStep(chatId, regState, text, env) {
  if (regState.step === "panel") return;

  if (regState.step === "email") {
    const email = normalizeIdentifier(text);
    if (!email) {
      await sendTelegram(chatId, "❌ ایمیل نامعتبر. لطفاً دوباره وارد کنید:", env, [
        [{ text: "🔙 شروع مجدد", callback_data: "reg_cancel" }],
      ]);
      return;
    }

    const client = await getClientByIdentifier(email, env, regState.panelId);
    if (!client) {
      await sendTelegram(chatId, "❌ این ایمیل در سرور یافت نشد. لطفاً ایمیل صحیح را وارد کنید:", env, [
        [{ text: "🔙 شروع مجدد", callback_data: "reg_cancel" }],
      ]);
      return;
    }

    await registerUser(env, chatId, email, regState.panelId);
    await stateDelete(env, `${STATE_REG_PREFIX}${chatId}`);

    const panel = await resolvePanelAsync(env, regState.panelId);

    // Notify admins about new user registration
    try {
      await notifyAdminsNewUser(env, chatId, email, panel ? panel.name : regState.panelId);
    } catch { /* ignore notification errors */ }

    // Create initial user backup
    try {
      const traffic = getClientTraffic(client);
      const totalBytes = getClientTotalBytes(client);
      const usedBytes = traffic.up + traffic.down;
      await updateUserBackup(env, chatId, {
        email: email,
        panelId: regState.panelId,
        totalGB: totalBytes > 0 ? totalBytes / BYTES_PER_GB : null,
        usedGB: usedBytes / BYTES_PER_GB,
        remainingGB: totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) / BYTES_PER_GB : null,
        uploadGB: traffic.up / BYTES_PER_GB,
        downloadGB: traffic.down / BYTES_PER_GB,
        expiryTime: client.expiryTime > 0 ? Number(client.expiryTime) : null,
        enabled: isClientEnabled(client),
      }, panel);
    } catch { /* ignore */ }

    const msg = `✅ ثبت‌نام موفق!\n\n${formatClient(client, panel)}`;
    await sendTelegram(chatId, msg, env, await buildUserViewButtons(chatId, email, regState.panelId, env));
  }
}

// ─── Admin Menu (Interactive) ─────────────────────────────────

/**
 * Show super admin a choice between 3x-ui panel management and Cloudflare.
 * Only displayed when CLOUDFLARE_API_TOKEN is configured (otherwise skip
 * straight to the 3x-ui menu, since the CF button would just error).
 */
async function sendSuperAdminChoiceMenu(chatId, env) {
  const hasCfToken = Boolean(getCfToken(env));
  if (!hasCfToken) {
    await sendAdminMenu(chatId, env);
    return;
  }
  const lang = await getUserLang(env, chatId);
  const L = (k) => t(lang, k);
  const menuText = L("super_admin_menu") + "\n\n" + L("select_option");
  const buttons = [
    [
      { text: "🖥 3x-ui", callback_data: "sa_xui" },
      { text: "☁️ Cloudflare", callback_data: "sa_cf" },
    ],
    [
      { text: L("ssh_terminal"), callback_data: "admin_ssh" },
    ],
    [
      { text: L("language"), callback_data: "admin_lang" },
      { text: L("github"), url: "https://github.com/Raya-coder/3x-ui-bot" },
    ],
  ];
  await sendTelegram(chatId, menuText, env, buttons);
}

async function sendAdminMenu(chatId, env) {
  const roleInfo = await getAdminRole(env, chatId);
  const isSuper = !roleInfo || roleInfo.role === "super";
  const lang = await getUserLang(env, chatId);
  const L = (k) => t(lang, k);

  /** @type {any[][]} */
  let buttons = [];
  let menuText = "";

  if (isSuper) {
    // ───── SUPER ADMIN — full menu ─────
    menuText = L("super_admin_menu");
    buttons = [
      [{ text: L("server_status"), callback_data: "admin_status" }],
      [
        { text: L("search_user"), callback_data: "admin_search" },
        { text: L("user_list"), callback_data: "admin_clients" },
      ],
      [{ text: L("create_user"), callback_data: "admin_create" }],
      [
        { text: L("panel_manage"), callback_data: "admin_panels" },
        { text: L("inbound_manage"), callback_data: "admin_inbounds" },
      ],
      [{ text: L("node_manage"), callback_data: "admin_nodes" }],
      [{ text: L("renewals"), callback_data: "admin_renewals" }],
      [
        { text: L("xray_manage"), callback_data: "admin_xray" },
        { text: L("panel_restart"), callback_data: "admin_panel_restart" },
      ],
      [
        { text: L("backup"), callback_data: "admin_backup" },
        { text: L("export_config"), callback_data: "admin_export" },
      ],
      [
        { text: L("daily_report"), callback_data: "admin_report" },
        { text: L("server_logs"), callback_data: "admin_logs" },
      ],
      [
        { text: L("online_users"), callback_data: "admin_online" },
        { text: L("versions"), callback_data: "admin_versions" },
      ],
      [
        { text: L("user_backups"), callback_data: "admin_user_backups" },
        { text: L("api_tokens"), callback_data: "admin_api_tokens" },
      ],
      [
        { text: L("outbounds"), callback_data: "admin_outbounds" },
        { text: L("settings"), callback_data: "admin_settings" },
      ],
      [
        { text: L("outbound_traffic"), callback_data: "admin_outbound_traffic" },
        { text: L("reset_inbound_traffic"), callback_data: "admin_reset_inbound_traffic" },
      ],
      [
        { text: L("ban_menu"), callback_data: "admin_ban_menu" },
        { text: L("manage_admins"), callback_data: "admin_manage_admins" },
      ],
      [{ text: L("error_logs"), callback_data: "admin_error_logs" }],
      [
        { text: L("chart_traffic"), callback_data: "admin_chart" },
        { text: L("stars_payment"), callback_data: "admin_stars" },
      ],
      [{ text: L("ssh_terminal"), callback_data: "admin_ssh" }],
    ];
  } else {
    // ───── PANEL ADMIN — limited menu ─────
    const cnt = await getAdminCreatedCount(env, chatId);
    const mx = roleInfo.maxUsers || 0;
    menuText = L("admin_menu");
    menuText += `\n${L("user_created_count")}: ${cnt}${mx > 0 ? "/" + mx : ""}`;
    menuText += `\n${L("admin_limit")}`;

    buttons = [
      [{ text: L("create_user"), callback_data: "admin_create" }],
      [
        { text: L("user_list"), callback_data: "admin_clients" },
        { text: L("search_user"), callback_data: "admin_search" },
      ],
      [{ text: L("renewals"), callback_data: "admin_renewals" }],
      [{ text: L("buy_subscription"), callback_data: "admin_stars" }],
    ];
  }

  // Add support button if SUPPORT_USERNAME is configured
  const supportUser = getSupportUsername(env);
  if (supportUser) {
    buttons.push([{ text: L("support"), url: `https://t.me/${supportUser}` }]);
  }
  // Language selector + GitHub link (always shown)
  buttons.push([
    { text: L("language"), callback_data: "admin_lang" },
    { text: L("github"), url: "https://github.com/Raya-coder/3x-ui-bot" },
  ]);
  menuText += `\n\n${L("select_option")}`;
  await sendTelegram(chatId, menuText, env, buttons);
}

async function sendXrayMenu(chatId, env) {
  const panels = await getPanels(env);
  const buttons = [];

  for (const panel of panels) {
    buttons.push([
      { text: `🔄 ریستارت Xray — ${panel.name}`, callback_data: `xray_restart:${panel.id}` },
      { text: `⏹ توقف — ${panel.name}`, callback_data: `xray_stop:${panel.id}` },
    ]);
    buttons.push([
      { text: `📊 وضعیت — ${panel.name}`, callback_data: `server_status:${panel.id}` },
      { text: `📡 نسخه — ${panel.name}`, callback_data: `xray_version:${panel.id}` },
    ]);
  }

  buttons.push([
    { text: "🔄 بروزرسانی Xray (تمام سرورها)", callback_data: "admin_xray_update" },
  ]);
  buttons.push([
    { text: "🔙 بازگشت به منوی اصلی", callback_data: "admin_back" },
  ]);

  await sendTelegram(chatId, "⚡ مدیریت Xray\n👇 سرور و عملیات مورد نظر را انتخاب کنید:", env, buttons);
}

async function sendPanelsMenu(chatId, env) {
  const panels = await getPanels(env);
  const buttons = [];

  for (const panel of panels) {
    buttons.push([
      { text: `📊 وضعیت ${panel.name}`, callback_data: `server_status:${panel.id}` },
    ]);
    buttons.push([
      { text: `🗑️ حذف ${panel.name}`, callback_data: `panel_del_confirm:${panel.id}` },
    ]);
  }

  buttons.push([
    { text: "➕ افزودن پنل جدید", callback_data: "admin_addpanel" },
  ]);
  buttons.push([
    { text: "🔙 بازگشت به منوی اصلی", callback_data: "admin_back" },
  ]);

  await sendTelegram(chatId, "🖥️ مدیریت پنل‌ها\n👇 عملیات مورد نظر را انتخاب کنید:", env, buttons);
}

async function sendCreateUserMenu(chatId, env) {
  const panels = await getPanels(env);
  const buttons = [];

  for (const panel of panels) {
    buttons.push([
      { text: `➕ ساخت در ${panel.name}`, callback_data: `create_on_panel:${panel.id}` },
    ]);
  }

  buttons.push([
    { text: "🔙 بازگشت به منوی اصلی", callback_data: "admin_back" },
  ]);

  await sendTelegram(chatId, "➕ ساخت کاربر جدید\n👇 سرور مقصد را انتخاب کنید:", env, buttons);
}

// ─── Command Handlers ─────────────────────────────────────────

/**
 * Verify that the current admin (chatId) is allowed to act on a given client.
 *
 * - Super admin: always allowed.
 * - Panel admin: allowed ONLY if they created the client (comment starts with "TG:<chatId>").
 *
 * Returns true if access is allowed; false (and sends a denial message) if not.
 */
async function adminCanAccessClient(chatId, client, env) {
  const isSuper = await isSuperAdmin(env, chatId);
  if (isSuper) return true;
  const comment = String(client?.comment || "").trim();
  const myMarker = `TG:${String(chatId)}`;
  if (comment === myMarker || comment.startsWith(myMarker + " ")) return true;
  await sendTelegram(chatId,
    "⛔ شما فقط به کاربرانی که خودتان ساخته‌اید دسترسی دارید.", env,
    [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
  return false;
}

/**
 * Same as adminCanAccessClient but for callback handlers — uses
 * answerCallbackQuery for the denial popup.
 */
async function adminCanAccessClientCallback(chatId, client, callbackQueryId, env) {
  const isSuper = await isSuperAdmin(env, chatId);
  if (isSuper) return true;
  const comment = String(client?.comment || "").trim();
  const myMarker = `TG:${String(chatId)}`;
  if (comment === myMarker || comment.startsWith(myMarker + " ")) return true;
  await answerCallbackQuery(callbackQueryId, env, "⛔ دسترسی به این کاربر ندارید");
  try {
    await sendTelegram(chatId,
      "⛔ شما فقط به کاربرانی که خودتان ساخته‌اید دسترسی دارید.", env,
      [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
  } catch { /* ignore */ }
  return false;
}

async function handleSearch(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegramWithBack(chatId, "استفاده: /search <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see users they created (comment starts with "TG:<chatId>")
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const myMarker = `TG:${String(chatId)}`;
    results = results.filter(r => {
      const comment = String(r.client?.comment || "").trim();
      return comment === myMarker || comment.startsWith(myMarker + " ");
    });
  }
  if (!results.length) {
    const msg = (searchRole && searchRole.role === "admin")
      ? `❌ کاربری با شناسه "${identifier}" در لیست کاربران شما یافت نشد.`
      : `❌ کاربری با شناسه "${identifier}" یافت نشد.`;
    await sendTelegramWithBack(chatId, msg, env);
    return;
  }
  for (const { panel, client } of results) {
    const msg = formatClient(client, panel);
    const buttons = await buildAdminClientButtons(chatId, client, panel, env);
    await sendTelegram(chatId, msg, env, buttons);
  }
}

async function handleUser(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegramWithBack(chatId, "استفاده: /user <شناسه>", env);
    return;
  }
  const panelId = args[1] || null;
  const panel = panelId ? await resolvePanelAsync(env, panelId) : null;

  if (panelId && !panel) {
    await sendTelegramWithBack(chatId, `❌ پنل "${panelId}" یافت نشد.`, env);
    return;
  }

  const client = await getClientByIdentifier(identifier, env, panelId);
  if (!client) {
    await sendTelegramWithBack(chatId, `❌ کاربری با شناسه "${identifier}" یافت نشد.`, env);
    return;
  }

  // Access control: panel admins can only view users they created
  if (!(await adminCanAccessClient(chatId, client, env))) return;

  const resolvedPanel = panel || (await searchClientAcrossPanels(identifier, env))[0]?.panel;
  if (!resolvedPanel) {
    await sendTelegramWithBack(chatId, "❌ پنل کاربر یافت نشد.", env);
    return;
  }

  const msg = formatClient(client, resolvedPanel);
  const buttons = await buildAdminClientButtons(chatId, client, resolvedPanel, env);
  await sendTelegram(chatId, msg, env, buttons);
}

async function handleCreate(chatId, args, env) {
  if (args.length < 3) {
    await sendTelegramWithBack(chatId, "استفاده: /create <شناسه> <روز> <حجم GB> [آیدی پنل]", env);
    return;
  }
  const identifier = args[0];
  const days = Number(args[1]);
  const gb = Number(args[2]);
  const panelId = args[3] || null;

  if (!identifier || isNaN(days) || isNaN(gb) || days <= 0 || gb <= 0) {
    await sendTelegramWithBack(chatId, "❌ مقادیر نامعتبر.", env);
    return;
  }

  const panel = panelId ? await resolvePanelAsync(env, panelId) : null;
  if (panelId && !panel) {
    await sendTelegramWithBack(chatId, `❌ پنل "${panelId}" یافت نشد.`, env);
    return;
  }

  const panels = panel ? [panel] : await getPanels(env);
  const targetPanel = panels[0];

  // Check user limit for panel admins
  const role = await getAdminRole(env, chatId);
  if (role && role.role === "admin") {
    const cnt = await getAdminCreatedCount(env, chatId);
    const mx = role.maxUsers || 0;
    if (mx > 0 && cnt >= mx) { await sendTelegram(chatId, `❌ محدودیت ساخت کاربر (${cnt}/${mx})`, env); return; }
  }

  try {
    await createClient(targetPanel, identifier, days, gb, { adminChatId: chatId });
    const client = await getClientByIdentifier(identifier, env, targetPanel.id);
    const msg = `✅ کاربر ساخته شد!\n\n${client ? formatClient(client, targetPanel) : ""}`;
    await sendTelegramWithBack(chatId, msg, env);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا در ساخت کاربر: ${shortError(error)}`, env);
  }
}

async function handleDelete(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegramWithBack(chatId, "استفاده: /delete <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see users they created (comment starts with "TG:<chatId>")
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const myMarker = `TG:${String(chatId)}`;
    results = results.filter(r => {
      const comment = String(r.client?.comment || "").trim();
      return comment === myMarker || comment.startsWith(myMarker + " ");
    });
  }
  if (!results.length) {
    await sendTelegramWithBack(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await deleteClient(panel, identifier, env);
    await sendTelegramWithBack(chatId, `✅ کاربر "${identifier}" حذف شد.`, env);
    // Also delete from registered users
    const user = await findUserByEmail(env, identifier, panel.id);
    if (user) await deleteUser(env, user.chatId);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا در حذف: ${shortError(error)}`, env);
  }
}

async function handleEnable(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegramWithBack(chatId, "استفاده: /enable <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const myMarker = `TG:${String(chatId)}`;
    results = results.filter(r => {
      const comment = String(r.client?.comment || "").trim();
      return comment === myMarker || comment.startsWith(myMarker + " ");
    });
  }
  if (!results.length) {
    await sendTelegramWithBack(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await updateClient(panel, client, { enable: true });
    await sendTelegramWithBack(chatId, `✅ کاربر "${identifier}" فعال شد.`, env);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleDisable(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegramWithBack(chatId, "استفاده: /disable <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const myMarker = `TG:${String(chatId)}`;
    results = results.filter(r => {
      const comment = String(r.client?.comment || "").trim();
      return comment === myMarker || comment.startsWith(myMarker + " ");
    });
  }
  if (!results.length) {
    await sendTelegramWithBack(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await updateClient(panel, client, { enable: false });
    await sendTelegramWithBack(chatId, `⛔ کاربر "${identifier}" غیرفعال شد.`, env);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleAddGB(chatId, args, env) {
  if (args.length < 2) {
    await sendTelegramWithBack(chatId, "استفاده: /addgb <شناسه> <حجم GB>", env);
    return;
  }
  const identifier = args[0];
  const gb = Number(args[1]);
  if (!identifier || isNaN(gb) || gb <= 0) {
    await sendTelegramWithBack(chatId, "❌ مقادیر نامعتبر.", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const myMarker = `TG:${String(chatId)}`;
    results = results.filter(r => {
      const comment = String(r.client?.comment || "").trim();
      return comment === myMarker || comment.startsWith(myMarker + " ");
    });
  }
  if (!results.length) {
    await sendTelegramWithBack(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await addGBToClient(panel, client, gb);
    const updated = await getClientByIdentifier(identifier, env, panel.id);
    await sendTelegramWithBack(chatId, `✅ ${gb} GB حجم اضافه شد.\n\n${updated ? formatClient(updated, panel) : ""}`, env);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleRenewAdmin(chatId, args, env) {
  const identifier = args[0];
  const days = Number(args[1]);
  const panelId = args[2] || null;

  if (!identifier || isNaN(days) || days <= 0) {
    await sendTelegramWithBack(chatId, "استفاده: /renew <شناسه> <روز> [آیدی پنل]", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const myMarker = `TG:${String(chatId)}`;
    results = results.filter(r => {
      const comment = String(r.client?.comment || "").trim();
      return comment === myMarker || comment.startsWith(myMarker + " ");
    });
  }
  if (!results.length) {
    await sendTelegramWithBack(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  let target = results[0];
  if (panelId) {
    const found = results.find((r) => r.panel.id === panelId);
    if (found) target = found;
  }
  try {
    await addDaysToClient(target.panel, target.client, days);
    const updated = await getClientByIdentifier(identifier, env, target.panel.id);
    await sendTelegramWithBack(chatId, `✅ ${days} روز تمدید شد.\n\n${updated ? formatClient(updated, target.panel) : ""}`, env);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleLink(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegramWithBack(chatId, "استفاده: /link <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const myMarker = `TG:${String(chatId)}`;
    results = results.filter(r => {
      const comment = String(r.client?.comment || "").trim();
      return comment === myMarker || comment.startsWith(myMarker + " ");
    });
  }
  if (!results.length) {
    await sendTelegramWithBack(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  const subId = client.subId || client.subid || client.sub_id || "";
  if (!subId) {
    await sendTelegramWithBack(chatId, "❌ لینک اشتراک برای این کاربر موجود نیست.", env);
    return;
  }
  try {
    const link = await buildSubLinkAsync(subId, panel, env);
    const qrUrl = `${QR_CODE_API}?size=${QR_CODE_SIZE}x${QR_CODE_SIZE}&data=${encodeURIComponent(link)}`;
    await sendPhoto(chatId, qrUrl, `🔗 لینک اشتراک:\n${link}`, env);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleClients(chatId, args, env) {
  const page = Math.max(1, Number(args[0]) || 1);
  const panels = await getPanels(env);
  const panel = panels[0]; // Default to first panel

  // Role-based filtering:
  // - Super admin: sees ALL panel clients
  // - Panel admin: sees ONLY clients they created (comment starts with "TG:<chatId>")
  const roleInfo = await getAdminRole(env, chatId);
  const isSuper = !roleInfo || roleInfo.role === "super";

  try {
    let clients = await listAllClients(panel);

    if (!isSuper) {
      // Filter to only clients this admin created.
      // createClient sets comment to "TG:<adminChatId>" when called via the bot.
      const myMarker = `TG:${String(chatId)}`;
      clients = clients.filter((c) => {
        const comment = String(c?.comment || "").trim();
        return comment === myMarker || comment.startsWith(myMarker + " ");
      });
    }

    const start = (page - 1) * PER_PAGE;
    const end = start + PER_PAGE;
    const pageClients = clients.slice(start, end);
    const totalPages = Math.max(1, Math.ceil(clients.length / PER_PAGE));

    if (!pageClients.length) {
      const msg = isSuper
        ? "❌ کاربری یافت نشد."
        : "❌ شما هنوز هیچ کاربری نساخته‌اید.\n💡 از منو، «➕ ساخت کاربر جدید» را بزنید.";
      await sendTelegramWithBack(chatId, msg, env);
      return;
    }

    const title = isSuper ? "👥 لیست کاربران" : "👥 کاربران من";
    let msg = `${title} (صفحه ${page}/${totalPages}):\n\n`;
    for (const client of pageClients) {
      const traffic = getClientTraffic(client);
      const totalBytes = getClientTotalBytes(client);
      const usedBytes = traffic.up + traffic.down;
      const enabled = isClientEnabled(client);
      const expired = isClientExpired(client);
      const statusIcon = expired ? "⏰" : !enabled ? "⛔" : "🟢";

      msg += `${statusIcon} ${getIdentifierFromClient(client)} | ${formatGB(usedBytes)}${totalBytes > 0 ? `/${formatGB(totalBytes)}` : ""}\n`;
    }

    const buttons = [];
    if (page > 1) buttons.push([{ text: `◀ صفحه قبل`, callback_data: `clients_page:${page - 1}` }]);
    if (page < totalPages) buttons.push([{ text: `صفحه بعد ▶`, callback_data: `clients_page:${page + 1}` }]);

    await sendTelegram(chatId, msg, env, buttons.length ? buttons : null);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleStatus(chatId, args, env) {
  const panelId = args[0] || null;
  let panels = panelId ? [await resolvePanelAsync(env, panelId)].filter(Boolean) : await getPanels(env);
  // Panel admins: only their assigned panels
  const statusRole = await getAdminRole(env, chatId);
  if (statusRole && statusRole.role === "admin") {
    panels = panels.filter(p => (statusRole.panelIds||[]).includes(p.id));
  }

  for (const panel of panels) {
    try {
      const status = await getServerStatus(panel);
      const obj = status?.obj || status;
      const cpu = Number(obj?.cpu || obj?.cpuPercent || 0);
      const mem = Number(obj?.mem?.current || obj?.memCurrent || obj?.memory || 0);
      const memTotal = Number(obj?.mem?.total || obj?.memTotal || 0);
      const memPercent = memTotal > 0 ? ((mem / memTotal) * 100).toFixed(1) : "0";
      const disk = Number(obj?.disk?.current || 0);
      const diskTotal = Number(obj?.disk?.total || 0);
      const diskPercent = diskTotal > 0 ? ((disk / diskTotal) * 100).toFixed(1) : "0";
      const uptime = Number(obj?.uptime || obj?.xray?.uptime || 0);
      const xrayRunning = obj?.xray?.running ?? true;
      const xrayVersion = obj?.xray?.version || "نامشخص";
      const loads = obj?.loads || [0, 0, 0];
      // Additional fields
      const netUp = Number(obj?.netIO?.up || obj?.netUp || 0);
      const netDown = Number(obj?.netIO?.down || obj?.netDown || 0);
      const appUptime = Number(obj?.appUptime || obj?.uptime || 0);
      const tcpCount = Number(obj?.tcpCount || 0);
      const udpCount = Number(obj?.udpCount || 0);
      const GoroutineCount = Number(obj?.goroutineCount || 0);

      let msg =
        `📊 وضعیت سرور\n\n` +
        `🖥️ سرور: ${panel.name}\n\n` +
        `${xrayRunning ? "✅" : "❌"} Xray: ${xrayRunning ? "فعال" : "متوقف"} (v${xrayVersion})\n` +
        `⏱️ Uptime: ${formatUptime(uptime * 1000)}\n\n` +
        `💻 CPU: ${cpu.toFixed(1)}%\n` +
        `🧠 RAM: ${memPercent}% (${formatGB(mem)}/${formatGB(memTotal)})\n` +
        `💾 Disk: ${diskPercent}% (${formatGB(disk)}/${formatGB(diskTotal)})\n` +
        `📊 Load: ${Array.isArray(loads) ? loads.map((l) => l.toFixed ? l.toFixed(2) : l).join(", ") : loads}\n`;

      if (netUp > 0 || netDown > 0) {
        msg += `\n🌐 شبکه:\n   ⬆️ ${formatGB(netUp)}/s | ⬇️ ${formatGB(netDown)}/s\n`;
      }
      if (tcpCount > 0 || udpCount > 0) {
        msg += `🔌 اتصال‌ها: TCP=${tcpCount} | UDP=${udpCount}\n`;
      }
      if (GoroutineCount > 0) {
        msg += `⚙️ Goroutines: ${GoroutineCount}\n`;
      }
      if (appUptime > 0 && appUptime !== uptime) {
        msg += `📱 Uptime پنل: ${formatUptime(appUptime * 1000)}\n`;
      }

      const buttons = [
        [
          { text: "🔄 ریستارت Xray", callback_data: `xray_restart:${panel.id}` },
          { text: "⏹ توقف Xray", callback_data: `xray_stop:${panel.id}` },
        ],
      ];

      await sendTelegram(chatId, msg, env, buttons);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا در دریافت وضعیت ${panel.name}: ${shortError(error)}`, env);
    }
  }
}

async function handleOnline(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      // Strategy: try multiple sources in order, combine results.
      // 1) /panel/api/inbounds/onlines  — list of {id, ip, total} (newer 3x-ui)
      // 2) /panel/api/inbounds/list      — has clientStats[].lastOnline for isOnline check
      // 3) /panel/api/server/status     — has xray.onlines count (last resort)
      let onlineUsers = [];
      let onlineCount = 0;
      let source = "";
      let triedEndpoints = [];

      // === Source 1: /panel/api/clients/onlines (POST) — v3.4.x ===
      // v3.4.x moved online users from /inbounds/onlines to /clients/onlines
      try {
        const onlineResponse = await panelApi(panel, API_PATHS.CLIENTS_ONLINES, "POST");
        onlineUsers = extractOnlineUsers(onlineResponse);
        triedEndpoints.push(`✅ /clients/onlines (${onlineUsers.length} users)`);
        if (onlineUsers.length) source = "clients/onlines";
      } catch (e) {
        triedEndpoints.push(`❌ /clients/onlines: ${shortError(e).slice(0, 40)}`);
      }

      // === Source 1b: /panel/api/inbounds/onlines (GET) — older versions ===
      if (!onlineUsers.length) {
        try {
          const onlineResponse = await panelApi(panel, API_PATHS.INBOUNDS_ONLINE, "GET");
          onlineUsers = extractOnlineUsers(onlineResponse);
          triedEndpoints.push(`✅ /inbounds/onlines (${onlineUsers.length} users)`);
          if (onlineUsers.length) source = "inbounds/onlines";
        } catch (e) {
          triedEndpoints.push(`❌ /inbounds/onlines: ${shortError(e).slice(0, 40)}`);
        }
      }

      // === Source 2: /panel/api/inbounds/list with clientStats[] ===
      // Each inbound has clientStats[] with { email, lastOnline, ... }
      // A client is considered "online" if lastOnline is within last 2 min.
      if (!onlineUsers.length) {
        try {
          const inboundsResponse = await panelApi(panel, API_PATHS.INBOUNDS_LIST, "GET");
          const onlineFromStats = extractOnlineFromInboundsList(inboundsResponse);
          triedEndpoints.push(`✅ /inbounds/list clientStats (${onlineFromStats.length} online)`);
          if (onlineFromStats.length) {
            onlineUsers = onlineFromStats;
            source = "inbounds/list (clientStats)";
          }
        } catch (e) {
          triedEndpoints.push(`❌ /inbounds/list: ${shortError(e).slice(0, 40)}`);
        }
      }

      // === Source 3: /panel/api/server/status (extract count only) ===
      if (!onlineUsers.length) {
        try {
          const status = await panelApi(panel, API_PATHS.SERVER_STATUS, "GET");
          const obj = status?.obj || status;
          const count = Number(obj?.xray?.onlines || obj?.onlines || obj?.onlineCount || 0);
          if (count > 0) {
            onlineCount = count;
            source = "server/status";
            triedEndpoints.push(`✅ /server/status (count=${count})`);
          } else {
            triedEndpoints.push(`⚠️ /server/status (no onlines field)`);
          }
        } catch (e) {
          triedEndpoints.push(`❌ /server/status: ${shortError(e).slice(0, 40)}`);
        }
      }

      // === Render result ===
      if (onlineUsers.length) {
        let msg = `🟢 کاربران آنلاین ${panel.name} (${onlineUsers.length} نفر):\n\n`;
        for (const user of onlineUsers.slice(0, 30)) {
          const name = user.email || user.id || "نامشخص";
          // Show IP only if present — /inbounds/list clientStats doesn't
          // include IPs (only /inbounds/onlines does, which is 404 on
          // many panel versions). Show "— no IP" only when caller expects
          // IP but it's missing.
          if (user.ip) {
            msg += `• ${name} — ${user.ip}\n`;
          } else {
            msg += `• ${name}\n`;
          }
        }
        if (onlineUsers.length > 30) {
          msg += `\n... و ${onlineUsers.length - 30} کاربر دیگر`;
        }
        await sendTelegram(chatId, msg, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      } else if (onlineCount > 0) {
        await sendTelegram(chatId, `🟢 کاربران آنلاین ${panel.name}: ${onlineCount} نفر\n\n💡 منبع: ${source}\nℹ️ لیست دقیق از سرور قابل دریافت نیست.`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      } else {
        // All endpoints failed or returned empty — show diagnostic info
        let msg = `🟢 کاربران آنلاین ${panel.name}\n\n❌ نتایج از هیچ منبعی دریافت نشد.\n\n📋 endpoints تست شده:\n`;
        for (const t of triedEndpoints) msg += `${t}\n`;
        msg += `\n💡 برای تشخیص کامل‌تر، /paneltest را بزنید.`;
        await sendTelegram(chatId, msg, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      }
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
    }
  }
}

// Parse /panel/api/inbounds/list response and extract online clients.
// Each inbound has clientStats[] with { email, lastOnline, ... }
// A client is considered "online" if lastOnline is within last 2 minutes.
function extractOnlineFromInboundsList(response) {
  const users = [];
  if (!response) return users;
  const flat = flattenCandidates(response);
  const seen = new Set();
  const now = Date.now();
  const ONLINE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // Look for clientStats array (could be nested under any inbound object)
    const statsArrays = [
      item.clientStats, item.client_stats, item.stats,
      item.traffic, item.trafficStats, item.traffic_stats,
    ].filter((v) => Array.isArray(v));

    for (const stats of statsArrays) {
      for (const stat of stats) {
        if (!stat || typeof stat !== "object") continue;
        const email = stat.email || stat.clientEmail || "";
        const id = stat.id || stat.uuid || "";
        const ip = stat.ip || "";
        if (!email && !id) continue;

        const lastOnline = Number(stat.lastOnline || 0);
        if (lastOnline <= 0) continue; // never online

        // lastOnline might be in seconds or milliseconds
        const lastOnlineMs = lastOnline < 1e12 ? lastOnline * 1000 : lastOnline;
        if ((now - lastOnlineMs) > ONLINE_WINDOW_MS) continue; // not online now

        const key = (email || id) + ":" + ip;
        if (seen.has(key)) continue;
        seen.add(key);

        users.push({
          email: email || id,
          id,
          ip,
          total: Number(stat.total || 0),
          up: Number(stat.up || 0),
          down: Number(stat.down || 0),
          inboundId: item.id || "",
          lastOnline,
        });
      }
    }
  }
  return users;
}

// ─── Panel Endpoint Diagnostics (/paneltest) ──────────────────
// Tests all major panel endpoints with method-swap and reports results.
// This helps the admin see WHICH endpoints their panel version supports
// and what HTTP status each returns — crucial for diagnosing "404 everywhere"
// issues without server access.
async function handlePanelTest(chatId, args, env) {
  const panels = await getPanels(env);
  const targetPanelId = args[0] || null;
  const targetPanels = targetPanelId
    ? panels.filter((p) => p.id === targetPanelId)
    : panels;

  if (!targetPanels.length) {
    await sendTelegramWithBack(chatId, `❌ پنل یافت نشد. استفاده: /paneltest [panelId]`, env);
    return;
  }

  // List of endpoints to test, with both GET and POST.
  // Updated for 3x-ui v3.4.x — methods ordered by what version expects first.
  const endpoints = [
    { name: "Server Status",       path: API_PATHS.SERVER_STATUS,           methods: ["GET", "POST"] },
    { name: "Inbounds List",       path: API_PATHS.INBOUNDS_LIST,           methods: ["GET", "POST"] },
    { name: "Clients Onlines v3",  path: API_PATHS.CLIENTS_ONLINES,         methods: ["POST", "GET"] },  // v3.4.x
    { name: "Inbounds Onlines old",path: API_PATHS.INBOUNDS_ONLINE,         methods: ["GET", "POST"] },  // older
    { name: "Clients List",        path: API_PATHS.CLIENTS_LIST,            methods: ["GET", "POST"] },
    { name: "Server Logs v3",      path: API_PATHS.SERVER_GET_LOGS,         methods: ["POST", "GET"] },  // v3.4.x: /server/logs/100
    { name: "Xray Logs v3",        path: API_PATHS.SERVER_XRAY_LOGS,        methods: ["POST", "GET"] },  // v3.4.x: /server/xraylogs/100
    { name: "Panel Update Info",   path: API_PATHS.SERVER_PANEL_UPDATE,     methods: ["GET", "POST"] },  // v3.4.x: GET
    { name: "Xray Version",        path: API_PATHS.SERVER_GET_XRAY_VERSION, methods: ["GET", "POST"] },
    { name: "Settings All",        path: API_PATHS.SETTINGS_ALL,            methods: ["POST", "GET"] },  // v3.4.x: POST
    { name: "API Tokens v3",       path: API_PATHS.API_TOKENS_LIST,         methods: ["GET", "POST"] },  // v3.4.x: /setting/apiTokens GET
    { name: "Panel Users (old)",   path: API_PATHS.USERS_LIST,              methods: ["GET", "POST"] },  // removed in v3.4.x
    { name: "Nodes List",          path: API_PATHS.NODES_LIST,              methods: ["GET", "POST"] },
    { name: "Restart Panel v3",    path: API_PATHS.SETTINGS_RESTART_PANEL,  methods: ["POST"] },          // v3.4.x: /setting/restartPanel
  ];

  for (const panel of targetPanels) {
    let msg = `🧪 تست پنل: ${panel.name}\n`;
    msg += `🌐 URL: ${panel.panelUrl}\n`;
    msg += `🔑 Auth: ${panel.authType || "bearer"}\n`;
    msg += `📍 Prefix: ${panel.apiPrefix || "(none)"}\n\n`;
    msg += `📋 نتایج:\n`;

    for (const ep of endpoints) {
      let result = "❓";
      let detail = "";

      for (const method of ep.methods) {
        try {
          const response = await panelApi(panel, ep.path, method);
          // Success — try to summarize what we got
          const flat = flattenCandidates(response);
          const itemCount = flat.filter((x) => x && typeof x === "object").length;
          result = "✅";
          detail = `${method} ${itemCount} items`;
          break;
        } catch (e) {
          const errMsg = shortError(e);
          if (errMsg.includes("404") || errMsg.includes("405")) {
            result = "❌";
            detail = `${method} 404`;
            continue; // try next method
          } else if (errMsg.includes("401") || errMsg.includes("403")) {
            result = "🔒";
            detail = `${method} auth denied`;
            break;
          } else {
            result = "⚠️";
            detail = `${method} ${errMsg.slice(0, 30)}`;
            break;
          }
        }
      }

      msg += `${result} ${ep.name.padEnd(20)} ${detail}\n`;
    }

    msg += `\n💡 راهنما:\n`;
    msg += `✅ کار می‌کند | ❌ پنل این endpoint را ندارد | 🔒 توکن دسترسی ندارد | ⚠️ خطای دیگر\n`;
    msg += `\n💡 اگر endpoint‌ای ❌ شد، یعنی نسخه 3x-ui شما آن را پشتیبانی نمی‌کند.`;

    // Telegram message limit
    if (msg.length > 4000) msg = msg.slice(0, 3990) + "...";
    await sendTelegram(chatId, msg, env, [
      [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
    ]);
  }
}

// Extract online users from various response formats
function extractOnlineUsers(response) {
  const users = [];
  if (!response) return users;
  const flat = flattenCandidates(response);
  const seen = new Set();
  for (const item of flat) {
    if (!item || typeof item !== "object") continue;
    // 3x-ui /panel/api/inbounds/onlines returns objects with:
    //   { id, ip, total } — NO email field!
    // Older versions / clientStats responses include:
    //   { email, id, ip, total, up, down, lastOnline, enable, inboundId }
    const email = item.email || "";
    const ip = item.ip || "";
    const id = item.id || item.uuid || "";

    // Include if has at least an IP and an identifier (email OR id).
    // Previously required email, which silently dropped ALL entries
    // from the /inbounds/onlines endpoint (which never has email).
    if (ip && (email || id)) {
      const key = (email || id) + ":" + ip;
      if (seen.has(key)) continue;
      seen.add(key);

      // Check if lastOnline is recent (within 2 minutes = online)
      let isOnline = true;
      if (item.lastOnline) {
        const lastOnline = Number(item.lastOnline);
        if (lastOnline > 0) {
          // lastOnline might be in seconds or milliseconds
          const lastOnlineMs = lastOnline < 1e12 ? lastOnline * 1000 : lastOnline;
          isOnline = (Date.now() - lastOnlineMs) < 2 * 60 * 1000; // 2 minutes
        }
      }

      if (isOnline) {
        users.push({
          // Fall back to id if email is missing — display shows
          // "<email> — <ip>" when email exists, or "<id> — <ip>" otherwise.
          email: email || id,
          id: id,
          ip: ip,
          total: Number(item.total || 0),
          up: Number(item.up || 0),
          down: Number(item.down || 0),
          inboundId: item.inboundId || "",
          lastOnline: item.lastOnline || 0,
        });
      }
    }
  }
  return users;
}

async function handleVersions(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      const panelVer = await getPanelVersion(panel);
      const xrayVer = await getXrayVersion(panel);
      const msg = `📊 نسخه ها\n\n🖥️ سرور: ${panel.name}\n📡 پنل: ${panelVer}\n🔄 Xray: ${xrayVer || "نامشخص"}`;
      await sendTelegramWithBack(chatId, msg, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayRestart(chatId, args, env) {
  const panelId = args[0] || null;
  const panels = panelId ? [await resolvePanelAsync(env, panelId)].filter(Boolean) : await getPanels(env);
  for (const panel of panels) {
    try {
      await restartXray(panel);
      await sendTelegramWithBack(chatId, `✅ Xray در سرور "${panel.name}" ریستارت شد.`, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayStop(chatId, args, env) {
  const panelId = args[0] || null;
  const panels = panelId ? [await resolvePanelAsync(env, panelId)].filter(Boolean) : await getPanels(env);
  for (const panel of panels) {
    try {
      await stopXray(panel);
      await sendTelegramWithBack(chatId, `⛳ Xray در سرور "${panel.name}" متوقف شد.`, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayVersionCmd(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      const ver = await getXrayVersion(panel);
      await sendTelegramWithBack(chatId, `🔄 Xray نسخه (${panel.name}): ${ver || "نامشخص"}`, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayUpdate(chatId, args, env) {
  const version = args[0];
  if (!version) {
    await sendTelegramWithBack(chatId, "استفاده: /xray_update <نسخه>", env);
    return;
  }
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      await updateXray(panel, version);
      await sendTelegramWithBack(chatId, `✅ Xray به نسخه ${version} بروزرسانی شد (${panel.name}).`, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handlePanelVersionCmd(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      const ver = await getPanelVersion(panel);
      await sendTelegramWithBack(chatId, `📡 نسخه پنل (${panel.name}): ${ver}`, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handlePanelUpdateCmd(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      await updatePanel(panel);
      await sendTelegramWithBack(chatId, `✅ پنل "${panel.name}" بروزرسانی شد.`, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

// ─── Panel Management Commands ────────────────────────────────

async function handleListPanels(chatId, env) {
  const panels = await getPanels(env);
  let msg = `🖥️ لیست پنل‌ها:\n\n`;
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    msg += `${i + 1}. ${p.name} (${p.id})\n   🔗 ${p.panelUrl}\n\n`;
  }
  await sendTelegramWithBack(chatId, msg, env);
}

async function startAddPanel(chatId, env) {
  await statePut(env, `${STATE_ADDPANEL_PREFIX}${chatId}`, { step: "name" }, MS_PER_HOUR);
  await sendTelegram(chatId, "🖥️ افزودن پنل جدید\n\n📝 نام پنل را وارد کنید:", env, [
    [{ text: "❌ انصراف", callback_data: "admin_panels" }],
  ]);
}

async function handleAddPanelStep(chatId, state, text, env) {
  const backButton = [[{ text: "❌ انصراف", callback_data: "admin_panels" }]];
  if (state.step === "name") {
    state.name = text;
    state.step = "url";
    await statePut(env, `${STATE_ADDPANEL_PREFIX}${chatId}`, state, MS_PER_HOUR);
    await sendTelegram(chatId, "🔗 آدرس پنل را وارد کنید (URL):", env, backButton);
  } else if (state.step === "url") {
    state.panelUrl = trimUrl(text);
    state.step = "token";
    await statePut(env, `${STATE_ADDPANEL_PREFIX}${chatId}`, state, MS_PER_HOUR);
    await sendTelegram(chatId, "🔑 توکن API پنل را وارد کنید:", env, backButton);
  } else if (state.step === "token") {
    state.apiToken = text;
    state.step = "sub_base_url";
    await statePut(env, `${STATE_ADDPANEL_PREFIX}${chatId}`, state, MS_PER_HOUR);
    await sendTelegram(chatId, "🔗 آدرس اشتراک (SUB_BASE_URL) را وارد کنید (یا 0 برای رد شدن):", env, backButton);
  } else if (state.step === "sub_base_url") {
    state.subBaseUrl = text === "0" ? "" : trimUrl(text);
    state.id = slugify(state.name);
    state.subPath = "sub";
    state.inboundIds = [];
    state.adminChatIds = [];
    state.authType = "bearer";

    await addPanel(env, state);
    await stateDelete(env, `${STATE_ADDPANEL_PREFIX}${chatId}`);
    await sendTelegram(chatId, `✅ پنل "${state.name}" با موفقیت اضافه شد!`, env, [
      [{ text: "🔙 مدیریت پنل‌ها", callback_data: "admin_panels" }],
    ]);
  }
}

async function handleDeletePanel(chatId, args, env) {
  const panelId = args[0];
  if (!panelId) {
    await sendTelegramWithBack(chatId, "استفاده: /dellpanel <آیدی پنل>", env);
    return;
  }
  try {
    await removePanel(env, panelId);
    await sendTelegramWithBack(chatId, `✅ پنل "${panelId}" حذف شد.`, env);
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

// ─── Admin Management ─────────────────────────────────────────

async function handleMakeAdmin(chatId, env) {
  const allAdmins = await getAllAdminIdsAsync(env);
  if (allAdmins.length > 0) {
    await sendTelegramWithBack(chatId, "❌ فقط زمانی که هیچ ادمینی وجود ندارد می‌توانید ادمین شوید.", env);
    return;
  }
  await setSuperAdmin(env, chatId);
  await sendTelegramWithBack(chatId, `✅ شما به عنوان سوپر ادمین ثبت شدید!`, env);
}

async function handleAdminAdd(chatId, args, env) {
  const targetId = args[0];
  if (!targetId) {
    await sendTelegramWithBack(chatId, "استفاده: /adminadd <chatId>", env);
    return;
  }
  await addAdminId(env, targetId);
  await sendTelegramWithBack(chatId, `✅ کاربر ${targetId} به عنوان ادمین اضافه شد.`, env);
}

async function handleAdminDel(chatId, args, env) {
  const targetId = args[0];
  if (!targetId) {
    await sendTelegramWithBack(chatId, "استفاده: /admindel <chatId>", env);
    return;
  }
  await removeAdminId(env, targetId);
  await sendTelegramWithBack(chatId, `✅ کاربر ${targetId} از ادمین‌ها حذف شد.`, env);
}

// ─── User Usage & Renewal Request ─────────────────────────────

async function handleUserUsage(chatId, env) {
  await sendUserMenu(chatId, env);
}

async function handleRenewalRequest(chatId, env) {
  const user = await getUser(env, chatId);
  if (!user) {
    await sendTelegramWithBack(chatId, "❌ شما ثبت‌نام نکرده‌اید.", env);
    return;
  }

  // Check rate limit: 1 request per hour
  const rateLimitKey = `renewal_ratelimit:${chatId}`;
  const lastRequest = await kvGet(env, rateLimitKey);
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  if (lastRequest && lastRequest.timestamp && (now - lastRequest.timestamp) < oneHour) {
    const remaining = oneHour - (now - lastRequest.timestamp);
    const remainingMinutes = Math.ceil(remaining / (60 * 1000));
    await sendTelegram(chatId, `⏳ شما یک درخواست تمدید در این ساعت ارسال کرده‌اید.\n\n🕐 زمان باقیمانده تا درخواست بعدی: ${remainingMinutes} دقیقه`, env, [
      [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
    ]);
    return;
  }

  const buttons = [
    [
      { text: "📅 تمدید زمان", callback_data: `renew_req_days:${user.panelId}` },
      { text: "📦 افزایش حجم", callback_data: `renew_req_gb:${user.panelId}` },
    ],
    [
      { text: "📅📦 هر دو", callback_data: `renew_req_both:${user.panelId}` },
    ],
    [
      { text: "🔙 منوی اصلی", callback_data: "user_back" },
    ],
  ];

  await sendTelegram(chatId, "🔄 نوع تمدید را انتخاب کنید:", env, buttons);
}

async function handleRenewalAmountInput(chatId, renewState, text, env) {
  const amount = Number(text);
  if (isNaN(amount) || amount <= 0) {
    await sendTelegram(chatId, "❌ مقدار نامعتبر. لطفاً عدد معتبر وارد کنید:", env, [
      [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
    ]);
    return;
  }

  const user = await getUser(env, chatId);
  if (!user) {
    await stateDelete(env, `${STATE_RENEW_PREFIX}${chatId}`);
    return;
  }

  // Check rate limit again (in case user bypassed the menu)
  const rateLimitKey = `renewal_ratelimit:${chatId}`;
  const lastRequest = await kvGet(env, rateLimitKey);
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  if (lastRequest && lastRequest.timestamp && (now - lastRequest.timestamp) < oneHour) {
    const remaining = oneHour - (now - lastRequest.timestamp);
    const remainingMinutes = Math.ceil(remaining / (60 * 1000));
    await stateDelete(env, `${STATE_RENEW_PREFIX}${chatId}`);
    await sendTelegram(chatId, `⏳ شما یک درخواست تمدید در این ساعت ارسال کرده‌اید.\n\n🕐 زمان باقیمانده: ${remainingMinutes} دقیقه`, env, [
      [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
    ]);
    return;
  }

  const days = renewState.type === "days" || renewState.type === "both" ? amount : 0;
  const gb = renewState.type === "gb" || renewState.type === "both" ? amount : 0;

  const request = await createRenewalRequest(env, chatId, user.clientEmail, user.panelId, days, gb);

  // Record rate limit timestamp (1 hour TTL)
  await kvPut(env, rateLimitKey, { timestamp: now });

  await stateDelete(env, `${STATE_RENEW_PREFIX}${chatId}`);
  await sendTelegram(chatId, `✅ درخواست تمدید ارسال شد.\nلطفاً صبر کنید تا ادمین تایید کند.`, env, [
    [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
  ]);

  // Notify admins immediately
  const adminIds = await getSuperAdminIds(env);
  const panel = await resolvePanelAsync(env, user.panelId);
  const panelName = panel ? panel.name : user.panelId;

  const message =
    `🔄 درخواست تمدید جدید\n\n` +
    `👤 کاربر: ${user.clientEmail}\n` +
    `🖥️ سرور: ${panelName}\n` +
    `${days ? `📅 روز: +${days}\n` : ""}` +
    `${gb ? `📦 حجم: +${gb} GB\n` : ""}` +
    `🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;

  const btns = [
    [
      { text: "✅ تایید", callback_data: `renewal_approve:${request.id}` },
      { text: "❌ رد", callback_data: `renewal_reject:${request.id}` },
    ],
  ];

  for (const adminId of adminIds) {
    try { await sendTelegram(adminId, message, env, btns); } catch { /* ignore */ }
  }
}

// ─── Backup & Export ──────────────────────────────────────────

async function handleBackup(chatId, args, env) {
  const panelId = args[0] || null;
  const panels = panelId ? [await resolvePanelAsync(env, panelId)].filter(Boolean) : await getPanels(env);

  for (const panel of panels) {
    try {
      // Download backup from panel API (with auth headers)
      const headers = buildAuthHeaders(panel);
      const candidates = buildApiUrlCandidates(panel, API_PATHS.SERVER_GET_DB);
      let backupBuffer = null;
      let lastError = null;

      for (const url of candidates) {
        try {
          const response = await fetch(url, { method: "GET", headers });
          if (!response.ok) {
            lastError = new Error(`HTTP ${response.status}`);
            continue;
          }
          backupBuffer = await response.arrayBuffer();
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!backupBuffer) {
        throw lastError || new Error("Failed to download backup from all URL candidates");
      }

      const filename = `backup_${slugify(panel.name)}_${new Date().toISOString().slice(0, 10)}.db`;
      const caption = `📦 بکاپ - ${panel.name}\n🕐 ${new Date().toLocaleString("fa-IR")}`;
      await sendDocumentBuffer(chatId, backupBuffer, filename, caption, env);
    } catch (error) {
      await sendTelegramWithBack(chatId, `❌ خطا در بکاپ ${panel.name}: ${shortError(error)}`, env);
    }
  }
}

async function handleExportConfig(chatId, env) {
  try {
    const panels = await getPanels(env);
    const adminIds = await getSuperAdminIds(env);
    const users = await getAllUsers(env);
    const exportData = {
      panels: panels.map((p) => ({ id: p.id, name: p.name, panelUrl: p.panelUrl })),
      adminIds,
      registeredUsers: users.length,
      exportDate: new Date().toISOString(),
    };
    const msg = `📤 خروجی کانفیگ\n\n🖥️ پنل‌ها: ${panels.length}\n👥 ادمین‌ها: ${adminIds.length}\n👤 کاربران ثبت‌نام شده: ${users.length}\n\n\`\`\`json\n${JSON.stringify(exportData, null, 2)}\n\`\`\``;
    await sendTelegram(chatId, msg, env, null, "Markdown");
  } catch (error) {
    await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

// ─── Help ─────────────────────────────────────────────────────

async function handleHelp(chatId, isAdmin, env) {
  if (isAdmin) {
    const isSuper = await isSuperAdmin(env, chatId);

    if (isSuper) {
      // ───── SUPER ADMIN — full command list ─────
      const msg =
        `👑 دستورات سوپر ادمین:\n\n` +
        `🔍 /search <شناسه> — جستجوی کاربر\n` +
        `👤 /user <شناسه> — اطلاعات کاربر\n` +
        `➕ /create <شناسه> <روز> <حجم> [پنل] — ساخت کاربر\n` +
        `🗑 /delete <شناسه> — حذف کاربر\n` +
        `✅ /enable <شناسه> — فعال کردن\n` +
        `⛔ /disable <شناسه> — غیرفعال کردن\n` +
        `📦 /addgb <شناسه> <حجم> — افزایش حجم\n` +
        `⏱ /renew <شناسه> <روز> [پنل] — تمدید\n` +
        `🔗 /link <شناسه> — لینک اشتراک\n` +
        `👥 /clients [صفحه] — لیست کاربران\n\n` +
        `📊 /status [پنل] — وضعیت سرور\n` +
        `🟢 /online — کاربران آنلاین\n` +
        `📊 /report — گزارش روزانه\n` +
        `📊 /versions — نسخه پنل و Xray\n` +
        `🔄 /xray_restart [پنل] — ریستارت Xray\n` +
        `⛳ /xray_stop [پنل] — توقف Xray\n` +
        `🔄 /xray_version — نسخه Xray\n` +
        `🔄 /xray_update <نسخه> — بروزرسانی Xray\n` +
        `📡 /panel_version — نسخه پنل\n` +
        `📡 /panel_update — بروزرسانی پنل\n\n` +
        `🧪 /paneltest — تست اتصال به پنل و endpoint‌ها\n` +
        `☁️ /cf — مدیریت Cloudflare (DNS records)\n` +
        `🖥️ /ssh — ترمینال SSH سرورها\n` +
        `📊 /chart — نمودار مقایسه ترافیک پنل‌ها\n` +
        `⭐ /stars — مدیریت پرداخت Stars (سوپر) / خرید اعتبار (ادمین)\n` +
        `🌐 /lang <fa|en|zh|ru> — تغییر زبان\n\n` +
        `🖥️ مدیریت پنل:\n` +
        `/addpanel — افزودن پنل\n` +
        `/dellpanel <آیدی> — حذف پنل\n` +
        `/panels — لیست پنل‌ها\n` +
        `/backup [پنل] — دریافت بکاپ\n` +
        `/export — خروجی کانفیگ\n\n` +
        `🛠️ مدیریت ادمین:\n` +
        `/makeadmin — ادمین شدن (فقط اولین بار)\n` +
        `/addadmin <chatId> <panelIds> [maxUsers] — افزودن ادمین پنل\n` +
        `/removeadmin <chatId> — حذف ادمین پنل\n` +
        `/admins — لیست ادمین‌ها\n` +
        `/ban <chatId> [دلیل] — بن کاربر\n` +
        `/unban <chatId> — رفع بن\n` +
        `/suspend <chatId> <دقیقه> [دلیل] — تعلیق\n` +
        `/unsuspend <chatId> — لغو تعلیق\n` +
        `/bannedlist — لیست بن‌شدگان\n\n` +
        `/admin — پنل مدیریت`;
      await sendTelegram(chatId, msg, env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
    } else {
      // ───── PANEL ADMIN — limited command list ─────
      const msg =
        `🛠️ دستورات ادمین:\n\n` +
        `💡 شما فقط می‌توانید کاربر بسازید، تمدید کنید، حجم اضافه کنید یا حذف کنید.\n` +
        `💡 شما فقط به کاربرانی که خودتان ساخته‌اید دسترسی دارید.\n\n` +
        `➕ /create <شناسه> <روز> <حجم> [پنل] — ساخت کاربر\n` +
        `🗑 /delete <شناسه> — حذف کاربر (فقط کاربران خودتان)\n` +
        `📦 /addgb <شناسه> <حجم> — افزایش حجم (فقط کاربران خودتان)\n` +
        `⏱ /renew <شناسه> <روز> [پنل] — تمدید (فقط کاربران خودتان)\n` +
        `🔍 /search <شناسه> — جستجوی کاربر (فقط کاربران خودتان)\n` +
        `👤 /user <شناسه> — اطلاعات کاربر (فقط کاربران خودتان)\n` +
        `🔗 /link <شناسه> — لینک اشتراک (فقط کاربران خودتان)\n` +
        `👥 /clients [صفحه] — لیست کاربران من\n\n` +
        `🔄 /renew — بررسی درخواست‌های تمدید از کاربران\n\n` +
        `/admin — پنل مدیریت`;
      await sendTelegram(chatId, msg, env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
    }
  } else {
    const msg =
      `📖 دستورات:\n\n` +
      `/start — ثبت‌نام / مشاهده اطلاعات\n` +
      `/usage — مشاهده مصرف\n` +
      `/renew — درخواست تمدید\n` +
      `/lang <fa|en|zh|ru> — تغییر زبان\n` +
      `/stars — خرید اشتراک با Stars\n` +
      `/help — راهنما`;
    await sendTelegram(chatId, msg, env, [
      [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
    ]);
  }
}

// ─── Callback Query Handler ───────────────────────────────────

async function handleCallbackQuery(callbackQuery, env) {
  const chatId = String(callbackQuery.message?.chat?.id || "");
  const data = String(callbackQuery.data || "");
  const callbackQueryId = callbackQuery.id;
  const fromId = String(callbackQuery.from?.id || "");
  const messageId = callbackQuery.message?.message_id;
  const admin = await isAdminAsync(fromId, env);

  try {
    // ── Registration panel selection ──
    if (data.startsWith("reg_panel:")) {
      const panelId = data.split(":")[1];
      const regState = await stateGet(env, `${STATE_REG_PREFIX}${chatId}`);
      if (regState) {
        regState.step = "email";
        regState.panelId = panelId;
        await statePut(env, `${STATE_REG_PREFIX}${chatId}`, regState, MS_PER_HOUR);
        // Delete previous message
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, "📧 لطفاً ایمیل/شناسه کاربری خود را وارد کنید:", env, [
          [{ text: "🔙 شروع مجدد", callback_data: "reg_cancel" }],
        ]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Registration cancel ──
    if (data === "reg_cancel") {
      await stateDelete(env, `${STATE_REG_PREFIX}${chatId}`);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleStart(chatId, fromId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User back to main menu ──
    if (data === "user_back") {
      // Cancel any active states
      await stateDelete(env, `${STATE_REG_PREFIX}${chatId}`);
      await stateDelete(env, `${STATE_RENEW_PREFIX}${chatId}`);
      if (messageId) await deleteMessage(chatId, messageId, env);
      if (admin) {
        await sendAdminMenu(chatId, env);
      } else {
        await sendUserMenu(chatId, env);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User help ──
    if (data === "user_help") {
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleHelp(chatId, admin, env);
      await sendTelegram(chatId, "👇", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User backup info ──
    if (data === "user_backup_info") {
      if (messageId) await deleteMessage(chatId, messageId, env);
      const backup = await getUserBackup(env, chatId);
      if (backup) {
        await sendTelegram(chatId, formatUserBackup(backup), env, [
          [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
        ]);
      } else {
        await sendTelegram(chatId, "❌ اطلاعات پشتیبانی برای شما موجود نیست.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
        ]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User subscription link ──
    if (data.startsWith("user_sublink:")) {
      const panelId = data.split(":")[1];
      const user = await getUser(env, chatId);
      if (!user) {
        await answerCallbackQuery(callbackQueryId, env, "ثبت‌نام نکرده‌اید");
        return;
      }
      const panel = await resolvePanelAsync(env, panelId || user.panelId);
      const client = await getClientByIdentifier(user.clientEmail, env, panelId || user.panelId);
      if (client && panel) {
        const subId = client.subId || client.subid || client.sub_id || "";
        if (subId) {
          try {
            const link = await buildSubLinkAsync(subId, panel, env);
            const qrUrl = `${QR_CODE_API}?size=${QR_CODE_SIZE}x${QR_CODE_SIZE}&data=${encodeURIComponent(link)}`;
            if (messageId) await deleteMessage(chatId, messageId, env);
            await sendPhoto(chatId, qrUrl, `🔗 لینک اشتراک:\n${link}`, env, [
              [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
            ]);
          } catch (e) {
            if (messageId) await deleteMessage(chatId, messageId, env);
            await sendTelegram(chatId, `❌ لینک اشتراک: ${shortError(e)}`, env, [
              [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
            ]);
          }
        } else {
          await answerCallbackQuery(callbackQueryId, env, "لینک اشتراک موجود نیست");
        }
      } else {
        await answerCallbackQuery(callbackQueryId, env, "کاربر یافت نشد");
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User renewal request buttons ──
    if (data.startsWith("user_renew:")) {
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleRenewalRequest(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("user_addgb:")) {
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.split(":")[1];
      await statePut(env, `${STATE_RENEW_PREFIX}${chatId}`, { type: "gb", panelId }, MS_PER_HOUR);
      await sendTelegram(chatId, "📦 چند گیگابایت حجم می‌خواهید؟ (مثلاً 50)", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User refresh ──
    if (data.startsWith("refresh:")) {
      const panelId = data.split(":")[1];
      const user = await getUser(env, chatId);
      if (!user) {
        await answerCallbackQuery(callbackQueryId, env, "ثبت‌نام نکرده‌اید");
        return;
      }
      const client = await getClientByIdentifier(user.clientEmail, env, panelId || user.panelId);
      const panel = await resolvePanelAsync(env, panelId || user.panelId);
      if (client && panel) {
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendUserMenu(chatId, env);
      } else {
        await sendTelegramWithBack(chatId, "❌ کاربر یافت نشد.", env);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User renewal request buttons (old style) ──
    if (data.startsWith("renew_req_days:")) {
      const panelId = data.split(":")[1];
      // Check rate limit first
      const rateLimitKey = `renewal_ratelimit:${chatId}`;
      const lastRequest = await kvGet(env, rateLimitKey);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (lastRequest && lastRequest.timestamp && (now - lastRequest.timestamp) < oneHour) {
        const remaining = oneHour - (now - lastRequest.timestamp);
        const remainingMinutes = Math.ceil(remaining / (60 * 1000));
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `⏳ شما یک درخواست تمدید در این ساعت ارسال کرده‌اید.\n\n🕐 زمان باقیمانده: ${remainingMinutes} دقیقه`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      await statePut(env, `${STATE_RENEW_PREFIX}${chatId}`, { type: "days", panelId }, MS_PER_HOUR);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, "📅 چند روز تمدید می‌خواهید؟ (مثلاً 30)", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("renew_req_gb:")) {
      const panelId = data.split(":")[1];
      const rateLimitKey = `renewal_ratelimit:${chatId}`;
      const lastRequest = await kvGet(env, rateLimitKey);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (lastRequest && lastRequest.timestamp && (now - lastRequest.timestamp) < oneHour) {
        const remaining = oneHour - (now - lastRequest.timestamp);
        const remainingMinutes = Math.ceil(remaining / (60 * 1000));
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `⏳ شما یک درخواست تمدید در این ساعت ارسال کرده‌اید.\n\n🕐 زمان باقیمانده: ${remainingMinutes} دقیقه`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      await statePut(env, `${STATE_RENEW_PREFIX}${chatId}`, { type: "gb", panelId }, MS_PER_HOUR);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, "📦 چند گیگابایت حجم می‌خواهید؟ (مثلاً 50)", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("renew_req_both:")) {
      const panelId = data.split(":")[1];
      const rateLimitKey = `renewal_ratelimit:${chatId}`;
      const lastRequest = await kvGet(env, rateLimitKey);
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (lastRequest && lastRequest.timestamp && (now - lastRequest.timestamp) < oneHour) {
        const remaining = oneHour - (now - lastRequest.timestamp);
        const remainingMinutes = Math.ceil(remaining / (60 * 1000));
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `⏳ شما یک درخواست تمدید در این ساعت ارسال کرده‌اید.\n\n🕐 زمان باقیمانده: ${remainingMinutes} دقیقه`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      await statePut(env, `${STATE_RENEW_PREFIX}${chatId}`, { type: "both", panelId }, MS_PER_HOUR);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, "📅📦 مقدار مورد نیاز را وارد کنید (اعداد یکسان برای روز و حجم):", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Renewal approve/reject ──
    if (data.startsWith("renewal_approve:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const requestId = data.split(":")[1];
      const request = await getRenewalRequest(env, requestId);
      if (!request || request.status !== "pending") {
        await answerCallbackQuery(callbackQueryId, env, "درخواست یافت نشد");
        return;
      }
      try {
        const panel = await resolvePanelAsync(env, request.panelId);
        if (!panel) throw new Error("پنل یافت نشد");
        const client = await getClientByIdentifier(request.clientEmail, env, request.panelId);
        if (!client) throw new Error("کاربر یافت نشد");

        if (request.daysRequested) await addDaysToClient(panel, client, request.daysRequested);
        if (request.gbRequested) await addGBToClient(panel, client, request.gbRequested);

        await updateRenewalStatus(env, requestId, "approved");
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `✅ درخواست تمدید "${request.clientEmail}" تایید شد.`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        // Notify user
        try {
          await sendTelegram(request.chatId, `✅ درخواست تمدید شما تایید شد!`, env);
        } catch { /* ignore */ }
        await answerCallbackQuery(callbackQueryId, env, "✅ تایید شد");
      } catch (error) {
        await answerCallbackQuery(callbackQueryId, env, `خطا: ${shortError(error)}`);
      }
      return;
    }

    if (data.startsWith("renewal_reject:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const requestId = data.split(":")[1];
      await updateRenewalStatus(env, requestId, "rejected");
      const request = await getRenewalRequest(env, requestId);
      if (messageId) await deleteMessage(chatId, messageId, env);
      if (request) {
        await sendTelegram(chatId, `❌ درخواست تمدید "${request.clientEmail}" رد شد.`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        try {
          await sendTelegram(request.chatId, `❌ درخواست تمدید شما رد شد.`, env);
        } catch { /* ignore */ }
      }
      await answerCallbackQuery(callbackQueryId, env, "❌ رد شد");
      return;
    }

    // ── Xray restart (from alert or command) ──
    if (data.startsWith("xray_restart:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const panelId = data.split(":")[1];
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) { await answerCallbackQuery(callbackQueryId, env, "پنل یافت نشد"); return; }
      try {
        await restartXray(panel);
        await kvPut(env, `${KV_ALERT_PREFIX}xray:${panelId}`, { timestamp: Date.now(), status: "running" });
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `✅ Xray در سرور "${panel.name}" ریستارت شد.`, env, [
          [{ text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "✅ Xray ریستارت شد");
      } catch (error) {
        await answerCallbackQuery(callbackQueryId, env, `خطا: ${shortError(error)}`);
      }
      return;
    }

    // ── Xray stop ──
    if (data.startsWith("xray_stop:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const panelId = data.split(":")[1];
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) { await answerCallbackQuery(callbackQueryId, env, "پنل یافت نشد"); return; }
      try {
        await stopXray(panel);
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `⏹ Xray در سرور "${panel.name}" متوقف شد.`, env, [
          [{ text: "🔄 ریستارت", callback_data: `xray_restart:${panel.id}` }, { text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "⏹ Xray متوقف شد");
      } catch (error) {
        await answerCallbackQuery(callbackQueryId, env, `خطا: ${shortError(error)}`);
      }
      return;
    }

    // ── Server status (from button - early handler) ──
    if (data.startsWith("server_status:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.split(":")[1];
      await handleStatus(chatId, [panelId], env);
      await sendTelegram(chatId, "👇", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Clients page navigation ──
    if (data.startsWith("clients_page:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const page = Number(data.split(":")[1]);
      await handleClients(chatId, [page], env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Admin back to main menu ──
    // ── Super admin choice menu (3x-ui vs Cloudflare) ──
    if (data === "sa_xui") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendAdminMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data === "sa_cf") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      // Cancel any active CF state
      await stateDelete(env, `cf_add_action:${chatId}`);
      await sendCfMainMenu(chatId, env, "fa");
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Cloudflare menu ──
    if (data === "cf_back") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      await stateDelete(env, `cf_add_action:${chatId}`);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendCfMainMenu(chatId, env, "fa");
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data === "cf_zones") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendCfZonesList(chatId, env, "fa");
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    // ── User Stars payment (for regular users) ──
    if (data === "user_stars") {
      const plans = await getStarsPlans(env);
      if (!plans.length) {
        await sendTelegram(chatId, "❌ هیچ طرح پرداختی در دسترس نیست.", env, [
          [{ text: "🔙", callback_data: "user_back" }],
        ]);
      } else {
        let msg = "⭐ خرید اشتراک\n\n💡 با Stars تلگرام پرداخت کنید:\n";
        const buttons = plans.map(p => [{
          text: `${p.name} — ${p.stars}⭐`,
          callback_data: `stars_buy:${p.id}`,
        }]);
        buttons.push([{ text: "🔙", callback_data: "user_back" }]);
        await sendTelegram(chatId, msg, env, buttons);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "cf_toggle_lang" || data === "user_lang" || data === "admin_lang") {
      // Language selector — works for all users (CF menu, admin, user)
      if (messageId) await deleteMessage(chatId, messageId, env);
      const currentLang = await getUserLang(env, chatId);
      const langNames = { fa: "فارسی", en: "English", zh: "中文", ru: "Русский" };
      const buttons = [
        [
          { text: `🇮🇷 فارسی ${currentLang === "fa" ? "✅" : ""}`, callback_data: "setlang:fa" },
          { text: `🇬🇧 English ${currentLang === "en" ? "✅" : ""}`, callback_data: "setlang:en" },
        ],
        [
          { text: `🇨🇳 中文 ${currentLang === "zh" ? "✅" : ""}`, callback_data: "setlang:zh" },
          { text: `🇷🇺 Русский ${currentLang === "ru" ? "✅" : ""}`, callback_data: "setlang:ru" },
        ],
        [{ text: "🔙", callback_data: admin ? "admin_back" : "user_back" }],
      ];
      await sendTelegram(chatId,
        `🌐 انتخاب زبان / Select language / 选择语言 / Выбор языка\n\n` +
        `زبان فعلی: ${langNames[currentLang] || "فارسی"}`,
        env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data.startsWith("setlang:")) {
      const lang = data.slice("setlang:".length);
      const validLangs = ["fa", "en", "zh", "ru"];
      if (!validLangs.includes(lang)) {
        await answerCallbackQuery(callbackQueryId, env, "نامعتبر");
        return;
      }
      // For regular users, save in user record
      const user = await getUser(env, chatId);
      if (user) {
        user.language = lang;
        await kvPut(env, `${KV_USERS_PREFIX}${chatId}`, user);
      } else {
        // For admins who aren't registered users, store separately
        await kvPut(env, `lang:${chatId}`, lang);
      }
      const langNames = { fa: "فارسی", en: "English", zh: "中文", ru: "Русский" };
      const msg = {
        fa: `✅ زبان تغییر کرد: فارسی`,
        en: `✅ Language changed: English`,
        zh: `✅ 语言已更改: 中文`,
        ru: `✅ Язык изменен: Русский`,
      };
      await answerCallbackQuery(callbackQueryId, env, msg[lang]);
      if (messageId) await deleteMessage(chatId, messageId, env);
      // Return to appropriate menu
      if (admin) {
        await sendAdminMenu(chatId, env);
      } else {
        await sendUserMenu(chatId, env);
      }
      return;
    }
    if (data.startsWith("cf_zone:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const zoneId = data.slice("cf_zone:".length);
      await sendCfZoneDnsRecords(chatId, env, zoneId, "fa");
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data.startsWith("cf_dns_page:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const zoneId = parts[1];
      const page = Number(parts[2]) || 1;
      await sendCfZoneDnsRecords(chatId, env, zoneId, "fa", page);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data.startsWith("cf_dns:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const zoneId = parts[1];
      const recordId = parts.slice(2).join(":");
      await sendCfDnsRecordDetail(chatId, env, zoneId, recordId, "fa");
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data.startsWith("cf_dns_toggle:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const parts = data.split(":");
      const zoneId = parts[1];
      const recordId = parts.slice(2).join(":");
      try {
        const records = await cfListDnsRecords(env, zoneId);
        const record = records.find(r => r.id === recordId);
        if (!record) throw new Error("رکورد یافت نشد");
        await cfUpdateDnsRecord(env, zoneId, recordId, {
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl || 1,
          proxied: !record.proxied,
        });
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendCfDnsRecordDetail(chatId, env, zoneId, recordId, "fa");
        await answerCallbackQuery(callbackQueryId, env,
          record.proxied ? "پروکسی غیرفعال شد" : "پروکسی فعال شد");
      } catch (error) {
        await answerCallbackQuery(callbackQueryId, env, "خطا");
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env,
          [[{ text: "🔙", callback_data: `cf_zone:${zoneId}` }]]
        );
      }
      return;
    }
    if (data.startsWith("cf_dns_del_confirm:")) {
      // This handler is now unreachable — cf_dns_del_confirm uses act: tokens
      // (see cfCallback function). Keeping the code for reference, but all
      // new buttons use the act: token path which handles the delete
      // confirmation in the act: handler above.
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const parts = data.split(":");
      const zoneId = parts[1];
      const recordId = parts.slice(2).join(":");
      // Use action token for the actual delete (long callback_data)
      const token = await setAction(chatId, "cf_dns_del_yes", `${zoneId}:${recordId}`, env, zoneId);
      // For "خیر" (no), go back to record detail — also use act: token
      const noToken = await cfCallback(chatId, "cf_dns", zoneId, recordId, env);
      await sendTelegram(chatId,
        `⚠️ آیا مطمئنید این DNS record حذف شود؟\n\n🆔 ${recordId}\n\n❌ این عمل قابل بازگشت نیست!`,
        env,
        [
          [
            { text: "✅ بله، حذف شود", callback_data: `act:${token}` },
            { text: "❌ خیر", callback_data: noToken },
          ],
          [{ text: "🔙 رکوردها", callback_data: `cf_zone:${zoneId}` }],
        ]
      );
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Cloudflare: Add DNS record flow (multi-step FSM) ──
    // Step 1: Select zone (from list of zones)
    if (data === "cf_dns_add_zone") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      try {
        const zones = await cfListZones(env);
        if (!zones.length) {
          await sendTelegram(chatId, "❌ هیچ دامنه‌ای یافت نشد.", env,
            [[{ text: "🔙", callback_data: "cf_back" }]]
          );
          await answerCallbackQuery(callbackQueryId, env);
          return;
        }
        const buttons = zones.slice(0, 30).map(z => [{
          text: `${z.status === "active" ? "🟢" : "⏳"} ${z.name}`,
          callback_data: `cf_dns_add_type:${z.id}`,
        }]);
        buttons.push([{ text: "🔙 منوی Cloudflare", callback_data: "cf_back" }]);
        await sendTelegram(chatId,
          "➕ افزودن DNS Record\n\n🌐 یک دامنه را انتخاب کنید:",
          env, buttons);
      } catch (error) {
        await sendTelegram(chatId, `❌ ${shortError(error)}`, env,
          [[{ text: "🔙", callback_data: "cf_back" }]]
        );
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    // Step 2: Select record type (A, AAAA, CNAME, TXT, MX, ...)
    if (data.startsWith("cf_dns_add_type:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const zoneId = data.slice("cf_dns_add_type:".length);
      if (messageId) await deleteMessage(chatId, messageId, env);
      const types = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA"];
      const buttons = [];
      for (let i = 0; i < types.length; i += 3) {
        const row = [];
        for (let j = i; j < Math.min(i + 3, types.length); j++) {
          row.push({ text: types[j], callback_data: `cf_dns_add_name:${zoneId}:${types[j]}` });
        }
        buttons.push(row);
      }
      buttons.push([{ text: "🔙 دامنه‌ها", callback_data: "cf_zones" }]);
      await sendTelegram(chatId, "🏷 نوع DNS record را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    // Step 3: Prompt for record name
    if (data.startsWith("cf_dns_add_name:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const parts = data.split(":");
      const zoneId = parts[1];
      const type = parts.slice(2).join(":");
      if (messageId) await deleteMessage(chatId, messageId, env);
      await statePut(env, `cf_add_action:${chatId}`, { step: "name", zoneId, type }, MS_PER_HOUR);
      await sendTelegram(chatId,
        `📛 نام record را وارد کنید (مثلاً @ یا sub یا www):\n\n💡 برای رکورد ریشه از @ استفاده کنید.`,
        env,
        [[{ text: "❌ انصراف", callback_data: "cf_back" }]]
      );
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    // Step 4: Choose proxied → create the record
    if (data.startsWith("cf_dns_add_proxied:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const proxied = data.slice("cf_dns_add_proxied:".length) === "1";
      const cfAddState = await stateGet(env, `cf_add_action:${chatId}`);
      if (!cfAddState || cfAddState.step !== "proxied") {
        await answerCallbackQuery(callbackQueryId, env, "نشست منقضی شده");
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, "❌ نشست منقضی شده است. دوباره تلاش کنید.", env,
          [[{ text: "🔙", callback_data: "cf_back" }]]
        );
        return;
      }
      await stateDelete(env, `cf_add_action:${chatId}`);
      try {
        const result = await cfCreateDnsRecord(env, cfAddState.zoneId, {
          type: cfAddState.type,
          name: cfAddState.name,
          content: cfAddState.content,
          ttl: 1,  // Auto
          proxied,
        });
        if (messageId) await deleteMessage(chatId, messageId, env);
        const rec = result?.result || result;
        const msg = `✅ DNS record ساخته شد!\n\n${formatCfDnsRecord(rec, "fa")}`;
        await sendTelegram(chatId, msg, env,
          [
            [{ text: "🔙 رکوردها", callback_data: `cf_zone:${cfAddState.zoneId}` }],
            [{ text: "➕ افزودن رکورد دیگر", callback_data: `cf_dns_add_type:${cfAddState.zoneId}` }],
          ]
        );
        await answerCallbackQuery(callbackQueryId, env, "ساخته شد");
      } catch (error) {
        if (messageId) await deleteMessage(chatId, messageId, env);
        await sendTelegram(chatId, `❌ خطا در ساخت رکورد: ${shortError(error)}`, env,
          [
            [{ text: "🔄 تلاش مجدد", callback_data: `cf_dns_add_type:${cfAddState.zoneId}` }],
            [{ text: "🔙 منوی Cloudflare", callback_data: "cf_back" }],
          ]
        );
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    if (data === "admin_back") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      // Cancel any active states
      await stateDelete(env, `${STATE_ADDPANEL_PREFIX}${chatId}`);
      await stateDelete(env, `${STATE_REG_PREFIX}${chatId}`);
      await stateDelete(env, `search_action:${chatId}`);
      await stateDelete(env, `create_action:${chatId}`);
      await stateDelete(env, `xray_update_action:${chatId}`);
      await stateDelete(env, `addgb_action:${chatId}`);
      await stateDelete(env, `renew_action:${chatId}`);
      await stateDelete(env, `node_add_action:${chatId}`);
      await stateDelete(env, `ban_action:${chatId}`);
      await stateDelete(env, `ban_reason:${chatId}`);
      await stateDelete(env, `suspend_action:${chatId}`);
      await stateDelete(env, `suspend_min:${chatId}`);
      await stateDelete(env, `suspend_reason:${chatId}`);
      await stateDelete(env, `addadmin_action:${chatId}`);
      await stateDelete(env, `cf_add_action:${chatId}`);  // Also cancel CF add state
      await stateDelete(env, `stars_add_action:${chatId}`);  // Also cancel Stars add state
      await stateDelete(env, `ssh_action:${chatId}`);  // Also cancel SSH state
      // For super admins with CF token, go to choice menu; otherwise plain admin menu
      const isSuper = await isSuperAdmin(env, chatId);
      const hasCfToken = Boolean(getCfToken(env));
      if (messageId) await deleteMessage(chatId, messageId, env);
      if (isSuper && hasCfToken) {
        await sendSuperAdminChoiceMenu(chatId, env);
      } else {
        await sendAdminMenu(chatId, env);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_status") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleStatus(chatId, [], env);
      // Show back button after status
      await sendTelegram(chatId, "👇", env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_search") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      await statePut(env, `search_action:${chatId}`, { step: "input" }, MS_PER_HOUR);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, "🔍 شناسه کاربر (ایمیل) را وارد کنید:", env, [
        [{ text: "❌ انصراف", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_clients") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleClients(chatId, [], env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_create") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendCreateUserMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("create_on_panel:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const panelId = data.slice("create_on_panel:".length);
      await statePut(env, `create_action:${chatId}`, { step: "email", panelId }, MS_PER_HOUR);
      const panel = await resolvePanelAsync(env, panelId);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, `➕ ساخت کاربر جدید در ${panel ? panel.name : panelId}\n\n📧 ایمیل/شناسه کاربر را وارد کنید:`, env, [
        [{ text: "❌ انصراف", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_panels") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      // Cancel any active addpanel state
      await stateDelete(env, `${STATE_ADDPANEL_PREFIX}${chatId}`);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendPanelsMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_addpanel") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      await statePut(env, `addpanel:${chatId}`, { step: "name" }, MS_PER_HOUR);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, "➕ افزودن پنل جدید\n\n📝 نام پنل را وارد کنید:", env, [
        [{ text: "❌ انصراف", callback_data: "admin_panels" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_del_confirm:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const panelId = data.slice("panel_del_confirm:".length);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, `⚠️ آیا مطمئنید پنل "${panelId}" حذف شود؟`, env, [
        [
          { text: "✅ بله، حذف شود", callback_data: `panel_del_yes:${panelId}` },
          { text: "❌ خیر", callback_data: "admin_panels" },
        ],
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_del_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const panelId = data.slice("panel_del_yes:".length);
      if (messageId) await deleteMessage(chatId, messageId, env);
      try {
        await removePanel(env, panelId);
        await sendTelegram(chatId, `✅ پنل "${panelId}" حذف شد.`, env, [
          [{ text: "🔙 مدیریت پنل‌ها", callback_data: "admin_panels" }],
        ]);
      } catch (error) {
        await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_renewals") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const pending = await getPendingRenewals(env);
      if (!pending.length) {
        await sendTelegram(chatId, "✅ درخواست تمدیدی منتظر نیست.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      } else {
        let msg = `🔄 درخواست‌های تمدید منتظر (${pending.length}):\n\n`;
        for (const r of pending) {
          msg += `👤 ${r.clientEmail}\n`;
          if (r.daysRequested) msg += `   📅 +${r.daysRequested} روز\n`;
          if (r.gbRequested) msg += `   📦 +${r.gbRequested} GB\n`;
        }
        await sendTelegram(chatId, msg, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_xray") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendXrayMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_xray_update") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      await statePut(env, `xray_update_action:${chatId}`, { step: "version" }, MS_PER_HOUR);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, "🔄 نسخه Xray مورد نظر را وارد کنید (مثلاً 1.8.24 یا latest):", env, [
        [{ text: "❌ انصراف", callback_data: "admin_xray" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("xray_version:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("xray_version:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        const version = await getXrayVersion(panel);
        await sendTelegram(chatId, `📡 نسخه Xray در سرور "${panel.name}":\n\n${version || "نامشخص"}`, env, [
          [{ text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "نسخه دریافت شد");
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در دریافت نسخه: ${shortError(error)}`, env, [
          [{ text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    if (data.startsWith("xray_stop:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const panelId = data.slice("xray_stop:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (messageId) await deleteMessage(chatId, messageId, env);
      if (panel) {
        try {
          await stopXray(panel);
          await sendTelegram(chatId, `⏹ Xray در "${panel.name}" متوقف شد.`, env, [
            [{ text: "🔄 ریستارت", callback_data: `xray_restart:${panel.id}` }, { text: "🔙 مدیریت Xray", callback_data: "admin_xray" }],
          ]);
        } catch (error) {
          await sendTelegramWithBack(chatId, `❌ خطا: ${shortError(error)}`, env);
        }
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_backup") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleBackup(chatId, [], env);
      await sendTelegram(chatId, "👇", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_export") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleExportConfig(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_report") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendDailyReportAllPanels(env);
      await sendTelegram(chatId, "📊 گزارش روزانه ارسال شد.", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_online") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleOnline(chatId, [], env);
      await sendTelegram(chatId, "👇", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_versions") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleVersions(chatId, [], env);
      await sendTelegram(chatId, "👇", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── User backups list (admin) ──
    if (data === "admin_user_backups") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      try {
        const backups = await getAllUserBackups(env);
        if (!backups.length) {
          await sendTelegram(chatId, "❌ هیچ بکاپ کاربری موجود نیست.", env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
        } else {
          let msg = `💾 بکاپ کاربران (${backups.length}):\n\n`;
          for (const backup of backups.slice(0, 30)) {
            const status = backup.daysRemaining !== null && backup.daysRemaining > 0 ? "🟢" : "⏰";
            msg += `${status} 👤 ${backup.clientEmail || "نامشخص"}\n`;
            msg += `   🖥 ${backup.panelName || "نامشخص"}\n`;
            msg += `   📦 ${(backup.usedGB || 0).toFixed(2)} / ${backup.totalGB !== null ? backup.totalGB.toFixed(2) + " GB" : "نامحدود"}\n`;
            if (backup.daysRemaining !== null) msg += `   ⏳ ${backup.daysRemaining} روز\n`;
            msg += `   🕐 ${new Date(backup.lastUpdated).toLocaleDateString("fa-IR")}\n\n`;
          }
          if (backups.length > 30) {
            msg += `\n... و ${backups.length - 30} کاربر دیگر`;
          }
          await sendTelegram(chatId, msg, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
        }
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── API Tokens management ──
    if (data === "admin_api_tokens") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      /** @type {any[][]} */
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `🔑 ${panel.name}`, callback_data: `panel_api_tokens:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "🔑 توکن‌های API\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_api_tokens:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("panel_api_tokens:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        const tokens = await listApiTokens(panel);
        let msg = `🔑 توکن‌های API سرور "${panel.name}" (${tokens.length}):\n\n`;
        /** @type {any[][]} */
        const buttons = [];
        if (tokens.length === 0) {
          msg += "❌ هیچ توکنی یافت نشد.";
        } else {
          for (const token of tokens) {
            const status = token.enabled ? "🟢" : "⛔";
            msg += `${status} ID: ${token.id} | ${token.name}\n`;
            if (token.token) msg += `   🔑 ${token.token.slice(0, 8)}...${token.token.slice(-4)}\n`;
            buttons.push([{ text: `🗑 حذف ${token.name}`, callback_data: `api_token_del_confirm:${panelId}:${token.id}` }]);
          }
        }
        buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
        await sendTelegram(chatId, msg, env, buttons);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("api_token_del_confirm:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const panelId = parts[1];
      const tokenId = parts.slice(2).join(":");
      await sendTelegram(chatId, `⚠️ آیا مطمئنید توکن "${tokenId}" حذف شود؟`, env, [
        [
          { text: "✅ بله، حذف شود", callback_data: `api_token_del_yes:${panelId}:${tokenId}` },
          { text: "❌ خیر", callback_data: `panel_api_tokens:${panelId}` },
        ],
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("api_token_del_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const panelId = parts[1];
      const tokenId = parts.slice(2).join(":");
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        await deleteApiToken(panel, tokenId);
        await sendTelegram(chatId, `✅ توکن "${tokenId}" حذف شد.`, env, [
          [{ text: "🔙 توکن‌های API", callback_data: `panel_api_tokens:${panelId}` }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "حذف شد");
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [
          [{ text: "🔙 توکن‌های API", callback_data: `panel_api_tokens:${panelId}` }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    // ── Outbounds ──
    if (data === "admin_outbounds") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      /** @type {any[][]} */
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `📡 ${panel.name}`, callback_data: `panel_outbounds:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "📡 Outbounds\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_outbounds:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("panel_outbounds:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        const outbounds = await listOutbounds(panel);
        let msg = `📡 Outbounds سرور "${panel.name}" (${outbounds.length}):\n\n`;
        if (outbounds.length === 0) {
          msg += "❌ هیچ outbound‌ای یافت نشد.";
        } else {
          for (const ob of outbounds) {
            msg += `🔹 ${ob.tag} (${ob.protocol || "نامشخص"})\n`;
          }
        }
        await sendTelegram(chatId, msg, env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Outbound traffic ──
    if (data === "admin_outbound_traffic") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      let msg = `📤 ترافیک Outbound:\n\n`;
      for (const panel of panels) {
        try {
          const traffics = await getOutboundsTraffic(panel);
          if (traffics.length === 0) continue;
          msg += `🖥️ ${panel.name}:\n`;
          for (const t of traffics) {
            const used = t.up + t.down;
            msg += `   📡 ${t.tag}: ⬆️ ${formatGB(t.up)} | ⬇️ ${formatGB(t.down)}`;
            if (t.total > 0) msg += ` | کل: ${formatGB(t.total)}`;
            msg += `\n`;
          }
          msg += `\n`;
        } catch (error) {
          msg += `❌ ${panel.name}: ${shortError(error)}\n\n`;
        }
      }
      if (msg === `📤 ترافیک Outbound:\n\n`) msg += "❌ هیچ ترافیکی یافت نشد.";
      await sendTelegram(chatId, msg, env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Reset inbound traffic ──
    if (data === "admin_reset_inbound_traffic") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      /** @type {any[][]} */
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `📥 ${panel.name}`, callback_data: `reset_inbound_traffic:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "📥 ریست ترافیک تمام Inboundها\n⚠️ این عمل تمام ترافیک کاربران را صفر می‌کند!\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("reset_inbound_traffic:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("reset_inbound_traffic:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      await sendTelegram(chatId, `⚠️ آیا مطمئنید ترافیک تمام inboundهای سرور "${panel.name}" ریست شود؟`, env, [
        [
          { text: "✅ بله، ریست شود", callback_data: `reset_inbound_yes:${panelId}` },
          { text: "❌ خیر", callback_data: "admin_reset_inbound_traffic" },
        ],
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("reset_inbound_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("reset_inbound_yes:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        await panelApi(panel, API_PATHS.INBOUNDS_RESET_TRAFFIC, "POST");
        await sendTelegram(chatId, `✅ ترافیک تمام inboundهای "${panel.name}" ریست شد.`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "ریست شد");
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    // ── Settings ──
    if (data === "admin_settings") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      /** @type {any[][]} */
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `⚙️ ${panel.name}`, callback_data: `panel_settings:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "⚙️ تنظیمات پنل\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_settings:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("panel_settings:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        const settings = await getAllSettings(panel);
        let msg = `⚙️ تنظیمات سرور "${panel.name}":\n\n`;
        if (!settings) {
          msg += "❌ دریافت تنظیمات ناموفق بود.";
        } else {
          // Show key settings
          const webDomain = settings.webDomain || "نامشخص";
          const webPort = settings.webPort || "نامشخص";
          const webListen = settings.webListen || "نامشخص";
          const subEnable = settings.subEnable ? "✅ فعال" : "❌ غیرفعال";
          const subPort = settings.subPort || "نامشخص";
          const subDomain = settings.subDomain || "نامشخص";
          const subPath = settings.subPath || "نامشخص";
          const pageSize = settings.pageSize || "نامشخص";
          const timeLocation = settings.timeLocation || "نامشخص";
          const tgBotEnable = settings.tgBotEnable ? "✅ فعال" : "❌ غیرفعال";
          const twoFactorEnable = settings.twoFactorEnable ? "✅ فعال" : "❌ غیرفعال";

          msg += `🌐 وب:\n`;
          msg += `   دامنه: ${webDomain}\n`;
          msg += `   پورت: ${webPort}\n`;
          msg += `   Listen: ${webListen}\n\n`;
          msg += `📡 اشتراک:\n`;
          msg += `   وضعیت: ${subEnable}\n`;
          msg += `   پورت: ${subPort}\n`;
          msg += `   دامنه: ${subDomain}\n`;
          msg += `   مسیر: ${subPath}\n\n`;
          msg += `🔧 عمومی:\n`;
          msg += `   PageSize: ${pageSize}\n`;
          msg += `   TimeLocation: ${timeLocation}\n\n`;
          msg += `🤖 بات تلگرام:\n`;
          msg += `   وضعیت: ${tgBotEnable}\n\n`;
          msg += `🔐 امنیت:\n`;
          msg += `   Two-Factor: ${twoFactorEnable}\n`;
        }
        await sendTelegram(chatId, msg, env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Error logs ──
    // ── Stars payment callbacks ──
    if (data === "stars_add") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      await statePut(env, `stars_add_action:${chatId}`, { step: "name" }, MS_PER_HOUR);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, "⭐ افزودن طرح پرداخت\n\n📝 نام طرح را وارد کنید (مثلاً: اشتراک ماهانه):", env, [
        [{ text: "❌ انصراف", callback_data: "stars_menu" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data === "stars_menu") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      await stateDelete(env, `stars_add_action:${chatId}`);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleStarsMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data === "stars_payments") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const payments = await getStarsPayments(env);
      if (!payments.length) {
        await sendTelegram(chatId, "❌ هیچ پرداختی ثبت نشده است.", env, [
          [{ text: "🔙", callback_data: "stars_menu" }],
        ]);
      } else {
        let msg = `📋 پرداخت‌های اخیر (${payments.length}):\n\n`;
        for (const p of payments.slice(0, 20)) {
          msg += `• ${p.stars}⭐ — ${p.planName}\n  👤 ${p.chatId}\n  🕐 ${new Date(p.timestamp).toLocaleString("fa-IR")}\n\n`;
        }
        await sendTelegram(chatId, msg, env, [
          [{ text: "🔙", callback_data: "stars_menu" }],
        ]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data.startsWith("stars_buy:")) {
      // Stars purchase — available to ALL users (admins and regular users)
      const planId = data.slice("stars_buy:".length);
      const plans = await getStarsPlans(env);
      const plan = plans.find(p => p.id === planId);
      if (!plan) {
        await answerCallbackQuery(callbackQueryId, env, "طرح یافت نشد");
        return;
      }
      try {
        await sendStarsInvoice(chatId,
          plan.name,
          plan.description || `پرداخت ${plan.stars} Stars`,
          [{ label: plan.name, amount: plan.stars }],
          { type: "stars_payment", planId: plan.id, planName: plan.name, stars: plan.stars },
          env
        );
        await answerCallbackQuery(callbackQueryId, env, "فاکتور ارسال شد");
      } catch (e) {
        await answerCallbackQuery(callbackQueryId, env, "خطا در ارسال فاکتور");
        await sendTelegram(chatId, `❌ خطا: ${shortError(e)}`, env);
      }
      return;
    }

    // ── Chart and Stars menu buttons ──
    // ── SSH terminal ──
    if (data === "admin_ssh") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const lang = await getUserLang(env, chatId);
      await sendSshServerSelect(chatId, env, lang);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data.startsWith("ssh_panel:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const panelId = data.slice("ssh_panel:".length);
      if (messageId) await deleteMessage(chatId, messageId, env);
      const lang = await getUserLang(env, chatId);
      await statePut(env, `ssh_action:${chatId}`, { step: "command", panelId }, MS_PER_HOUR);
      const panel = await resolvePanelAsync(env, panelId);
      await sendTelegram(chatId,
        `🖥️ SSH Terminal: ${panel ? panel.name : panelId}\n\n` + t(lang, "ssh_enter_command"),
        env,
        [
          [{ text: "📋 دستورات سریع", callback_data: `ssh_quick:${panelId}` }],
          [{ text: t(lang, "main_menu"), callback_data: "admin_back" }],
        ]
      );
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data.startsWith("ssh_quick:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const panelId = data.slice("ssh_quick:".length);
      if (messageId) await deleteMessage(chatId, messageId, env);
      const quickCmds = [
        { label: "📊 System Info", cmd: "uname -a && uptime && free -h && df -h" },
        { label: "🔄 Xray Status", cmd: "systemctl status x-ui" },
        { label: "📋 Xray Logs", cmd: "journalctl -u x-ui --no-pager -n 30" },
        { label: "🌐 Network", cmd: "ip addr show && ss -tlnp" },
        { label: "👥 Who", cmd: "who && last -n 5" },
        { label: "📦 Top Processes", cmd: "ps aux --sort=-%mem | head -10" },
      ];
      // All quick commands use action tokens (callback_data too long for direct encoding)
      // IMPORTANT: pass "ssh" as panelId to setAction, NOT the real panelId.
      // setAction strips panelId prefix from identifier — if we pass the real panelId,
      // it strips it and the act: handler can't find the panelId anymore.
      const buttons = [];
      for (const c of quickCmds) {
        const token = await setAction(chatId, "ssh_quick_cmd", `${panelId}|||${c.cmd}`, env, "ssh");
        buttons.push([{ text: c.label, callback_data: `act:${token}` }]);
      }
      buttons.push([{ text: "🔙", callback_data: `ssh_panel:${panelId}` }]);
      await sendTelegram(chatId, "📋 Quick Commands:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_chart") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleChart(chatId, [], env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }
    if (data === "admin_stars") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const isSuper = await isSuperAdmin(env, chatId);
      if (isSuper) {
        await handleStarsMenu(chatId, env);
      } else {
        await handleStarsBuy(chatId, env);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_error_logs") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      try {
        const errors = await getErrorLogs(env, 20);
        if (!errors.length) {
          await sendTelegram(chatId, "✅ هیچ خطایی ثبت نشده است.", env, [[{text:"🔙",callback_data:"admin_back"}]]);
        } else {
          let msg = `📋 خطاهای اخیر (${errors.length}):\n\n`;
          for (const err of errors.slice(0, 15)) {
            msg += `🕐 ${err.time}\n🔧 ${err.action}\n❌ ${err.error}\n\n`;
          }
          if (msg.length > 4000) msg = msg.slice(0, 4000) + "\n...";
          await sendTelegram(chatId, msg, env, [
            [{ text: "🗑 پاک کردن", callback_data: "admin_clear_errors" }, { text: "🔄 بروزرسانی", callback_data: "admin_error_logs" }],
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
        }
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در دریافت لاگ: ${shortError(error)}`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_clear_errors") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      await clearErrorLogs(env);
      await sendTelegram(chatId, "✅ خطاها پاک شدند.", env, [[{text:"🔙",callback_data:"admin_back"}]]);
      await answerCallbackQuery(callbackQueryId, env, "پاک شد");
      return;
    }

    // ── Ban/Suspend menu (super admin) ──
    if (data === "admin_ban_menu") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const banned = await getBannedUsers(env);
      let msg = `🚫 مدیریت بن/تعلیق\n\n📋 بن شده (${banned.length}):\n`;
      /** @type {any[][]} */
      const btns = [];
      for (const b of banned) {
        msg += `• ${b.chatId} — ${b.reason || "-"}\n`;
        btns.push([{ text: `✅ رفع بن ${b.chatId}`, callback_data: `unban:${b.chatId}` }]);
      }
      btns.push([{ text: "🚫 بن کاربر", callback_data: "ban_input" }]);
      btns.push([{ text: "⏸ تعلیق کاربر", callback_data: "suspend_input" }]);
      btns.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, msg, env, btns);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "ban_input") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      await statePut(env, `ban_action:${chatId}`, { step: "chatId" }, MS_PER_HOUR);
      await sendTelegram(chatId, "🚫 بن کاربر\n\n💬 Chat ID کاربر را وارد کنید:", env, [
        [{ text: "❌ انصراف", callback_data: "admin_ban_menu" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "suspend_input") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      await statePut(env, `suspend_action:${chatId}`, { step: "chatId" }, MS_PER_HOUR);
      await sendTelegram(chatId, "⏸ تعلیق کاربر\n\n💬 Chat ID کاربر را وارد کنید:", env, [
        [{ text: "❌ انصراف", callback_data: "admin_ban_menu" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("unban:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const targetId = data.slice("unban:".length);
      await unbanUser(env, targetId);
      await sendTelegram(chatId, `✅ کاربر "${targetId}" رفع بن شد.`, env, [
        [{ text: "🔙 بن/تعلیق", callback_data: "admin_ban_menu" }],
      ]);
      try { await sendTelegram(targetId, "✅ بن شما رفع شد.", env); } catch {}
      await answerCallbackQuery(callbackQueryId, env, "رفع بن");
      return;
    }

    // ── Manage admins (super admin) ──
    if (data === "admin_manage_admins") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const list = await getAllAdminsWithRoles(env);
      let msg = `👥 مدیریت ادمین‌ها (${list.length}):\n\n`;
      /** @type {any[][]} */
      const btns = [];
      for (const a of list) {
        const icon = a.role === "super" ? "👑" : "🛠️";
        msg += `${icon} ${a.chatId} — ${a.role === "super" ? "سوپر" : "پنل"}`;
        if (a.panelIds && a.panelIds.length) msg += ` — پنل: ${a.panelIds.join(",")}`;
        msg += ` — ${a.createdCount} کاربر${a.maxUsers > 0 ? `/${a.maxUsers}` : ""}\n`;
        if (a.role === "admin") {
          btns.push([{ text: `🗑 حذف ${a.chatId}`, callback_data: `admin_remove:${a.chatId}` }]);
        }
      }
      btns.push([{ text: "➕ افزودن ادمین پنل", callback_data: "addadmin_input" }]);
      btns.push([{ text: "👑 افزودن سوپر ادمین", callback_data: "addsuper_input" }]);
      btns.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, msg, env, btns);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "addadmin_input") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      await statePut(env, `addadmin_action:${chatId}`, { step: "chatId", type: "admin" }, MS_PER_HOUR);
      await sendTelegram(chatId, "➕ افزودن ادمین پنل\n\n💬 Chat ID ادمین جدید را وارد کنید:", env, [
        [{ text: "❌ انصراف", callback_data: "admin_manage_admins" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "addsuper_input") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      await statePut(env, `addadmin_action:${chatId}`, { step: "chatId", type: "super" }, MS_PER_HOUR);
      await sendTelegram(chatId, "👑 افزودن سوپر ادمین\n\n💬 Chat ID را وارد کنید:", env, [
        [{ text: "❌ انصراف", callback_data: "admin_manage_admins" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("admin_remove:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const targetId = data.slice("admin_remove:".length);
      await sendTelegram(chatId, `⚠️ آیا مطمئنید ادمین "${targetId}" حذف شود؟`, env, [
        [
          { text: "✅ بله", callback_data: `admin_remove_yes:${targetId}` },
          { text: "❌ خیر", callback_data: "admin_manage_admins" },
        ],
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("admin_remove_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const targetId = data.slice("admin_remove_yes:".length);
      // Double-check: can't remove super admins
      const targetRole = await getAdminRole(env, targetId);
      if (targetRole && targetRole.role === "super") {
        await sendTelegram(chatId, "❌ نمی‌توان سوپر ادمین را حذف کرد.", env, [
          [{ text: "🔙 مدیریت ادمین‌ها", callback_data: "admin_manage_admins" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
        return;
      }
      await removePanelAdmin(env, targetId);
      await sendTelegram(chatId, `✅ ادمین "${targetId}" حذف شد.`, env, [
        [{ text: "🔙 مدیریت ادمین‌ها", callback_data: "admin_manage_admins" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env, "حذف شد");
      return;
    }

    if (data === "admin_panel_restart") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `🔄 ریستارت ${panel.name}`, callback_data: `panel_restart:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "🔄 ریستارت پنل\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_restart:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("panel_restart:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        await restartPanel(panel);
        await sendTelegram(chatId, `✅ پنل "${panel.name}" ریستارت شد. ممکن است چند دقیقه طول بکشد.`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "✅ ریستارت شد");
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در ریستارت پنل: ${shortError(error)}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    // ── Server logs ──
    if (data === "admin_logs") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `📋 لاگ ${panel.name}`, callback_data: `panel_logs:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "📋 لاگ سرور\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_logs:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("panel_logs:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        const logsResponse = await getServerLogs(panel);
        let msg = `📋 لاگ سرور "${panel.name}":\n\n`;
        const logs = extractLogsFromResponse(logsResponse);
        if (logs.length === 0) {
          msg += "❌ لاگی یافت نشد.";
        } else {
          // Show last 30 logs
          const lastLogs = logs.slice(-30);
          for (const log of lastLogs) {
            msg += `${log}\n`;
          }
        }
        // Truncate to Telegram message limit
        if (msg.length > 4000) msg = msg.slice(0, 4000) + "\n... (بیشتر از حد مجاز)";
        await sendTelegram(chatId, msg, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "لاگ دریافت شد");
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در دریافت لاگ: ${shortError(error)}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    // ── Manage inbounds ──
    if (data === "admin_inbounds") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `📦 ${panel.name}`, callback_data: `panel_inbounds:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "📦 مدیریت Inbound\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_inbounds:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("panel_inbounds:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        const inbounds = await listAllInbounds(panel);
        let msg = `📦 Inboundهای سرور "${panel.name}" (${inbounds.length}):\n\n`;
        const buttons = [];
        for (const inbound of inbounds) {
          const id = inbound.id ?? inbound.port ?? "?";
          const remark = inbound.remark || inbound.tag || "بدون نام";
          const protocol = inbound.protocol || "?";
          const port = inbound.port ?? "?";
          msg += `• ID: ${id} | ${remark} | ${protocol}:${port}\n`;
          buttons.push([{ text: `🗑 حذف ${remark} (${id})`, callback_data: `inbound_del_confirm:${panel.id}:${id}` }]);
        }
        await sendTelegram(chatId, msg, env, [
          ...buttons,
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در دریافت Inboundها: ${shortError(error)}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    if (data.startsWith("inbound_del_confirm:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const panelId = parts[1];
      const inboundId = parts.slice(2).join(":");
      const panel = await resolvePanelAsync(env, panelId);
      const panelName = panel ? panel.name : panelId;
      await sendTelegram(chatId, `⚠️ آیا مطمئنید inbound "${inboundId}" از سرور "${panelName}" حذف شود؟\n\n❌ همه کاربران این inbound حذف خواهند شد!`, env, [
        [
          { text: "✅ بله، حذف شود", callback_data: `inbound_del_yes:${panelId}:${inboundId}` },
          { text: "❌ خیر", callback_data: `panel_inbounds:${panelId}` },
        ],
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("inbound_del_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const panelId = parts[1];
      const inboundId = parts.slice(2).join(":");
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        await deleteInbound(panel, inboundId);
        await sendTelegram(chatId, `✅ Inbound "${inboundId}" حذف شد.`, env, [
          [{ text: "🔙 مدیریت Inbound", callback_data: `panel_inbounds:${panelId}` }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "حذف شد");
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در حذف inbound: ${shortError(error)}`, env, [
          [{ text: "🔙 مدیریت Inbound", callback_data: `panel_inbounds:${panelId}` }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    // ── Manage nodes ──
    if (data === "admin_nodes") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panels = await getPanels(env);
      /** @type {any[][]} */
      const buttons = [];
      for (const panel of panels) {
        buttons.push([{ text: `🌐 ${panel.name}`, callback_data: `panel_nodes:${panel.id}` }]);
      }
      buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
      await sendTelegram(chatId, "🌐 مدیریت Nodes\n👇 سرور را انتخاب کنید:", env, buttons);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_nodes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("panel_nodes:".length);
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        const nodes = await listNodes(panel);
        let msg = `🌐 Nodes سرور "${panel.name}" (${nodes.length}):\n\n`;
        /** @type {any[][]} */
        const buttons = [];
        if (nodes.length === 0) {
          msg += "❌ هیچ node‌ای یافت نشد.";
        } else {
          for (const node of nodes) {
            const status = node.enable ? "🟢" : "⛔";
            const xrayStatus = node.xrayState === "running" ? "✅" : node.xrayState === "stopped" ? "❌" : "❓";
            msg += `${status} ${xrayStatus} ${node.remark || node.name || "بدون نام"}\n`;
            msg += `   📍 ${node.scheme || "https"}://${node.address}:${node.port}${node.basePath || ""}\n`;
            if (node.cpuPct || node.memPct) {
              msg += `   💻 CPU: ${node.cpuPct.toFixed(1)}% | 🧠 RAM: ${node.memPct.toFixed(1)}%\n`;
            }
            if (node.onlineCount) {
              msg += `   🟢 آنلاین: ${node.onlineCount} | 👥 کل: ${node.clientCount}\n`;
            }
            if (node.latencyMs) {
              msg += `   ⚡ Latency: ${node.latencyMs}ms | ⏱️ Uptime: ${Math.floor(node.uptimeSecs / 86400)} روز\n`;
            }
            if (node.xrayVersion) {
              msg += `   📡 Xray: ${node.xrayVersion}\n`;
            }
            if (node.lastError) {
              msg += `   ⚠️ خطا: ${node.lastError}\n`;
            }
            msg += `\n`;
            buttons.push([{ text: `🗑 حذف ${node.remark || node.name || node.id}`, callback_data: `node_del_confirm:${panelId}:${node.id}` }]);
          }
        }
        buttons.push([{ text: "➕ افزودن Node", callback_data: `node_add:${panelId}` }]);
        buttons.push([{ text: "🔄 بروزرسانی", callback_data: `panel_nodes:${panelId}` }]);
        buttons.push([{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]);
        await sendTelegram(chatId, msg, env, buttons);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در دریافت nodes: ${shortError(error)}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("node_add:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("node_add:".length);
      await statePut(env, `node_add_action:${chatId}`, { step: "address", panelId }, MS_PER_HOUR);
      await sendTelegram(chatId, "➕ افزودن Node جدید\n\n📍 آدرس (IP یا دامنه) node را وارد کنید:", env, [
        [{ text: "❌ انصراف", callback_data: `panel_nodes:${panelId}` }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("node_del_confirm:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const panelId = parts[1];
      const nodeId = parts.slice(2).join(":");
      await sendTelegram(chatId, `⚠️ آیا مطمئنید node "${nodeId}" حذف شود؟`, env, [
        [
          { text: "✅ بله، حذف شود", callback_data: `node_del_yes:${panelId}:${nodeId}` },
          { text: "❌ خیر", callback_data: `panel_nodes:${panelId}` },
        ],
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("node_del_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const parts = data.split(":");
      const panelId = parts[1];
      const nodeId = parts.slice(2).join(":");
      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await sendTelegram(chatId, "❌ پنل یافت نشد.", env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env);
        return;
      }
      try {
        await deleteNode(panel, nodeId);
        await sendTelegram(chatId, `✅ Node "${nodeId}" حذف شد.`, env, [
          [{ text: "🔙 مدیریت Nodes", callback_data: `panel_nodes:${panelId}` }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "حذف شد");
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا در حذف node: ${shortError(error)}`, env, [
          [{ text: "🔙 مدیریت Nodes", callback_data: `panel_nodes:${panelId}` }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "خطا");
      }
      return;
    }

    if (data.startsWith("server_status:")) {
      if (messageId) await deleteMessage(chatId, messageId, env);
      const panelId = data.slice("server_status:".length);
      await handleStatus(chatId, [panelId], env);
      await sendTelegram(chatId, "👇", env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    // ── Action tokens (for long callback data) ──
    if (data.startsWith("act:")) {
      const token = data.slice(4);
      const actionObj = await getAction(chatId, token, env);
      if (!actionObj) {
        await answerCallbackQuery(callbackQueryId, env, "عملیات منقضی شده");
        return;
      }

      const { action, panelId } = actionObj;
      // Defensive: strip leading "panelId:" prefix from identifier if present.
      // Older tokens stored before the setAction fix carry the combined
      // "panelId:identifier" string in the identifier field. Strip the prefix
      // so we look up the right client.
      let { identifier } = actionObj;
      if (panelId && typeof identifier === "string" && identifier.startsWith(panelId + ":")) {
        identifier = identifier.slice(panelId.length + 1);
      }

      // Cloudflare-specific actions bypass the panel/client lookup entirely.
      // They store "zoneId:recordId" in identifier instead.
      // These use act: tokens because direct callback_data would exceed
      // Telegram's 64-byte limit (CF IDs are 32-char hex each).
      if (action === "cf_dns" || action === "cf_dns_toggle" || action === "cf_dns_del_confirm" || action === "cf_dns_del_yes") {
        if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
        if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
        const parts = identifier.split(":");
        const zoneId = parts[0];
        const recordId = parts.slice(1).join(":");

        if (action === "cf_dns") {
          // View record detail
          if (messageId) await deleteMessage(chatId, messageId, env);
          await sendCfDnsRecordDetail(chatId, env, zoneId, recordId, "fa");
          await answerCallbackQuery(callbackQueryId, env);
          return;
        }

        if (action === "cf_dns_toggle") {
          // Toggle proxied status
          try {
            const records = await cfListDnsRecords(env, zoneId);
            const record = records.find(r => r.id === recordId);
            if (!record) throw new Error("رکورد یافت نشد");
            await cfUpdateDnsRecord(env, zoneId, recordId, {
              type: record.type,
              name: record.name,
              content: record.content,
              ttl: record.ttl || 1,
              proxied: !record.proxied,
            });
            if (messageId) await deleteMessage(chatId, messageId, env);
            await sendCfDnsRecordDetail(chatId, env, zoneId, recordId, "fa");
            await answerCallbackQuery(callbackQueryId, env,
              record.proxied ? "پروکسی غیرفعال شد" : "پروکسی فعال شد");
          } catch (error) {
            await answerCallbackQuery(callbackQueryId, env, "خطا");
            if (messageId) await deleteMessage(chatId, messageId, env);
            await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env,
              [[{ text: "🔙", callback_data: `cf_zone:${zoneId}` }]]
            );
          }
          return;
        }

        if (action === "cf_dns_del_confirm") {
          // Show delete confirmation
          const delToken = await setAction(chatId, "cf_dns_del_yes", `${zoneId}:${recordId}`, env, "cf_zone");
          if (messageId) await deleteMessage(chatId, messageId, env);
          await sendTelegram(chatId,
            `⚠️ آیا مطمئنید این DNS record حذف شود؟\n\n🆔 ${recordId}\n\n❌ این عمل قابل بازگشت نیست!`,
            env,
            [
              [
                { text: "✅ بله، حذف شود", callback_data: `act:${delToken}` },
                // For "خیر", we need to go back to record detail — also use act: token
                { text: "❌ خیر", callback_data: await cfCallback(chatId, "cf_dns", zoneId, recordId, env) },
              ],
              [{ text: "🔙 رکوردها", callback_data: `cf_zone:${zoneId}` }],
            ]
          );
          await answerCallbackQuery(callbackQueryId, env);
          return;
        }

        if (action === "cf_dns_del_yes") {
          // Actually delete the record
          try {
            await cfDeleteDnsRecord(env, zoneId, recordId);
            if (messageId) await deleteMessage(chatId, messageId, env);
            await sendTelegram(chatId, "✅ DNS record حذف شد.", env,
              [[{ text: "🔙 رکوردها", callback_data: `cf_zone:${zoneId}` }]]
            );
            await answerCallbackQuery(callbackQueryId, env, "حذف شد");
          } catch (error) {
            if (messageId) await deleteMessage(chatId, messageId, env);
            await sendTelegram(chatId, `❌ خطا در حذف: ${shortError(error)}`, env,
              [[{ text: "🔙 رکوردها", callback_data: `cf_zone:${zoneId}` }]]
            );
            await answerCallbackQuery(callbackQueryId, env, "خطا");
          }
          return;
        }
      }

      // SSH quick command execution + interactive input
      if (action === "ssh_quick_cmd" || action === "ssh_interactive") {
        if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
        if (await rejectIfNotSuper(chatId, callbackQueryId, env)) return;
        // identifier format: "panelId|||command" for ssh_quick_cmd
        // identifier format: "panelId|||input|||sessionId" for ssh_interactive
        const parts = identifier.split("|||");
        const sshPanelId = parts[0];
        const sshPanel = await resolvePanelAsync(env, sshPanelId);
        if (!sshPanel) {
          await answerCallbackQuery(callbackQueryId, env, "پنل یافت نشد");
          if (messageId) await deleteMessage(chatId, messageId, env);
          await sendTelegram(chatId, "❌ Panel not found.", env, [
            [{ text: "🔙", callback_data: "admin_ssh" }],
          ]);
          return;
        }
        const lang = await getUserLang(env, chatId);
        try {
          await answerCallbackQuery(callbackQueryId, env, t(lang, "ssh_running"));

          let result;
          if (action === "ssh_quick_cmd") {
            // Quick command — execute directly
            const sshCommand = parts.slice(1).join("|||");
            result = await executeSshCommand(sshPanel, sshCommand, env);
          } else {
            // Interactive input — send to session
            const input = parts[1] || "";
            const sessionId = parts[2] || "";
            if (sessionId) {
              result = await sendSshInput(sshPanel, sessionId, input, env);
            } else {
              // No session — just re-run the command with input
              result = await executeSshCommand(sshPanel, input, env);
            }
          }

          if (messageId) await deleteMessage(chatId, messageId, env);

          // Build output message with context info
          const ctxLabel = result.context && result.context !== 'shell' ? ` (${result.context})` : '';
          const cmdLabel = action === "ssh_interactive" ? `🎮 Input sent` : `💻 Quick Command`;
          const msg = `${cmdLabel}${ctxLabel}\n\n${t(lang, "ssh_output")}\n\`\`\`\n${(result.output || '(no output)').slice(0, 3500)}\n\`\`\``;

          // Build buttons from bridge's suggested buttons
          const buttons = [];
          const suggested = result.buttons || [];

          if (suggested.length) {
            for (let i = 0; i < suggested.length; i += 3) {
              const row = [];
              for (let j = i; j < Math.min(i + 3, suggested.length); j++) {
                const token = await setAction(chatId, "ssh_interactive",
                  `${sshPanelId}|||${suggested[j].input}|||${result.sessionId || ''}`, env, "ssh");
                row.push({ text: suggested[j].label, callback_data: `act:${token}` });
              }
              buttons.push(row);
            }
          } else {
            // Default buttons
            const tEnter = await setAction(chatId, "ssh_interactive", `${sshPanelId}|||  |||${result.sessionId || ''}`, env, "ssh");
            const tY = await setAction(chatId, "ssh_interactive", `${sshPanelId}|||y|||${result.sessionId || ''}`, env, "ssh");
            const tN = await setAction(chatId, "ssh_interactive", `${sshPanelId}|||n|||${result.sessionId || ''}`, env, "ssh");
            buttons.push([
              { text: "⏎ Enter", callback_data: `act:${tEnter}` },
              { text: "Y + ⏎", callback_data: `act:${tY}` },
              { text: "N + ⏎", callback_data: `act:${tN}` },
            ]);
          }

          buttons.push([
            { text: "⌨️ New Command", callback_data: `ssh_panel:${sshPanelId}` },
            { text: "📋 Quick Commands", callback_data: `ssh_quick:${sshPanelId}` },
          ]);
          buttons.push([{ text: t(lang, "main_menu"), callback_data: "admin_back" }]);

          await sendTelegram(chatId, msg, env, buttons);
        } catch (e) {
          if (messageId) await deleteMessage(chatId, messageId, env);
          await sendTelegram(chatId, `❌ SSH error: ${shortError(e)}`, env, [
            [
              { text: "🔄 Retry", callback_data: `ssh_panel:${sshPanelId}` },
              { text: t(lang, "main_menu"), callback_data: "admin_back" },
            ],
          ]);
        }
        return;
      }

      const panel = await resolvePanelAsync(env, panelId);
      if (!panel) {
        await answerCallbackQuery(callbackQueryId, env, "پنل یافت نشد");
        return;
      }

      const client = await getClientByIdentifier(identifier, env, panelId);
      if (!client) {
        await answerCallbackQuery(callbackQueryId, env, "کاربر یافت نشد");
        return;
      }

      // Access control: panel admins can only act on users THEY created.
      // Super admins can act on any user.
      if (!(await adminCanAccessClientCallback(chatId, client, callbackQueryId, env))) return;

      // Delete the message that contained the button (except for delete_confirm which shows confirmation)
      if (messageId && action !== "delete_confirm") await deleteMessage(chatId, messageId, env);

      // Pass messageId to handleAdminAction for delete confirmation
      await handleAdminAction(chatId, action, panel, client, env, callbackQueryId);
      return;
    }

    // ── Direct callback data (short identifiers) ──
    const { action, param } = splitCallbackData(data);
    if (param && param.includes(":")) {
      const parts = param.split(":");
      const panelIdPart = parts[0];
      const identifierPart = parts.slice(1).join(":");
      const panel = await resolvePanelAsync(env, panelIdPart);
      if (panel) {
        const client = await getClientByIdentifier(identifierPart, env, panelIdPart);
        if (client) {
          // Access control: panel admins can only act on users THEY created.
          if (!(await adminCanAccessClientCallback(chatId, client, callbackQueryId, env))) return;
          await handleAdminAction(chatId, action, panel, client, env, callbackQueryId);
          return;
        }
      }
    }

    await answerCallbackQuery(callbackQueryId, env, "");
  } catch (error) {
    console.error("handleCallbackQuery error:", shortError(error));
    try { await answerCallbackQuery(callbackQueryId, env, "خطای سیستم"); } catch { /* ignore */ }
  }
}

// ─── Admin Action Handler ─────────────────────────────────────

async function handleAdminAction(chatId, action, panel, client, env, callbackQueryId) {
  const identifier = getIdentifierFromClient(client);
  const admin = await isAdminAsync(chatId, env);

  if (!admin) {
    await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید");
    return;
  }

  try {
    switch (action) {
      case "full_stats": {
        const msg = formatClient(client, panel);
        const buttons = await buildAdminClientButtons(chatId, client, panel, env);
        await sendTelegram(chatId, `📊 آمار کامل\n\n${msg}`, env, buttons);
        await answerCallbackQuery(callbackQueryId, env, "آمار کامل");
        break;
      }

      case "addgb": {
        // Ask for GB amount
        await statePut(env, `addgb_action:${chatId}`, { panelId: panel.id, identifier }, MS_PER_HOUR);
        await sendTelegram(chatId, `📦 چند گیگابایت اضافه شود؟ (مثلاً 50)`, env, [
          [{ text: "❌ انصراف", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "");
        break;
      }

      case "renew": {
        await statePut(env, `renew_action:${chatId}`, { panelId: panel.id, identifier }, MS_PER_HOUR);
        await sendTelegram(chatId, `⏱️ چند روز تمدید شود؟ (مثلاً 30)`, env, [
          [{ text: "❌ انصراف", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "");
        break;
      }

      case "link": {
        const subId = client.subId || client.subid || client.sub_id || "";
        if (!subId) {
          await answerCallbackQuery(callbackQueryId, env, "لینک اشتراک موجود نیست");
          return;
        }
        try {
          const link = await buildSubLinkAsync(subId, panel, env);
          const qrUrl = `${QR_CODE_API}?size=${QR_CODE_SIZE}x${QR_CODE_SIZE}&data=${encodeURIComponent(link)}`;
          await sendPhoto(chatId, qrUrl, `🔗 لینک اشتراک:\n${link}`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          await answerCallbackQuery(callbackQueryId, env, "لینک اشتراک");
        } catch (e) {
          await sendTelegram(chatId, `❌ خطا در ساخت لینک اشتراک: ${shortError(e)}`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          await answerCallbackQuery(callbackQueryId, env, "خطا");
        }
        break;
      }

      case "ips": {
        try {
          const ipsResponse = await getClientIps(panel, identifier, env);
          let msg = `🌐 IPهای کاربر "${identifier}":\n\n`;
          const ips = extractIpsFromResponse(ipsResponse);
          if (ips.length === 0) {
            msg += "❌ هیچ IP فعالی یافت نشد.";
          } else {
            for (const ip of ips) {
              msg += `• ${ip}\n`;
            }
          }
          await sendTelegram(chatId, msg, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          await answerCallbackQuery(callbackQueryId, env, "IPها دریافت شد");
        } catch (error) {
          await sendTelegram(chatId, `❌ خطا در دریافت IPها: ${shortError(error)}`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          await answerCallbackQuery(callbackQueryId, env, "خطا");
        }
        break;
      }

      case "reset_traffic": {
        // Show confirmation first
        const confirmToken = await setAction(chatId, "reset_traffic_confirm", `${panel.id}:${identifier}`, env, panel.id);
        await sendTelegram(chatId, `⚠️ آیا مطمئنید ترافیک کاربر "${identifier}" ریست شود؟\n\n📊 مصرف فعلی صفر خواهد شد.`, env, [
          [
            { text: "✅ بله، ریست شود", callback_data: `act:${confirmToken}` },
            { text: "❌ خیر", callback_data: "admin_back" },
          ],
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "");
        break;
      }

      case "reset_traffic_confirm": {
        try {
          await resetClientTraffic(panel, identifier, env);
          await sendTelegram(chatId, `♻️ ترافیک کاربر "${identifier}" ریست شد.`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          await answerCallbackQuery(callbackQueryId, env, "ریست شد");
        } catch (error) {
          await sendTelegram(chatId, `❌ خطا در ریست ترافیک: ${shortError(error)}`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          await answerCallbackQuery(callbackQueryId, env, "خطا");
        }
        break;
      }

      case "enable": {
        await updateClient(panel, client, { enable: true });
        const updated = await getClientByIdentifier(identifier, env, panel.id);
        const msg = `✅ کاربر "${identifier}" فعال شد.\n\n${updated ? formatClient(updated, panel) : ""}`;
        const buttons = updated ? await buildAdminClientButtons(chatId, updated, panel, env) : [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]];
        await sendTelegram(chatId, msg, env, buttons);
        await answerCallbackQuery(callbackQueryId, env, "✅ فعال شد");
        break;
      }

      case "disable": {
        await updateClient(panel, client, { enable: false });
        const updated = await getClientByIdentifier(identifier, env, panel.id);
        const msg = `⛔ کاربر "${identifier}" غیرفعال شد.\n\n${updated ? formatClient(updated, panel) : ""}`;
        const buttons = updated ? await buildAdminClientButtons(chatId, updated, panel, env) : [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]];
        await sendTelegram(chatId, msg, env, buttons);
        await answerCallbackQuery(callbackQueryId, env, "⛔ غیرفعال شد");
        break;
      }

      case "delete": {
        // Show confirmation first
        const confirmToken = await setAction(chatId, "delete_confirm", `${panel.id}:${identifier}`, env, panel.id);
        await sendTelegram(chatId, `⚠️ آیا مطمئنید کاربر "${identifier}" از سرور "${panel.name}" حذف شود؟\n\n❌ این عمل قابل بازگشت نیست!`, env, [
          [
            { text: "✅ بله، حذف شود", callback_data: `act:${confirmToken}` },
            { text: "❌ خیر", callback_data: "admin_back" },
          ],
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "");
        break;
      }

      case "delete_confirm": {
        try {
          await deleteClient(panel, identifier, env);
          await sendTelegram(chatId, `🗑 کاربر "${identifier}" حذف شد.`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          const user = await findUserByEmail(env, identifier, panel.id);
          if (user) await deleteUser(env, user.chatId);
          await answerCallbackQuery(callbackQueryId, env, "حذف شد");
        } catch (error) {
          await sendTelegram(chatId, `❌ خطا در حذف: ${shortError(error)}`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
          ]);
          await answerCallbackQuery(callbackQueryId, env, "خطا");
        }
        break;
      }

      default:
        await answerCallbackQuery(callbackQueryId, env, "عملیات ناشناخته");
    }
  } catch (error) {
    console.error("handleAdminAction error:", shortError(error));
    try { await answerCallbackQuery(callbackQueryId, env, `خطا: ${shortError(error)}`); } catch { /* ignore */ }
  }
}

// Extract IPs from various response formats
function extractIpsFromResponse(response) {
  const ips = [];
  if (!response) return ips;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (typeof item === "string" && item.match(/^\d+\.\d+\.\d+\.\d+/)) {
      ips.push(item);
    } else if (item && typeof item === "object") {
      if (Array.isArray(item.ips)) {
        for (const ip of item.ips) {
          if (typeof ip === "string") ips.push(ip);
        }
      }
      if (item.ip && typeof item.ip === "string") ips.push(item.ip);
      if (item.address && typeof item.address === "string") ips.push(item.address);
    }
  }
  // Deduplicate and filter valid IPs
  return [...new Set(ips)].filter((ip) => ip && ip.length > 0);
}

// Extract logs from various response formats
function extractLogsFromResponse(response) {
  const logs = [];
  if (!response) return logs;
  const flat = flattenCandidates(response);
  for (const item of flat) {
    if (typeof item === "string" && item.length > 0) {
      logs.push(item);
    } else if (item && typeof item === "object") {
      if (Array.isArray(item.logs)) {
        for (const log of item.logs) {
          if (typeof log === "string") logs.push(log);
          else if (log && typeof log === "object" && log.msg) logs.push(String(log.msg));
        }
      }
      if (item.log && typeof item.log === "string") logs.push(item.log);
      if (item.msg && typeof item.msg === "string") logs.push(item.msg);
    }
  }
  return logs;
}

