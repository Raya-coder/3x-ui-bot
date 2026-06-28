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

// 3x-ui API paths
const API_PATHS = {
  LOGIN: "/login",
  // Inbounds
  INBOUNDS_LIST: "/panel/api/inbounds/list",
  INBOUNDS_GET: "/panel/api/inbounds/get/",
  INBOUNDS_UPDATE: "/panel/api/inbounds/update/",
  INBOUNDS_ADD: "/panel/api/inbounds/add",
  INBOUNDS_DEL: "/panel/api/inbounds/del/",
  INBOUNDS_ONLINE: "/panel/api/inbounds/onlines",
  INBOUNDS_RESET_TRAFFIC: "/panel/api/inbounds/resetAllTraffics",
  // Clients
  CLIENTS_LIST: "/panel/api/clients/list",
  CLIENTS_GET: "/panel/api/clients/get/",
  CLIENTS_ADD: "/panel/api/clients/add",
  CLIENTS_UPDATE: "/panel/api/clients/update/",
  CLIENTS_DEL: "/panel/api/clients/del/",
  CLIENTS_RESET_TRAFFIC: "/panel/api/clients/reset_traffic/",
  CLIENTS_IPS: "/panel/api/clients/ips/",
  CLIENTS_RENEW: "/panel/api/clients/renew/",
  CLIENT_TRAFFIC: "/panel/api/client/traffic/",
  CLIENTS_TRAFFICS: "/panel/api/clients/traffics",
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
  // Fallbacks
  FALLBACKS_LIST: "/panel/api/fallbacks/list",
  FALLBACKS_ADD: "/panel/api/fallbacks/add",
  FALLBACKS_DEL: "/panel/api/fallbacks/del/",
  // API Tokens
  API_TOKENS_LIST: "/panel/api/api-tokens/list",
  API_TOKENS_ADD: "/panel/api/api-tokens/add",
  API_TOKENS_UPDATE: "/panel/api/api-tokens/update/",
  API_TOKENS_DEL: "/panel/api/api-tokens/del/",
  // Outbounds
  OUTBOUNDS_LIST: "/panel/api/outbounds/list",
  OUTBOUNDS_TRAFFICS: "/panel/api/outbounds/traffics",
  // Server
  SERVER_STATUS: "/panel/api/server/status",
  SERVER_GET_DB: "/panel/api/server/getDb",
  SERVER_STOP_XRAY: "/panel/api/server/stopXrayService",
  SERVER_RESTART_XRAY: "/panel/api/server/restartXrayService",
  SERVER_RESTART_PANEL: "/panel/api/server/restartPanel",
  SERVER_GET_LOGS: "/panel/api/server/getLogs",
  SERVER_PANEL_UPDATE: "/panel/api/server/getPanelUpdateInfo",
  SERVER_GET_XRAY_VERSION: "/panel/api/server/getXrayVersion",
  SERVER_UPDATE_XRAY: "/panel/api/server/updateXray/",
  SERVER_INSTALL_XRAY: "/panel/api/server/installXray/",
  // Settings
  SETTINGS_ALL: "/panel/api/setting/all",
  SETTINGS_UPDATE: "/panel/api/setting/update",
  // Users (panel users)
  USERS_LIST: "/panel/api/users/list",
  USERS_ADD: "/panel/api/users/add",
  USERS_DEL: "/panel/api/users/del/",
  // Database
  DATABASE_BACKUP: "/panel/api/server/getDb",
  DATABASE_RESTORE: "/panel/api/server/importDb",
};

const PANEL_VERSION_PATHS = [
  { path: "/panel/api/server/getPanelUpdateInfo", method: "GET" },
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
        subLink: (client.subId || client.subid) && panel.subBaseUrl
          ? buildSubLink(client.subId || client.subid, panel)
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
  state.actions[token] = {
    action,
    panelId: panelId || "",
    identifier: param,
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
  await kvDelete(env, `${KV_USERS_PREFIX}${chatId}`);
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
  const role = await getAdminRole(env, chatId);
  return role && role.role === "super";
}

async function getAdminPanelIds(env, chatId) {
  const role = await getAdminRole(env, chatId);
  if (!role) return [];
  if (role.role === "super") { const p = await getPanels(env); return p.map(x=>x.id); }
  return role.panelIds || [];
}

async function getAdminCreatedCount(env, chatId) {
  const keys = await kvList(env, KV_USERS_PREFIX);
  let count = 0;
  for (const key of keys) { const u = await kvGet(env, key); if (u && u.createdBy === String(chatId)) count++; }
  return count;
}

async function addPanelAdmin(env, chatId, panelIds, maxUsers) {
  const id = String(chatId);
  await kvPut(env, `${KV_ADMIN_ROLE_PREFIX}${id}`, { role: "admin", panelIds: panelIds||[], maxUsers: maxUsers||0, createdAt: Date.now() });
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
    result.push({ chatId: id, role: role?.role||"super", panelIds: role?.panelIds||[], maxUsers: role?.maxUsers||0, createdCount: cnt });
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

  // Always try to fetch fresh traffic data from inbound list
  // This is the most reliable source in all 3x-ui versions
  try {
    const inboundsResponse = await panelApi(panel, API_PATHS.INBOUNDS_LIST, "GET");
    const trafficAndTotal = findTrafficInInbounds(inboundsResponse, identifier);
    if (trafficAndTotal.up > 0 || trafficAndTotal.down > 0) {
      client.up = trafficAndTotal.up;
      client.down = trafficAndTotal.down;
    }
    // Also merge total traffic limit from clientStats if client doesn't have a positive total
    // Note: totalGB = 0 means unlimited, so only set if client has no total at all
    const hasExplicitTotal = client.totalGB !== undefined || client.total !== undefined;
    if (trafficAndTotal.total > 0 && !hasExplicitTotal) {
      client.total = trafficAndTotal.total;
    }
    // Also merge expiryTime from clientStats if client doesn't have it
    // Note: expiryTime = 0 means unlimited, so only set if undefined
    if (trafficAndTotal.expiryTime > 0 && client.expiryTime === undefined) {
      client.expiryTime = trafficAndTotal.expiryTime;
    }
    // Also merge enable status from clientStats
    if (trafficAndTotal.enable !== undefined && client.enable === undefined) {
      client.enable = trafficAndTotal.enable;
    }
  } catch (error) {
    console.error(`enrichClientTraffic inbound list error for ${panel.name}:`, shortError(error));
  }

  // Fallback: Try dedicated traffic API endpoint
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
  try {
    return await panelApi(panel, API_PATHS.SERVER_GET_LOGS, "GET");
  } catch { return null; }
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
  const response = await panelApi(panel, API_PATHS.API_TOKENS_LIST, "GET");
  return extractApiTokensFromResponse(response);
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
  const response = await panelApi(panel, API_PATHS.SETTINGS_ALL, "GET");
  return response?.obj || response || null;
}

async function updateSetting(panel, key, value) {
  return await panelApi(panel, API_PATHS.SETTINGS_UPDATE, "POST", { [key]: value });
}

// ─── Panel Users Management ───────────────────────────────────

async function listPanelUsers(panel) {
  const response = await panelApi(panel, API_PATHS.USERS_LIST, "GET");
  return extractPanelUsersFromResponse(response);
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
  try {
    return await panelApi(panel, `/panel/api/server/updateXray/${encodeURIComponent(version)}`, "POST");
  } catch {
    try {
      return await panelApi(panel, "/panel/api/server/installXray/", "POST", { version });
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
  if (totalBytes > 0) lines.push(`📈 درصد مصرف: ${formatPercent(usedBytes, totalBytes)}`);

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

  /** @type {any[][]} */
  const buttons = [
    [
      { text: "📊 آمار کامل", callback_data: await cb("full_stats") },
    ],
    [
      { text: "➕ افزایش حجم", callback_data: await cb("addgb") },
      { text: "⏱ تمدید زمان", callback_data: await cb("renew") },
    ],
    [
      { text: "🔗 لینک اشتراک", callback_data: await cb("link") },
      { text: "🌐 IPهای کاربر", callback_data: await cb("ips") },
    ],
    [
      { text: "♻️ ریست ترافیک", callback_data: await cb("reset_traffic") },
    ],
    [
      enabled
        ? { text: "⛔ غیرفعال کردن", callback_data: await cb("disable") }
        : { text: "✅ فعال کردن", callback_data: await cb("enable") },
    ],
    [
      { text: "🗑 حذف کاربر", callback_data: await cb("delete") },
    ],
  ];

  return buttons;
}

function buildUserViewButtons(email, panelId, env) {
  const supportUser = getSupportUsername(env);
  /** @type {any[][]} */
  const buttons = [
    [
      { text: "🔄 بروزرسانی", callback_data: `refresh:${panelId}` },
      { text: "🔗 لینک اشتراک", callback_data: `user_sublink:${panelId}` },
    ],
    [
      { text: "📅 درخواست تمدید", callback_data: `user_renew:${panelId}` },
      { text: "📦 درخواست حجم", callback_data: `user_addgb:${panelId}` },
    ],
    [
      { text: "📋 اطلاعات پشتیبان", callback_data: "user_backup_info" },
      { text: "❓ راهنما", callback_data: "user_help" },
    ],
  ];
  if (supportUser) {
    buttons.push([{ text: "🎧 پشتیبانی", url: `https://t.me/${supportUser}` }]);
  }
  return buttons;
}

async function sendUserMenu(chatId, env) {
  const user = await getUser(env, chatId);
  if (!user) {
    await sendTelegram(chatId, "❌ شما ثبت‌نام نکرده‌اید. /start را بزنید.", env);
    return;
  }
  const client = await getClientByIdentifier(user.clientEmail, env, user.panelId);
  const panel = await resolvePanelAsync(env, user.panelId);
  if (!client || !panel) {
    // Panel might be deleted - show backup info instead
    const backup = await getUserBackup(env, chatId);
    if (backup) {
      const msg = `⚠️ سرور در دسترس نیست.\n\n${formatUserBackup(backup)}\n\n💡 این اطلاعات از بکاپ داخلی ربات است.`;
      await sendTelegram(chatId, msg, env, buildUserViewButtons(user.clientEmail, user.panelId, env));
    } else {
      await sendTelegram(chatId, "❌ کاربر یافت نشد و بکاپی موجود نیست. لطفاً مجدداً ثبت‌نام کنید.", env);
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
  const buttons = buildUserViewButtons(user.clientEmail, user.panelId, env);
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

// ─── Telegram Update Handler ──────────────────────────────────

async function handleTelegramUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
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
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
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
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
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
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
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
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
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
          await sendTelegram(chatId, "❌ مقدار نامعتبر. تعداد روز را وارد کنید:", env);
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
          await createClient(panel, createAction.email, createAction.days, gb, { adminChatId: chatId });
          const client = await getClientByIdentifier(createAction.email, env, createAction.panelId);
          const msg = `✅ کاربر "${createAction.email}" ساخته شد.\n📅 ${createAction.days} روز | 📦 ${gb > 0 ? gb + " GB" : "نامحدود"}\n🖥️ سرور: ${panel.name}`;
          const buttons = client ? await buildAdminClientButtons(chatId, client, panel, env) : [[{ text: "🔙 منوی اصلی", callback_data: "admin_back" }]];
          await sendTelegram(chatId, msg, env, buttons);

          // Send QR if subscription link available
          try {
            const subId = client?.subId || client?.subid || "";
            if (subId && panel.subBaseUrl) {
              const subLink = buildSubLink(subId, panel);
              await sendTelegram(chatId, `🔗 لینک اشتراک:\n${subLink}`, env, [
                [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
              ]);
            }
          } catch { /* ignore */ }
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
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
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

    // Check admin node add action state
    const nodeAddState = await stateGet(env, `node_add_action:${chatId}`);
    if (nodeAddState) {
      if (!admin) {
        await stateDelete(env, `node_add_action:${chatId}`);
        await sendTelegram(chatId, "❌ دسترسی ندارید.", env);
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
          await sendTelegram(chatId, "❌ پورت نامعتبر. عدد بین 1-65535 وارد کنید:", env);
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
      await handleStatus(chatId, args, env);
      return;
    }

    if (command === "online" && admin) {
      await handleOnline(chatId, args, env);
      return;
    }

    if (command === "report" && admin) {
      await sendDailyReportAllPanels(env);
      await sendTelegram(chatId, "📊 گزارش روزانه ارسال شد.", env);
      return;
    }

    if (command === "versions" && admin) {
      await handleVersions(chatId, args, env);
      return;
    }

    if (command === "xray_restart" && admin) {
      await handleXrayRestart(chatId, args, env);
      return;
    }

    if (command === "xray_stop" && admin) {
      await handleXrayStop(chatId, args, env);
      return;
    }

    if (command === "xray_version" && admin) {
      await handleXrayVersionCmd(chatId, args, env);
      return;
    }

    if (command === "xray_update" && admin) {
      await handleXrayUpdate(chatId, args, env);
      return;
    }

    if (command === "panel_version" && admin) {
      await handlePanelVersionCmd(chatId, args, env);
      return;
    }

    if (command === "panel_update" && admin) {
      await handlePanelUpdateCmd(chatId, args, env);
      return;
    }

    if (command === "export" && admin) {
      await handleExportConfig(chatId, env);
      return;
    }

    if (command === "addpanel" && admin) {
      await startAddPanel(chatId, env);
      return;
    }

    if (command === "dellpanel" && admin) {
      await handleDeletePanel(chatId, args, env);
      return;
    }

    if (command === "panels" && admin) {
      await handleListPanels(chatId, env);
      return;
    }

    if (command === "backup" && admin) {
      await handleBackup(chatId, args, env);
      return;
    }

    // ── Ban/Suspend (super admin) ──
    if (command === "ban" && admin) {
      const t = args[0]; if (!t) { await sendTelegram(chatId, "استفاده: /ban <chatId> [دلیل]", env); return; }
      if (await isAdminAsync(t, env)) { await sendTelegram(chatId, "❌ ادمین را نمی‌توان بن کرد", env); return; }
      const r = args.slice(1).join(" ") || "";
      await banUser(env, t, r);
      await sendTelegram(chatId, `🚫 "${t}" بن شد.${r?`\n📝 ${r}`:""}`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `🚫 بن شدید.${r?`\n📝 ${r}`:""}`, env); } catch {}
      return;
    }
    if (command === "unban" && admin) {
      const t = args[0]; if (!t) { await sendTelegram(chatId, "استفاده: /unban <chatId>", env); return; }
      await unbanUser(env, t);
      await sendTelegram(chatId, `✅ "${t}" رفع بن شد.`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `✅ بن رفع شد.`, env); } catch {}
      return;
    }
    if (command === "suspend" && admin) {
      const t = args[0]; const m = Number(args[1]);
      if (!t || !m || m<=0) { await sendTelegram(chatId, "استفاده: /suspend <chatId> <دقیقه> [دلیل]", env); return; }
      if (await isAdminAsync(t, env)) { await sendTelegram(chatId, "❌ ادمین را نمی‌توان تعلیق کرد", env); return; }
      const r = args.slice(2).join(" ") || "";
      await suspendUser(env, t, m, r);
      await sendTelegram(chatId, `⏸ "${t}" تعلیق شد (${m} دقیقه).${r?`\n📝 ${r}`:""}`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `⏸ تعلیق ${m} دقیقه.${r?`\n📝 ${r}`:""}`, env); } catch {}
      return;
    }
    if (command === "unsuspend" && admin) {
      const t = args[0]; if (!t) { await sendTelegram(chatId, "استفاده: /unsuspend <chatId>", env); return; }
      await unsuspendUser(env, t);
      await sendTelegram(chatId, `✅ تعلیق "${t}" لغو شد.`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      return;
    }
    if (command === "bannedlist" && admin) {
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
      if (!t || !pids) { await sendTelegram(chatId, "استفاده: /addadmin <chatId> <panelId1,panelId2> [maxUsers]", env); return; }
      const pl = pids.split(",").map(s=>s.trim()).filter(Boolean);
      await addPanelAdmin(env, t, pl, mx);
      await sendTelegram(chatId, `✅ ادمین "${t}" اضافه شد.\n🖥️ پنل: ${pl.join(", ")}\n📊 محدودیت: ${mx>0?mx:"نامحدود"}`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      try { await sendTelegram(t, `✅ ادمین شدید! پنل: ${pl.join(", ")}. /admin بزنید.`, env); } catch {}
      return;
    }
    if (command === "removeadmin" && admin) {
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await sendTelegram(chatId, "❌ فقط سوپر ادمین", env); return; }
      const t = args[0]; if (!t) { await sendTelegram(chatId, "استفاده: /removeadmin <chatId>", env); return; }
      // Can't remove super admins
      const targetRole = await getAdminRole(env, t);
      if (targetRole && targetRole.role === "super") { await sendTelegram(chatId, "❌ نمی‌توان سوپر ادمین را حذف کرد.", env); return; }
      await removePanelAdmin(env, t);
      await sendTelegram(chatId, `✅ ادمین "${t}" حذف شد.`, env, [[{text:"🔙",callback_data:"admin_back"}]]);
      return;
    }
    if (command === "admins" && admin) {
      const list = await getAllAdminsWithRoles(env);
      let m = `👥 ادمین‌ها (${list.length}):\n\n`;
      for (const a of list) { m += `${a.role==="super"?"👑":"🛠️"} ${a.chatId} — ${a.role==="super"?"سوپر":"پنل"} — ${a.createdCount} کاربر${a.maxUsers>0?`/${a.maxUsers}`:""}\n`; }
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
    await sendTelegram(chatId, "دستور ناشناخته. /help را بزنید.", env);
  } catch (error) {
    console.error("handleTelegramUpdate error:", shortError(error));
  }
}

// ─── Start & Registration ─────────────────────────────────────

async function handleStart(chatId, fromId, env) {
  // FIRST: Check if admin — admins skip registration
  const admin = await isAdminAsync(chatId, env);
  if (admin) {
    await sendAdminMenu(chatId, env);
    return;
  }

  // SECOND: Check if already registered as normal user
  const existingUser = await getUser(env, chatId);
  if (existingUser) {
    const panel = await resolvePanelAsync(env, existingUser.panelId);
    const client = await getClientByIdentifier(existingUser.clientEmail, env, existingUser.panelId);

    if (client && panel) {
      await sendUserMenu(chatId, env);
    } else {
      await sendTelegram(chatId, "⚠️ حساب کاربری شما یافت نشد. لطفاً مجدداً ثبت‌نام کنید.", env);
      await deleteUser(env, chatId);
      await startRegistration(chatId, env);
    }
    return;
  }

  // THIRD: New user — start registration
  await startRegistration(chatId, env);
}

async function startRegistration(chatId, env) {
  const panels = await getPanels(env).catch(() => []);
  if (!panels.length) {
    await sendTelegram(chatId, "❌ هیچ پنلی تنظیم نشده است.", env);
    return;
  }
  if (panels.length === 1) {
    await statePut(env, `${STATE_REG_PREFIX}${chatId}`, { step: "email", panelId: panels[0].id }, MS_PER_HOUR);
    await sendTelegram(chatId, "👋 به ربات مدیریت VPN خوش آمدید!\n\n📧 لطفاً ایمیل/شناسه کاربری خود را وارد کنید:", env, [
      [{ text: "🔙 شروع مجدد", callback_data: "reg_cancel" }],
    ]);
  } else {
    await statePut(env, `${STATE_REG_PREFIX}${chatId}`, { step: "panel" }, MS_PER_HOUR);
    const buttons = panels.map((p) => [{ text: p.name, callback_data: `reg_panel:${p.id}` }]);
    await sendTelegram(chatId, "👋 به ربات مدیریت VPN خوش آمدید!\n\n🖥️ لطفاً سرور خود را انتخاب کنید:", env, buttons);
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
    await sendTelegram(chatId, msg, env, buildUserViewButtons(email, regState.panelId, env));
  }
}

// ─── Admin Menu (Interactive) ─────────────────────────────────

async function sendAdminMenu(chatId, env) {
  /** @type {any[][]} */
  const buttons = [
    [
      { text: "📊 وضعیت سرورها", callback_data: "admin_status" },
    ],
    [
      { text: "🔍 جستجوی کاربر", callback_data: "admin_search" },
      { text: "👥 لیست کاربران", callback_data: "admin_clients" },
    ],
    [
      { text: "➕ ساخت کاربر جدید", callback_data: "admin_create" },
    ],
    [
      { text: "🖥️ مدیریت پنل‌ها", callback_data: "admin_panels" },
      { text: "📦 مدیریت Inbound", callback_data: "admin_inbounds" },
    ],
    [
      { text: "🌐 مدیریت Nodes", callback_data: "admin_nodes" },
    ],
    [
      { text: "🔄 درخواست‌های تمدید", callback_data: "admin_renewals" },
    ],
    [
      { text: "⚡ مدیریت Xray", callback_data: "admin_xray" },
      { text: "🔄 ریستارت پنل", callback_data: "admin_panel_restart" },
    ],
    [
      { text: "📦 بکاپ", callback_data: "admin_backup" },
      { text: "📤 خروجی کانفیگ", callback_data: "admin_export" },
    ],
    [
      { text: "📊 گزارش روزانه", callback_data: "admin_report" },
      { text: "📋 لاگ سرور", callback_data: "admin_logs" },
    ],
    [
      { text: "🟢 کاربران آنلاین", callback_data: "admin_online" },
      { text: "📋 نسخه‌ها", callback_data: "admin_versions" },
    ],
    [
      { text: "💾 بکاپ کاربران", callback_data: "admin_user_backups" },
      { text: "🔑 توکن‌های API", callback_data: "admin_api_tokens" },
    ],
    [
      { text: "📡 Outbounds", callback_data: "admin_outbounds" },
      { text: "⚙️ تنظیمات پنل", callback_data: "admin_settings" },
    ],
    [
      { text: "📤 ترافیک Outbound", callback_data: "admin_outbound_traffic" },
      { text: "📥 ریست ترافیک Inbound", callback_data: "admin_reset_inbound_traffic" },
    ],
    [
      { text: "🚫 بن/تعلیق", callback_data: "admin_ban_menu" },
      { text: "👥 ادمین‌ها", callback_data: "admin_manage_admins" },
    ],
    [
      { text: "📋 لاگ خطاها", callback_data: "admin_error_logs" },
    ],
  ];
  // Add support button if SUPPORT_USERNAME is configured
  const supportUser = getSupportUsername(env);
  if (supportUser) {
    buttons.push([{ text: "🎧 پشتیبانی", url: `https://t.me/${supportUser}` }]);
  }
  const roleInfo = await getAdminRole(env, chatId);
  const isSuper = !roleInfo || roleInfo.role === "super";
  let menuText = isSuper ? "👑 پنل مدیریت سوپر ادمین" : "🛠️ پنل مدیریت";
  if (!isSuper) {
    const cnt = await getAdminCreatedCount(env, chatId);
    const mx = roleInfo.maxUsers || 0;
    menuText += `\n📊 کاربران: ${cnt}${mx>0?"/"+mx:""}`;
  }
  menuText += "\n👇 انتخاب کنید:";
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

async function handleSearch(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegram(chatId, "استفاده: /search <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see their panels + users they created
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const allowed = searchRole.panelIds || [];
    results = results.filter(r => allowed.includes(r.panel.id));
  }
  if (!results.length) {
    await sendTelegram(chatId, `❌ کاربری با شناسه "${identifier}" یافت نشد.`, env);
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
    await sendTelegram(chatId, "استفاده: /user <شناسه>", env);
    return;
  }
  const panelId = args[1] || null;
  const panel = panelId ? await resolvePanelAsync(env, panelId) : null;

  if (panelId && !panel) {
    await sendTelegram(chatId, `❌ پنل "${panelId}" یافت نشد.`, env);
    return;
  }

  const client = await getClientByIdentifier(identifier, env, panelId);
  if (!client) {
    await sendTelegram(chatId, `❌ کاربری با شناسه "${identifier}" یافت نشد.`, env);
    return;
  }

  const resolvedPanel = panel || (await searchClientAcrossPanels(identifier, env))[0]?.panel;
  if (!resolvedPanel) {
    await sendTelegram(chatId, "❌ پنل کاربر یافت نشد.", env);
    return;
  }

  const msg = formatClient(client, resolvedPanel);
  const buttons = await buildAdminClientButtons(chatId, client, resolvedPanel, env);
  await sendTelegram(chatId, msg, env, buttons);
}

async function handleCreate(chatId, args, env) {
  if (args.length < 3) {
    await sendTelegram(chatId, "استفاده: /create <شناسه> <روز> <حجم GB> [آیدی پنل]", env);
    return;
  }
  const identifier = args[0];
  const days = Number(args[1]);
  const gb = Number(args[2]);
  const panelId = args[3] || null;

  if (!identifier || isNaN(days) || isNaN(gb) || days <= 0 || gb <= 0) {
    await sendTelegram(chatId, "❌ مقادیر نامعتبر.", env);
    return;
  }

  const panel = panelId ? await resolvePanelAsync(env, panelId) : null;
  if (panelId && !panel) {
    await sendTelegram(chatId, `❌ پنل "${panelId}" یافت نشد.`, env);
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
    await sendTelegram(chatId, msg, env);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا در ساخت کاربر: ${shortError(error)}`, env);
  }
}

async function handleDelete(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegram(chatId, "استفاده: /delete <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see their panels + users they created
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const allowed = searchRole.panelIds || [];
    results = results.filter(r => allowed.includes(r.panel.id));
  }
  if (!results.length) {
    await sendTelegram(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await deleteClient(panel, identifier, env);
    await sendTelegram(chatId, `✅ کاربر "${identifier}" حذف شد.`, env);
    // Also delete from registered users
    const user = await findUserByEmail(env, identifier, panel.id);
    if (user) await deleteUser(env, user.chatId);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا در حذف: ${shortError(error)}`, env);
  }
}

async function handleEnable(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegram(chatId, "استفاده: /enable <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see their panels + users they created
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const allowed = searchRole.panelIds || [];
    results = results.filter(r => allowed.includes(r.panel.id));
  }
  if (!results.length) {
    await sendTelegram(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await updateClient(panel, client, { enable: true });
    await sendTelegram(chatId, `✅ کاربر "${identifier}" فعال شد.`, env);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleDisable(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegram(chatId, "استفاده: /disable <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see their panels + users they created
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const allowed = searchRole.panelIds || [];
    results = results.filter(r => allowed.includes(r.panel.id));
  }
  if (!results.length) {
    await sendTelegram(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await updateClient(panel, client, { enable: false });
    await sendTelegram(chatId, `⛔ کاربر "${identifier}" غیرفعال شد.`, env);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleAddGB(chatId, args, env) {
  if (args.length < 2) {
    await sendTelegram(chatId, "استفاده: /addgb <شناسه> <حجم GB>", env);
    return;
  }
  const identifier = args[0];
  const gb = Number(args[1]);
  if (!identifier || isNaN(gb) || gb <= 0) {
    await sendTelegram(chatId, "❌ مقادیر نامعتبر.", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see their panels + users they created
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const allowed = searchRole.panelIds || [];
    results = results.filter(r => allowed.includes(r.panel.id));
  }
  if (!results.length) {
    await sendTelegram(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  try {
    await addGBToClient(panel, client, gb);
    const updated = await getClientByIdentifier(identifier, env, panel.id);
    await sendTelegram(chatId, `✅ ${gb} GB حجم اضافه شد.\n\n${updated ? formatClient(updated, panel) : ""}`, env);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleRenewAdmin(chatId, args, env) {
  const identifier = args[0];
  const days = Number(args[1]);
  const panelId = args[2] || null;

  if (!identifier || isNaN(days) || days <= 0) {
    await sendTelegram(chatId, "استفاده: /renew <شناسه> <روز> [آیدی پنل]", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see their panels + users they created
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const allowed = searchRole.panelIds || [];
    results = results.filter(r => allowed.includes(r.panel.id));
  }
  if (!results.length) {
    await sendTelegram(chatId, `❌ کاربری یافت نشد.`, env);
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
    await sendTelegram(chatId, `✅ ${days} روز تمدید شد.\n\n${updated ? formatClient(updated, target.panel) : ""}`, env);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleLink(chatId, args, env) {
  const identifier = args[0];
  if (!identifier) {
    await sendTelegram(chatId, "استفاده: /link <شناسه>", env);
    return;
  }
  let results = await searchClientAcrossPanels(identifier, env);
  // Panel admins: only see their panels + users they created
  const searchRole = await getAdminRole(env, chatId);
  if (searchRole && searchRole.role === "admin") {
    const allowed = searchRole.panelIds || [];
    results = results.filter(r => allowed.includes(r.panel.id));
  }
  if (!results.length) {
    await sendTelegram(chatId, `❌ کاربری یافت نشد.`, env);
    return;
  }
  const { panel, client } = results[0];
  const subId = client.subId || client.subid || client.sub_id || "";
  if (!subId) {
    await sendTelegram(chatId, "❌ لینک اشتراک برای این کاربر موجود نیست.", env);
    return;
  }
  try {
    const link = buildSubLink(subId, panel);
    const qrUrl = `${QR_CODE_API}?size=${QR_CODE_SIZE}x${QR_CODE_SIZE}&data=${encodeURIComponent(link)}`;
    await sendPhoto(chatId, qrUrl, `🔗 لینک اشتراک:\n${link}`, env);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

async function handleClients(chatId, args, env) {
  const page = Math.max(1, Number(args[0]) || 1);
  const panels = await getPanels(env);
  const panel = panels[0]; // Default to first panel

  try {
    const clients = await listAllClients(panel);
    const start = (page - 1) * PER_PAGE;
    const end = start + PER_PAGE;
    const pageClients = clients.slice(start, end);
    const totalPages = Math.ceil(clients.length / PER_PAGE);

    if (!pageClients.length) {
      await sendTelegram(chatId, "❌ کاربری یافت نشد.", env);
      return;
    }

    let msg = `👥 لیست کاربران (صفحه ${page}/${totalPages}):\n\n`;
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
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
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
      await sendTelegram(chatId, `❌ خطا در دریافت وضعیت ${panel.name}: ${shortError(error)}`, env);
    }
  }
}

async function handleOnline(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      // Get online users from /panel/api/inbounds/onlines endpoint
      let onlineUsers = [];
      try {
        const onlineResponse = await panelApi(panel, API_PATHS.INBOUNDS_ONLINE, "GET");
        onlineUsers = extractOnlineUsers(onlineResponse);
      } catch { /* try fallback */ }

      // Fallback: get count from server status
      if (!onlineUsers.length) {
        const status = await getServerStatus(panel);
        const obj = status?.obj || status;
        const onlineCount = Number(obj?.xray?.onlines || obj?.onlines || obj?.onlineCount || 0);
        await sendTelegram(chatId, `🟢 کاربران آنلاین ${panel.name}: ${onlineCount} نفر`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        continue;
      }

      let msg = `🟢 کاربران آنلاین ${panel.name} (${onlineUsers.length} نفر):\n\n`;
      for (const user of onlineUsers.slice(0, 30)) {
        msg += `• ${user.email || user.id || "نامشخص"} — ${user.ip || "IP نامشخص"}\n`;
      }
      if (onlineUsers.length > 30) {
        msg += `\n... و ${onlineUsers.length - 30} کاربر دیگر`;
      }
      await sendTelegram(chatId, msg, env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env, [
        [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
      ]);
    }
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
    // ClientTraffic schema: email, id, uuid, ip, total, up, down, lastOnline, enable, inboundId
    // Online users from /panel/api/inbounds/onlines have: email, ip, total, id, inboundId
    const email = item.email || "";
    const ip = item.ip || "";
    const id = item.id || item.uuid || "";

    // Include if has email and (ip or lastOnline)
    if (email && (ip || item.lastOnline)) {
      const key = email + ":" + ip;
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
          email: email,
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
      await sendTelegram(chatId, msg, env);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayRestart(chatId, args, env) {
  const panelId = args[0] || null;
  const panels = panelId ? [await resolvePanelAsync(env, panelId)].filter(Boolean) : await getPanels(env);
  for (const panel of panels) {
    try {
      await restartXray(panel);
      await sendTelegram(chatId, `✅ Xray در سرور "${panel.name}" ریستارت شد.`, env);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayStop(chatId, args, env) {
  const panelId = args[0] || null;
  const panels = panelId ? [await resolvePanelAsync(env, panelId)].filter(Boolean) : await getPanels(env);
  for (const panel of panels) {
    try {
      await stopXray(panel);
      await sendTelegram(chatId, `⛳ Xray در سرور "${panel.name}" متوقف شد.`, env);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayVersionCmd(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      const ver = await getXrayVersion(panel);
      await sendTelegram(chatId, `🔄 Xray نسخه (${panel.name}): ${ver || "نامشخص"}`, env);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handleXrayUpdate(chatId, args, env) {
  const version = args[0];
  if (!version) {
    await sendTelegram(chatId, "استفاده: /xray_update <نسخه>", env);
    return;
  }
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      await updateXray(panel, version);
      await sendTelegram(chatId, `✅ Xray به نسخه ${version} بروزرسانی شد (${panel.name}).`, env);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handlePanelVersionCmd(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      const ver = await getPanelVersion(panel);
      await sendTelegram(chatId, `📡 نسخه پنل (${panel.name}): ${ver}`, env);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
    }
  }
}

async function handlePanelUpdateCmd(chatId, args, env) {
  const panels = await getPanels(env);
  for (const panel of panels) {
    try {
      await updatePanel(panel);
      await sendTelegram(chatId, `✅ پنل "${panel.name}" بروزرسانی شد.`, env);
    } catch (error) {
      await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
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
  await sendTelegram(chatId, msg, env);
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
    await sendTelegram(chatId, "استفاده: /dellpanel <آیدی پنل>", env);
    return;
  }
  try {
    await removePanel(env, panelId);
    await sendTelegram(chatId, `✅ پنل "${panelId}" حذف شد.`, env);
  } catch (error) {
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

// ─── Admin Management ─────────────────────────────────────────

async function handleMakeAdmin(chatId, env) {
  const allAdmins = await getAllAdminIdsAsync(env);
  if (allAdmins.length > 0) {
    await sendTelegram(chatId, "❌ فقط زمانی که هیچ ادمینی وجود ندارد می‌توانید ادمین شوید.", env);
    return;
  }
  await setSuperAdmin(env, chatId);
  await sendTelegram(chatId, `✅ شما به عنوان سوپر ادمین ثبت شدید!`, env);
}

async function handleAdminAdd(chatId, args, env) {
  const targetId = args[0];
  if (!targetId) {
    await sendTelegram(chatId, "استفاده: /adminadd <chatId>", env);
    return;
  }
  await addAdminId(env, targetId);
  await sendTelegram(chatId, `✅ کاربر ${targetId} به عنوان ادمین اضافه شد.`, env);
}

async function handleAdminDel(chatId, args, env) {
  const targetId = args[0];
  if (!targetId) {
    await sendTelegram(chatId, "استفاده: /admindel <chatId>", env);
    return;
  }
  await removeAdminId(env, targetId);
  await sendTelegram(chatId, `✅ کاربر ${targetId} از ادمین‌ها حذف شد.`, env);
}

// ─── User Usage & Renewal Request ─────────────────────────────

async function handleUserUsage(chatId, env) {
  await sendUserMenu(chatId, env);
}

async function handleRenewalRequest(chatId, env) {
  const user = await getUser(env, chatId);
  if (!user) {
    await sendTelegram(chatId, "❌ شما ثبت‌نام نکرده‌اید.", env);
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
      await sendTelegram(chatId, `❌ خطا در بکاپ ${panel.name}: ${shortError(error)}`, env);
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
    await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
  }
}

// ─── Help ─────────────────────────────────────────────────────

async function handleHelp(chatId, isAdmin, env) {
  if (isAdmin) {
    const msg =
      `📖 دستورات ادمین:\n\n` +
      `🔍 /search <شناسه> — جستجوی کاربر\n` +
      `👤 /user <شناسه> — اطلاعات کاربر\n` +
      `➕ /create <شناسه> <روز> <حجم> [پنل] — ساخت کاربر\n` +
      `🗑 /delete <شناسه> — حذف کاربر\n` +
      `✅ /enable <شناسه> — فعال کردن\n` +
      `⛔ /disable <شناسه> — غیرفعال کردن\n` +
      `📦 /addgb <شناسه> <حجم> — افزایش حجم\n` +
      `⏱ /renew <شناسه> <روز> [پنل] — تمدید\n` +
      `🔗 /link <شناسه> — لینک اشتراک\n` +
      `👥 /clients [صفحه] — لیست کاربران\n` +
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
      `🖥️ مدیریت پنل:\n` +
      `/addpanel — افزودن پنل\n` +
      `/dellpanel <آیدی> — حذف پنل\n` +
      `/panels — لیست پنل‌ها\n` +
      `/backup [پنل] — دریافت بکاپ\n` +
      `/export — خروجی کانفیگ\n\n` +
      `🛠️ مدیریت ادمین:\n` +
      `/makeadmin — ادمین شدن (فقط اولین بار)\n` +
      `/adminadd <chatId> — افزودن ادمین\n` +
      `/admindel <chatId> — حذف ادمین\n` +
      `/admin — پنل مدیریت`;
    await sendTelegram(chatId, msg, env);
  } else {
    const msg =
      `📖 دستورات:\n\n` +
      `/start — ثبت‌نام / مشاهده اطلاعات\n` +
      `/usage — مشاهده مصرف\n` +
      `/renew — درخواست تمدید\n` +
      `/help — راهنما`;
    await sendTelegram(chatId, msg, env);
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
        if (subId && panel.subBaseUrl) {
          const link = buildSubLink(subId, panel);
          const qrUrl = `${QR_CODE_API}?size=${QR_CODE_SIZE}x${QR_CODE_SIZE}&data=${encodeURIComponent(link)}`;
          if (messageId) await deleteMessage(chatId, messageId, env);
          await sendPhoto(chatId, qrUrl, `🔗 لینک اشتراک:\n${link}`, env, [
            [{ text: "🔙 منوی اصلی", callback_data: "user_back" }],
          ]);
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
        await sendTelegram(chatId, "❌ کاربر یافت نشد.", env);
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
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendAdminMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_status") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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
      // Cancel any active addpanel state
      await stateDelete(env, `${STATE_ADDPANEL_PREFIX}${chatId}`);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendPanelsMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_addpanel") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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
      const panelId = data.slice("panel_del_confirm:".length);
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendTelegram(chatId, `⚠️ آیا مطمئنید پنل "${panelId}" حذف شود؟`, env, [
        [
          { text: "✅ بله، حذف شود", callback_data: `panel_del_yes:${panelId}` },
          { text: "❌ خیر", callback_data: "admin_panels" },
        ],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("panel_del_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
      const panelId = data.slice("panel_del_yes:".length);
      if (messageId) await deleteMessage(chatId, messageId, env);
      try {
        await removePanel(env, panelId);
        await sendTelegram(chatId, `✅ پنل "${panelId}" حذف شد.`, env, [
          [{ text: "🔙 مدیریت پنل‌ها", callback_data: "admin_panels" }],
        ]);
      } catch (error) {
        await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
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
      if (messageId) await deleteMessage(chatId, messageId, env);
      await sendXrayMenu(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_xray_update") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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
          await sendTelegram(chatId, `❌ خطا: ${shortError(error)}`, env);
        }
      }
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_backup") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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
      if (messageId) await deleteMessage(chatId, messageId, env);
      await handleExportConfig(chatId, env);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data === "admin_report") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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
    if (data === "admin_error_logs") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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
      if (messageId) await deleteMessage(chatId, messageId, env);
      await clearErrorLogs(env);
      await sendTelegram(chatId, "✅ خطاها پاک شدند.", env, [[{text:"🔙",callback_data:"admin_back"}]]);
      await answerCallbackQuery(callbackQueryId, env, "پاک شد");
      return;
    }

    // ── Ban/Suspend menu (super admin) ──
    if (data === "admin_ban_menu") {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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
      const isSuper = await isSuperAdmin(env, chatId);
      if (!isSuper) { await answerCallbackQuery(callbackQueryId, env, "فقط سوپر ادمین"); return; }
      if (messageId) await deleteMessage(chatId, messageId, env);
      const targetId = data.slice("admin_remove:".length);
      await sendTelegram(chatId, `⚠️ آیا مطمئنید ادمین "${targetId}" حذف شود؟`, env, [
        [
          { text: "✅ بله", callback_data: `admin_remove_yes:${targetId}` },
          { text: "❌ خیر", callback_data: "admin_manage_admins" },
        ],
      ]);
      await answerCallbackQuery(callbackQueryId, env);
      return;
    }

    if (data.startsWith("admin_remove_yes:")) {
      if (!admin) { await answerCallbackQuery(callbackQueryId, env, "دسترسی ندارید"); return; }
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

      const { action, panelId, identifier } = actionObj;
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
        const link = buildSubLink(subId, panel);
        const qrUrl = `${QR_CODE_API}?size=${QR_CODE_SIZE}x${QR_CODE_SIZE}&data=${encodeURIComponent(link)}`;
        await sendPhoto(chatId, qrUrl, `🔗 لینک اشتراک:\n${link}`, env, [
          [{ text: "🔙 منوی اصلی", callback_data: "admin_back" }],
        ]);
        await answerCallbackQuery(callbackQueryId, env, "لینک اشتراک");
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

