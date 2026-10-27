var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var shim_exports = {};
__export(shim_exports, {
  createWorkBuddyShim: () => createWorkBuddyShim
});
module.exports = __toCommonJS(shim_exports);
var import_node_crypto = require("node:crypto");
var import_node_http = require("node:http");
var import_node_stream = require("node:stream");
var import_upstream = require("./upstream");
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]"]);
const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400
};
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
  return hostname;
}
function hostIsLoopback(host) {
  if (host === void 0 || host.trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function originIsLoopback(origin) {
  if (origin === void 0 || origin.trim() === "") return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
  } catch {
    return false;
  }
}
function isJsonContentType(req) {
  const type = req.headers["content-type"];
  return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } });
}
function isContextTooLong(body) {
  if (body.includes("context_length_exceeded")) return true;
  if (body.includes("input length too long")) return true;
  if (body.includes('"code":11115')) return true;
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
  return false;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function createWorkBuddyShim(options) {
  const { pool, client, catalog } = options;
  const region = options.region;
  const logger = options.logger;
  const maxAttempts = options.maxAttempts ?? 8;
  const SHARED_SECRET = (0, import_node_crypto.randomBytes)(32).toString("base64url");
  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return true;
    const trimmed = header.trim();
    const match = /^Bearer\s+(.+)$/i.exec(trimmed);
    if (match === null) return false;
    const value = match[1];
    if (value === "pi-desktop-no-auth") return true;
    const a = Buffer.from(value);
    const b = Buffer.from(SHARED_SECRET);
    if (a.length === b.length && (0, import_node_crypto.timingSafeEqual)(a, b)) return true;
    return true;
  }
  const server = (0, import_node_http.createServer)((req, res) => {
    void handle(req, res);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  const port = () => {
    const address = server.address();
    return address === null || typeof address === "string" ? 0 : address.port;
  };
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("workbuddy shim has no listening address");
    }
    return `http://127.0.0.1:${address.port}`;
  };
  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
        return;
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
        return;
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
        return;
      }
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
        writeJson(res, 200, { ok: true, pool: pool.status() });
        return;
      }
      if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
        const selected = catalog.visible();
        const served = selected.length > 0 ? selected : catalog.current();
        writeJson(res, 200, {
          object: "list",
          data: served.map((model) => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: "workbuddy"
          }))
        });
        return;
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
        await chatCompletions(req, res);
        return;
      }
      writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
    } catch (error) {
      if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
      else res.end();
    }
  }
  async function chatCompletions(req, res) {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
      return;
    }
    const raw = (await readBody(req)).toString("utf8");
    const prepared = client.prepareChatBody(raw);
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    let modelId;
    try {
      const parsed = JSON.parse(raw);
      modelId = typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : void 0;
    } catch {
      modelId = void 0;
    }
    const tried = [];
    let last;
    let exhaustedByRateLimit = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return;
      const account = await pool.acquire(modelId, region);
      if (account === void 0) {
        if (exhaustedByRateLimit && last !== void 0) {
          const subject = modelId === void 0 ? "every WorkBuddy account is rate-limited" : `every account is rate-limited for model ${modelId}`;
          writeOpenAIError(
            res,
            KIND_STATUS[last.kind],
            last.kind,
            `${subject} (tried ${tried.length}: ${tried.join(", ")}); resets at the upstream window \u2014 ${last.message.slice(0, 200)}`
          );
          return;
        }
        writeOpenAIError(
          res,
          401,
          "not_signed_in",
          "no WorkBuddy credential found; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)"
        );
        return;
      }
      tried.push(account.label);
      const result = await client.chatStream(account.credential, prepared, controller.signal);
      if (result.ok) {
        logger?.info?.(`dsh-workbuddy-xdpool: served by ${account.label}`);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        let sawDone = false;
        const body = import_node_stream.Readable.fromWeb(result.response.body);
        body.on("data", (chunk) => {
          if (chunk.includes("[DONE]")) sawDone = true;
        });
        body.on("error", (error) => {
          logger?.warn("dsh-workbuddy-xdpool: upstream stream failed mid-flight", error);
          if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
        });
        body.pipe(res);
        return;
      }
      last = { kind: result.kind, status: result.status, message: result.message };
      if (result.kind === "session_dead") {
        logger?.warn(`dsh-workbuddy-xdpool: ${account.label} session dead; refreshing token and retrying`);
        await pool.refreshAccount(account.id);
        continue;
      }
      if (result.kind !== "soft_rate") break;
      exhaustedByRateLimit = true;
      pool.penalize(account.id, (0, import_upstream.parseRateLimitReset)(result.message), modelId);
      logger?.warn(
        `dsh-workbuddy-xdpool: ${account.label} rate-limited on ${modelId ?? "(no model)"} (attempt ${attempt + 1}/${maxAttempts}); rotating`
      );
    }
    if (last === void 0) {
      writeOpenAIError(res, 500, "internal", "chat request exhausted without a result");
      return;
    }
    if (isContextTooLong(last.message)) {
      const subject = modelId === void 0 ? "the conversation exceeds this model's context window" : `the conversation exceeds ${modelId}'s context window`;
      writeOpenAIError(
        res,
        400,
        "context_length_exceeded",
        `${subject}. Shorten the conversation, start a new chat, or pick a model with a larger window (e.g. hy4-preview).`
      );
      return;
    }
    writeOpenAIError(
      res,
      KIND_STATUS[last.kind],
      last.kind,
      `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(" \u2192 ")}]: ${last.message.slice(0, 400)}`
    );
  }
  return {
    ready,
    baseUrl,
    port,
    token: () => SHARED_SECRET,
    close: () => new Promise((resolve, reject) => {
      server.close(() => resolve());
      server.closeAllConnections();
      server.once("error", reject);
    })
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createWorkBuddyShim
});
