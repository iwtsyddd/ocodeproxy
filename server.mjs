import express from "express";
import boxen from "boxen";
import pc from "picocolors";
import * as p from "@clack/prompts";
import readline from "node:readline";
import net from "node:net";
import crypto from "node:crypto";
import https from "node:https";
import fs from "node:fs";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ocId } from "./lib/ids.mjs";
import { generateKeyString, maskKey, isValidKeysObject } from "./lib/keys.mjs";
import {
  FINGERPRINT_TOOLS,
  ensureFingerprintTools,
  ensureAssistantReasoning,
  chatToResponses,
  responsesToOpenAI,
  aggregateSseToCompletion,
  aggregateResponsesSseToOpenAI,
  aggregateResponsesSseToResponses,
  responsesInputToChatMessages,
  chatCompletionToResponses,
  normalizeResponsesTools,
  estimateAnthropicTokens,
  pickChatParams,
  pickResponsesParams,
  chatParamsToResponsesParams,
  anthropicToOpenAI,
  openAIToAnthropic,
} from "./lib/convert.mjs";
import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_RESPONSES_MODELS,
  DISCONTINUED_MODELS,
  resolveModel,
  isModelDeprecated,
  isModelKnown,
  isModelResponses,
  partitionDiscovered,
  shouldKeepCurrent,
  getFallbackModels,
} from "./lib/models.mjs";
import {
  responsesErrorStatus,
  mapZenError,
  publicNetworkMessage,
  detectUpstreamError,
  isRetryableUpstreamStatus,
} from "./lib/errors.mjs";
import { collectWithFallback, tryStreamFallback } from "./lib/fallback.mjs";

const app = express();
app.use(express.json({ limit: "10mb" }));

process.title = "OCodeProxy";
if (process.stdout.isTTY) {
  process.stdout.write("\x1b]0;OCodeProxy\x07");
}

const TUI_VERSION = "v0.1.0-t1";
const PROXY_VERSION = process.env.PROXY_VERSION || "16";
const FALLBACK_OC_VERSION = "1.18.31";
let ocVersion = process.env.OC_VERSION || FALLBACK_OC_VERSION;
let lastOcVersionCheck = 0;
const OC_VERSION_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

const AI_SDK_VER = process.env.AI_SDK_VER || "4.0.23";
const BUN_VER = process.env.BUN_VER || "1.3.13";
const OPENCODE_CLIENT = process.env.OPENCODE_CLIENT || "cli";
const OPENCODE_PROJECT = process.env.OPENCODE_PROJECT || "global";
const ZEN_AUTH_MODE = process.env.ZEN_AUTH_MODE || "public";
const KEYS_FILE = process.env.KEYS_FILE || "./api-keys.json";
const MODELS_FILE = process.env.MODELS_FILE || "./models.json";
const PROXY_CONFIG_FILE = process.env.PROXY_CONFIG_FILE || "./proxy-config.json";

let upstreamProxyUrl = process.env.UPSTREAM_PROXY || process.env.ALL_PROXY || process.env.HTTPS_PROXY || "";
let upstreamProxyAgent = null;

function setupProxyAgent(proxyUrl) {
  if (!proxyUrl || !proxyUrl.trim()) {
    upstreamProxyUrl = "";
    upstreamProxyAgent = null;
    return;
  }
  const url = proxyUrl.trim();
  try {
    if (url.startsWith("socks5://") || url.startsWith("socks4://") || url.startsWith("socks://")) {
      upstreamProxyAgent = new SocksProxyAgent(url);
      upstreamProxyUrl = url;
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      upstreamProxyAgent = new HttpsProxyAgent(url);
      upstreamProxyUrl = url;
    } else {
      upstreamProxyAgent = new HttpsProxyAgent(`http://${url}`);
      upstreamProxyUrl = `http://${url}`;
    }
  } catch (err) {
    console.error(pc.yellow(`Invalid upstream proxy URL, falling back to direct connection: ${err?.message || err}`));
    upstreamProxyAgent = null;
    upstreamProxyUrl = "";
  }
}

function applyUpstreamProxy(options) {
  if (!options || typeof options !== "object") return options;
  if (upstreamProxyAgent) {
    options.agent = upstreamProxyAgent;
  } else if ("agent" in options) {
    delete options.agent;
  }
  return options;
}

function saveProxyConfig() {
  try {
    fs.writeFileSync(PROXY_CONFIG_FILE, JSON.stringify({ upstreamProxy: upstreamProxyUrl }, null, 2), "utf8");
  } catch {}
}

function loadProxyConfig() {
  try {
    if (fs.existsSync(PROXY_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROXY_CONFIG_FILE, "utf8"));
      if (typeof data.upstreamProxy === "string") {
        setupProxyAgent(data.upstreamProxy);
      }
    } else if (upstreamProxyUrl) {
      setupProxyAgent(upstreamProxyUrl);
    }
  } catch {}
}
loadProxyConfig();

function fetchLatestOcVersion() {
  return new Promise((resolve) => {
    const options = {
      hostname: "registry.npmjs.org",
      port: 443,
      path: "/opencode-ai/latest",
      method: "GET",
      headers: {
        "User-Agent": "node",
        "Accept": "application/json",
      },
      timeout: 10000,
    };
    applyUpstreamProxy(options);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) return resolve(null);
          const pkg = JSON.parse(data);
          if (typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version)) {
            return resolve(pkg.version);
          }
          resolve(null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function updateOcVersion(silent = false) {
  const latest = await fetchLatestOcVersion();
  if (latest) {
    lastOcVersionCheck = Date.now();
    if (latest !== ocVersion) {
      const prev = ocVersion;
      ocVersion = latest;
      if (!silent) {
        console.log(pc.green(`✔ Updated OpenCode User-Agent version: ${prev} → ${pc.bold(latest)}`));
      }
      return { updated: true, version: latest, prev };
    }
    return { updated: false, version: ocVersion, latest };
  }
  lastOcVersionCheck = Date.now() - OC_VERSION_CHECK_INTERVAL + 15 * 60 * 1000;
  return { updated: false, version: ocVersion, latest: null };
}

let ocVersionCheckInFlight = null;
function checkPeriodicOcVersion() {
  if (Date.now() - lastOcVersionCheck <= OC_VERSION_CHECK_INTERVAL) return;
  if (ocVersionCheckInFlight) return;
  ocVersionCheckInFlight = updateOcVersion(true)
    .catch(() => {})
    .finally(() => { ocVersionCheckInFlight = null; });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.once("close", () => resolve(true)).close();
      })
      .listen(port, "0.0.0.0");
  });
}

const args = process.argv.slice(2);
let cliPort = null;
const portIdx = args.findIndex((arg) => arg === "-p" || arg === "--port");
if (portIdx !== -1 && args[portIdx + 1]) {
  const parsed = Number(args[portIdx + 1]);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    cliPort = parsed;
  }
}

let currentPort = cliPort || (process.env.PROXY_PORT ? Number(process.env.PROXY_PORT) : 6446);
let currentServer = null;

async function promptPortSelection(current) {
  if (!process.stdin.isTTY) return null;
  const choice = await p.select({
    message: "Select port:",
    initialValue: String(current),
    options: [
      { value: "6446", label: "6446", hint: "default (OCodeProxy)" },
      { value: "8080", label: "8080", hint: "alternative HTTP port" },
      { value: "3000", label: "3000", hint: "standard dev port" },
      { value: "custom", label: "Custom port...", hint: "manual entry" },
    ],
  });

  if (p.isCancel(choice)) return null;

  if (choice === "custom") {
    const customPort = await p.text({
      message: "Enter port number (1-65535):",
      placeholder: String(current),
      defaultValue: String(current),
      validate(value) {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 1 || num > 65535) {
          return "Port must be an integer between 1 and 65535";
        }
      },
    });

    if (p.isCancel(customPort)) return null;
    return Number(customPort);
  }

  return Number(choice);
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const time = new Date().toLocaleTimeString();
    if (!process.stdout.isTTY) {
      console.error(`[${time}] ${req.method.padEnd(6)} ${req.originalUrl.padEnd(24)} ${res.statusCode} ${duration}ms`);
      return;
    }
    const statusColor =
      res.statusCode >= 500
        ? pc.red
        : res.statusCode >= 400
        ? pc.yellow
        : res.statusCode >= 300
        ? pc.cyan
        : pc.green;

    console.log(
      `${pc.gray(`[${time}]`)} ` +
      `${pc.bold(pc.cyan(req.method.padEnd(6)))} ` +
      `${req.originalUrl.padEnd(24)} ` +
      `${statusColor(String(res.statusCode))} ` +
      `${pc.dim(`${duration}ms`)}`
    );
  });
  next();
});

let apiKeys = {};

function saveKeys() {
  try {
    const tmpFile = `${KEYS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(apiKeys, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(tmpFile, 0o600);
    } catch {}
    fs.renameSync(tmpFile, KEYS_FILE);
  } catch (err) {
    console.error(pc.red(`Failed to save API keys: ${err?.message || err}`));
  }
}

function loadKeys() {
  let raw = null;
  try {
    raw = fs.readFileSync(KEYS_FILE, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error(pc.red(`Failed to read API keys file: ${err?.message || err}`));
    }
  }
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      if (!isValidKeysObject(parsed)) throw new Error("keys file must be a non-empty object of name-to-key strings");
      apiKeys = parsed;
      return;
    } catch (err) {
      const backupFile = `${KEYS_FILE}.corrupt-${Date.now()}.bak`;
      try {
        fs.writeFileSync(backupFile, raw, "utf8");
        console.error(pc.yellow(`API keys file is corrupt, backed up to ${backupFile}: ${err?.message || err}`));
      } catch (backupErr) {
        console.error(pc.red(`API keys file is corrupt and backup failed: ${backupErr?.message || backupErr}`));
      }
    }
  }
  apiKeys = {
    admin: generateKeyString(),
    "user-default": generateKeyString(),
  };
  saveKeys();
}
loadKeys();

function auth(req) {
  const raw = req.headers.authorization ?? req.headers["x-api-key"] ?? "";
  const hdr = Array.isArray(raw) ? raw[0] ?? "" : raw;
  if (typeof hdr !== "string") return null;
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  const tokBuf = Buffer.from(tok);
  for (const [name, key] of Object.entries(apiKeys)) {
    if (typeof key !== "string" || !key) continue;
    const keyBuf = Buffer.from(key);
    if (tokBuf.length === keyBuf.length && crypto.timingSafeEqual(tokBuf, keyBuf)) return name;
  }
  return null;
}

const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: ocId("ses"), ts: now };
  }
  return userSessions[user].id;
}

function buildZenHeaders(sessionId, requestId, isStream = false, bodyLength = 0, zenKey = null) {
  checkPeriodicOcVersion();
  const reqId = requestId || ocId("msg");
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${zenKey || ZEN_AUTH_MODE}`,
    "User-Agent": `opencode/${ocVersion} ai-sdk/provider-utils/${AI_SDK_VER} runtime/bun/${BUN_VER}`,
    "x-opencode-client": OPENCODE_CLIENT,
    "x-opencode-project": OPENCODE_PROJECT,
    "x-opencode-request": reqId,
    "x-opencode-session": sessionId,
    "Accept": isStream ? "text/event-stream" : "application/json",
  };
  if (bodyLength > 0) {
    headers["Content-Length"] = bodyLength;
  }
  return headers;
}

function zenKeyFromReq(req) {
  const raw = req.headers?.["x-zen-key"] ?? req.headers?.["x-opencode-key"] ?? "";
  const s = Array.isArray(raw) ? raw[0] : raw;
  const key = typeof s === "string" ? s.trim() : "";
  return key || null;
}

function parsePositiveIntEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return def;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

const FALLBACK_ATTEMPTS = parsePositiveIntEnv("FALLBACK_ATTEMPTS", 3, 1, 10);
const FALLBACK_DELAY_MS = parsePositiveIntEnv("FALLBACK_DELAY_MS", 300, 0, 10000);

function candidateModels(targetModel) {
  const list = [targetModel, ...getFallbackModels(targetModel, CHAT_MODELS, RESPONSES_MODELS)];
  const sliced = list.slice(0, FALLBACK_ATTEMPTS);
  if (sliced.length === 1) sliced.push(sliced[0]);
  return sliced;
}

function fallbackExtra(attempts) {
  return { attempts, attemptIndex: 0, fallbackDelayMs: FALLBACK_DELAY_MS };
}

function chatAttempts(models, messages, tools, tool_choice, sessionId, params, zenKey) {
  return models.map((m) => ({ ...zenRequest(m, messages, true, tools, tool_choice, sessionId, params, zenKey), model: m }));
}

function responsesAttempts(models, messages, tools, tool_choice, sessionId, params, zenKey) {
  return models.map((m) => ({ ...zenResponsesRequest(m, messages, true, tools, tool_choice, sessionId, params, zenKey), model: m }));
}

function responsesDirectAttempts(models, input, instructions, tools, tool_choice, sessionId, params, zenKey) {
  return models.map((m) => ({ ...zenResponsesDirectRequest(m, input, instructions, tools, tool_choice, sessionId, params, zenKey), model: m }));
}

function collectAttempts(attempts) {
  return collectWithFallback(attempts, (options, body) => collectZenSse(options, body), { fallbackDelayMs: FALLBACK_DELAY_MS });
}

function zenRequest(model, messages, _stream, tools, tool_choice, sessionId, params, zenKey) {
  const preparedMessages = ensureAssistantReasoning(messages);
  const hadClientTools = Array.isArray(tools) && tools.length > 0;
  const mergedTools = ensureFingerprintTools(tools);

  const reqBody = {
    model,
    messages: preparedMessages,
    stream: true,
    tools: mergedTools,
    ...pickChatParams(params),
  };
  if (tool_choice) {
    reqBody.tool_choice = tool_choice;
  } else if (!hadClientTools) {
    reqBody.tool_choice = "none";
  }

  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");
  const headers = buildZenHeaders(sessionId, requestId, true, Buffer.byteLength(body), zenKey);

  const options = {
    hostname: "opencode.ai",
    port: 443,
    path: "/zen/v1/chat/completions",
    method: "POST",
    headers,
    timeout: 120000,
  };
  applyUpstreamProxy(options);

  return {
    body,
    options,
  };
}

function zenResponsesRequest(targetModel, messages, _stream, tools, tool_choice, sessionId, params, zenKey) {
  const mergedTools = ensureFingerprintTools(tools);
  const effectiveToolChoice = tool_choice || "auto";
  const reqPayload = chatToResponses(targetModel, messages, mergedTools, effectiveToolChoice);
  reqPayload.stream = true;
  Object.assign(reqPayload, chatParamsToResponsesParams(params));
  const body = JSON.stringify(reqPayload);
  const requestId = ocId("msg");
  const headers = buildZenHeaders(sessionId, requestId, true, Buffer.byteLength(body), zenKey);

  const options = {
    hostname: "opencode.ai",
    port: 443,
    path: "/zen/v1/responses",
    method: "POST",
    headers,
    timeout: 120000,
  };
  applyUpstreamProxy(options);

  return {
    body,
    options,
  };
}

function zenResponsesDirectRequest(targetModel, input, instructions, tools, tool_choice, sessionId, params, zenKey) {
  const normalized = normalizeResponsesTools(tools);
  const mergedTools = ensureFingerprintTools(normalized.map((t) => ({ type: "function", function: t })));
  const reqPayload = {
    model: targetModel,
    input: typeof input === "string" || Array.isArray(input) ? input : [],
    stream: true,
    ...pickResponsesParams(params),
  };
  if (typeof instructions === "string" && instructions) reqPayload.instructions = instructions;
  if (mergedTools.length) {
    reqPayload.tools = mergedTools.map((t) => ({
      type: "function",
      name: t.function?.name || t.name || "",
      description: t.function?.description || t.description || "",
      parameters: t.function?.parameters || t.parameters || {},
    }));
  }
  reqPayload.tool_choice = tool_choice || "auto";
  const body = JSON.stringify(reqPayload);
  const requestId = ocId("msg");
  const headers = buildZenHeaders(sessionId, requestId, true, Buffer.byteLength(body), zenKey);

  const options = {
    hostname: "opencode.ai",
    port: 443,
    path: "/zen/v1/responses",
    method: "POST",
    headers,
    timeout: 120000,
  };
  applyUpstreamProxy(options);

  return { body, options };
}

let CHAT_MODELS = [...DEFAULT_CHAT_MODELS];
let RESPONSES_MODELS = [...DEFAULT_RESPONSES_MODELS];
let ALL_MODELS = [...CHAT_MODELS, ...RESPONSES_MODELS];
let RESPONSES_SET = new Set(RESPONSES_MODELS);
let lastModelsFetchTime = 0;

function saveModels() {
  try {
    fs.writeFileSync(MODELS_FILE, JSON.stringify(ALL_MODELS, null, 2), "utf8");
  } catch {}
}

function loadModels() {
  try {
    const raw = fs.readFileSync(MODELS_FILE, "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0) {
      const filtered = list.filter((id) => !DISCONTINUED_MODELS.has(id));
      const resp = filtered.filter((id) => id.startsWith("muse-spark"));
      const chat = filtered.filter((id) => !id.startsWith("muse-spark"));
      if (chat.length || resp.length) {
        CHAT_MODELS = chat;
        RESPONSES_MODELS = resp;
        ALL_MODELS = [...CHAT_MODELS, ...RESPONSES_MODELS];
        RESPONSES_SET = new Set(RESPONSES_MODELS);
      }
    }
  } catch {}
}
loadModels();

function isDeprecatedModel(model) {
  return isModelDeprecated(model);
}

function isResponsesModel(model) {
  return isModelResponses(model, RESPONSES_SET);
}

function isKnownModel(model) {
  return isModelKnown(model, ALL_MODELS);
}

const MODELS_REFRESH_DEBOUNCE = 5 * 60 * 1000;
let refreshInFlight = null;
async function maybeRefreshModels() {
  if (Date.now() - lastModelsFetchTime <= MODELS_REFRESH_DEBOUNCE) return;
  if (refreshInFlight) {
    await refreshInFlight.catch(() => {});
    return;
  }
  refreshInFlight = refreshModels(true).catch(() => false);
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function fetchUpstreamModels() {
  return new Promise((resolve) => {
    checkPeriodicOcVersion();
    const headers = {
      "Authorization": `Bearer ${ZEN_AUTH_MODE}`,
      "User-Agent": `opencode/${ocVersion} ai-sdk/provider-utils/${AI_SDK_VER} runtime/bun/${BUN_VER}`,
      "x-opencode-client": OPENCODE_CLIENT,
      "x-opencode-project": OPENCODE_PROJECT,
      "Accept": "application/json",
    };

    const options = {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/models",
      method: "GET",
      headers,
      timeout: 15000,
    };
    applyUpstreamProxy(options);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            return resolve(null);
          }
          const parsed = JSON.parse(data);
          const list = Array.isArray(parsed?.data) ? parsed.data : [];
          if (!list.length) return resolve(null);

          const discoveredIds = list.map((m) => m.id).filter(Boolean);
          const { chat: newChat, responses: newResponses } = partitionDiscovered(discoveredIds);

          if (!newChat.length && !newResponses.length) return resolve(null);

          resolve({ chat: newChat, responses: newResponses });
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function refreshModels(silent = false, opts = {}) {
  const result = await fetchUpstreamModels();
  if (result) {
    const guard = shouldKeepCurrent(
      { chat: CHAT_MODELS, responses: RESPONSES_MODELS },
      result
    );
    if (guard.keep) {
      lastModelsFetchTime = Date.now();
      const total = result.chat.length + result.responses.length;
      console.log(pc.yellow(`Upstream returned only ${total} models (have ${ALL_MODELS.length}), keeping current list.`));
      return false;
    }
    CHAT_MODELS = result.chat;
    RESPONSES_MODELS = result.responses;
    ALL_MODELS = [...CHAT_MODELS, ...RESPONSES_MODELS];
    RESPONSES_SET = new Set(RESPONSES_MODELS);
    lastModelsFetchTime = Date.now();
    saveModels();
    if (!silent) {
      console.log(pc.green(`✔ Discovered ${ALL_MODELS.length} models from upstream Zen API.`));
    }
    return true;
  }
  lastModelsFetchTime = Date.now();
  return false;
}

function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    applyUpstreamProxy(zenOpts);
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const headers = zenRes.headers || {};
        try {
          resolve({ status: zenRes.statusCode, data: JSON.parse(raw), raw, headers });
        } catch {
          resolve({ status: zenRes.statusCode, data: null, raw, headers });
        }
      });
      zenRes.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Upstream timeout")); });
    req.write(body);
    req.end();
  });
}

function collectZenSse(zenOpts, body) {
  return new Promise((resolve, reject) => {
    applyUpstreamProxy(zenOpts);
    let receivedBytes = 0;
    const markStarted = (err) => {
      if (receivedBytes > 0) err.upstreamStarted = true;
      return err;
    };
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => {
        receivedBytes += c.length;
        chunks.push(c);
      });
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const headers = zenRes.headers || {};
        const det = detectUpstreamError(raw);
        if (!det.needMore && !det.isStream && det.parsed) {
          const fb = zenRes.statusCode >= 400 ? zenRes.statusCode : 502;
          return resolve({ status: responsesErrorStatus(det.parsed, fb), error: det.parsed, headers });
        }
        resolve({ status: zenRes.statusCode, raw, headers });
      });
      zenRes.on("error", (e) => reject(markStarted(e)));
    });
    req.on("error", (e) => reject(markStarted(e)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Upstream timeout")); });
    req.write(body);
    req.end();
  });
}

function pipeZenResponses(zenOpts, body, requestedModel, res, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const chatId = ocId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let headersSent = false;
  let buffer = "";
  let firstChunkHandled = false;
  const toolMap = new Map();
  let finished = false;

  function sendHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
  }

  function sendDelta(delta, finishReason = null) {
    res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    if (res.flush) res.flush();
  }

  function finish(finishReason) {
    if (finished) return;
    finished = true;
    sendHeaders();
    sendDelta({}, finishReason);
    res.write("data: [DONE]\n\n");
    res.end();
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      const str = chunk.toString();
      buffer += str;
      if (!firstChunkHandled) {
        const det = detectUpstreamError(buffer);
        if (det.needMore) return;
        firstChunkHandled = true;
        if (!det.isStream && det.parsed) {
          const mapped = mapZenError(responsesErrorStatus(det.parsed, zenRes.statusCode), det.parsed, "openai");
          if (isRetryableUpstreamStatus(mapped.status) && tryStreamFallback(extra, res, (nxt, ex) => pipeZenResponses(nxt.options, nxt.body, nxt.model, res, ex), { fallbackDelayMs: FALLBACK_DELAY_MS })) {
            finished = true;
            try {
              zenRes.resume();
            } catch {}
            try {
              req.destroy();
            } catch {}
            return;
          }
          finished = true;
          try {
            zenRes.resume();
          } catch {}
          try {
            req.destroy();
          } catch {}
          if (!res.headersSent && !res.writableEnded) {
            res.status(mapped.status).json(mapped.body);
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {}
          }
          return;
        }
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }

        if (ev.type === "response.output_text.delta" && ev.delta) {
          sendHeaders();
          sendDelta({ content: ev.delta });
        } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          sendHeaders();
          const idx = toolMap.size;
          toolMap.set(ev.item.id, { index: idx, name: ev.item.name || "", call_id: ev.item.call_id || ev.item.id });
          sendDelta({ tool_calls: [{ index: idx, id: ev.item.call_id || ev.item.id, type: "function", function: { name: ev.item.name || "", arguments: "" } }] });
        } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
          sendHeaders();
          let entry = toolMap.get(ev.item_id);
          if (!entry) {
            entry = { index: toolMap.size, name: "", call_id: ev.item_id };
            toolMap.set(ev.item_id, entry);
          }
          sendDelta({ tool_calls: [{ index: entry.index, function: { arguments: ev.delta } }] });
        } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
          if (!toolMap.has(ev.item.id)) {
            sendHeaders();
            const idx = toolMap.size;
            toolMap.set(ev.item.id, { index: idx, name: ev.item.name, call_id: ev.item.call_id });
            sendDelta({ tool_calls: [{ index: idx, id: ev.item.call_id, type: "function", function: { name: ev.item.name, arguments: ev.item.arguments || "{}" } }] });
          }
        } else if (ev.type === "response.completed") {
          const resp = ev.response || {};
          let finishReason = "stop";
          for (const item of resp.output || []) {
            if (item.type === "function_call") { finishReason = "tool_calls"; break; }
          }
          finish(finishReason);
        } else if (ev.type === "response.failed" || ev.type === "response.incomplete") {
          finish("stop");
        }
      }
    });

    zenRes.on("end", () => {
      if (finished) return;
      if (!headersSent) {
        finished = true;
        if (!res.headersSent && !res.writableEnded) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "openai");
          res.status(mapped.status).json(mapped.body);
        } else if (!res.writableEnded) {
          try {
            res.end();
          } catch {}
        }
        return;
      }
      finish(toolMap.size ? "tool_calls" : "stop");
    });

    zenRes.on("error", (e) => {
      if (finished) return;
      try {
        req.destroy();
      } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        res.status(mapped.status).json(mapped.body);
      } else if (!finished) {
        try { finish("stop"); } catch {}
      }
    });
  });

  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      res.status(mapped.status).json(mapped.body);
    } else if (headersSent && !finished) {
      try { finish("stop"); } catch {}
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      res.status(mapped.status).json(mapped.body);
    } else if (headersSent && !finished) {
      try { finish("stop"); } catch {}
    }
  });

  res.on("close", () => {
    if (!finished) {
      finished = true;
      try {
        req.destroy();
      } catch {}
    }
  });

  req.write(body);
  req.end();
}

function pipeZenResponsesAsAnthropic(zenOpts, body, model, res, inputTokens, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const msgId = ocId("msg");
  let headersSent = false;
  let buffer = "";
  let firstChunkHandled = false;
  let finished = false;
  let textOpen = false;
  const toolEntries = [];
  let outputTokens = 0;

  function sendSSE(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  }

  function sendHeaders() {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    sendSSE("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", content: [],
        model, stop_reason: null,
        usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  function closeBlocksAndStop(stopReason) {
    if (finished) return;
    finished = true;
    const totalBlocks = (textOpen ? 1 : 0) + toolEntries.length;
    for (let i = 0; i < totalBlocks; i++) {
      sendSSE("content_block_stop", { type: "content_block_stop", index: i });
    }
    sendSSE("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
    sendSSE("message_stop", { type: "message_stop" });
    res.end();
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      const str = chunk.toString();
      buffer += str;
      if (!firstChunkHandled) {
        const det = detectUpstreamError(buffer);
        if (det.needMore) return;
        firstChunkHandled = true;
        if (!det.isStream && det.parsed) {
          const mapped = mapZenError(responsesErrorStatus(det.parsed, zenRes.statusCode), det.parsed, "anthropic");
          if (isRetryableUpstreamStatus(mapped.status) && tryStreamFallback(extra, res, (nxt, ex) => pipeZenResponsesAsAnthropic(nxt.options, nxt.body, nxt.model, res, inputTokens, ex), { fallbackDelayMs: FALLBACK_DELAY_MS })) {
            finished = true;
            try {
              zenRes.resume();
            } catch {}
            try {
              req.destroy();
            } catch {}
            return;
          }
          finished = true;
          try {
            zenRes.resume();
          } catch {}
          try {
            req.destroy();
          } catch {}
          if (!res.headersSent && !res.writableEnded) {
            res.status(mapped.status).json(mapped.body);
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {}
          }
          return;
        }
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }

        if (ev.type === "response.output_text.delta" && ev.delta) {
          sendHeaders();
          if (!textOpen) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            textOpen = true;
          }
          sendSSE("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ev.delta } });
          outputTokens += Math.ceil(ev.delta.length / 4);
        } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          sendHeaders();
          const blockIdx = (textOpen ? 1 : 0) + toolEntries.length;
          toolEntries.push({ item_id: ev.item.id, blockIdx, name: ev.item.name || "" });
          sendSSE("content_block_start", {
            type: "content_block_start", index: blockIdx,
            content_block: { type: "tool_use", id: ev.item.call_id || ev.item.id, name: ev.item.name || "" },
          });
        } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
          sendHeaders();
          let entry = toolEntries.find((e) => e.item_id === ev.item_id);
          if (!entry) {
            const blockIdx = (textOpen ? 1 : 0) + toolEntries.length;
            entry = { item_id: ev.item_id, blockIdx, name: "" };
            toolEntries.push(entry);
            sendSSE("content_block_start", {
              type: "content_block_start", index: blockIdx,
              content_block: { type: "tool_use", id: ev.item_id, name: "" },
            });
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: entry.blockIdx,
            delta: { type: "input_json_delta", partial_json: ev.delta },
          });
          outputTokens += Math.ceil(ev.delta.length / 4);
        } else if (ev.type === "response.completed") {
          sendHeaders();
          let stopReason = "end_turn";
          for (const item of ev.response?.output || []) {
            if (item.type === "function_call") { stopReason = "tool_use"; break; }
          }
          closeBlocksAndStop(stopReason);
        } else if (ev.type === "response.failed" || ev.type === "response.incomplete") {
          sendHeaders();
          closeBlocksAndStop("end_turn");
        }
      }
    });

    zenRes.on("end", () => {
      if (finished) return;
      if (!headersSent) {
        finished = true;
        if (!res.headersSent && !res.writableEnded) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "anthropic");
          res.status(mapped.status).json(mapped.body);
        } else if (!res.writableEnded) {
          try {
            res.end();
          } catch {}
        }
        return;
      }
      closeBlocksAndStop(toolEntries.length ? "tool_use" : "end_turn");
    });

    zenRes.on("error", (e) => {
      if (finished) return;
      try {
        req.destroy();
      } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
        res.status(mapped.status).json(mapped.body);
      } else if (!finished) {
        try {
          sendHeaders();
          closeBlocksAndStop("end_turn");
        } catch {}
      }
    });
  });

  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      try {
        sendHeaders();
        closeBlocksAndStop("end_turn");
      } catch {}
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      try {
        sendHeaders();
        closeBlocksAndStop("end_turn");
      } catch {}
    }
  });

  res.on("close", () => {
    if (!finished) {
      finished = true;
      try {
        req.destroy();
      } catch {}
    }
  });

  req.write(body);
  req.end();
}

function pipeZenResponsesPassthrough(zenOpts, body, requestedModel, res, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const respId = ocId("resp");
  let headersSent = false;
  let buffer = "";
  let firstChunkHandled = false;
  let finished = false;
  const toolMap = new Map();

  function sendHeaders() {
    if (headersSent || finished) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: respId, model: requestedModel, status: "in_progress" } })}\n\n`);
  }

  function finish(completed) {
    if (finished) return;
    finished = true;
    sendHeaders();
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
    res.end();
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      buffer += chunk.toString();
      if (!firstChunkHandled) {
        const det = detectUpstreamError(buffer);
        if (det.needMore) return;
        firstChunkHandled = true;
        if (!det.isStream && det.parsed) {
          const mapped = mapZenError(responsesErrorStatus(det.parsed, zenRes.statusCode), det.parsed, "openai");
          const out = { error: mapped.body?.error || mapped.body };
          if (isRetryableUpstreamStatus(mapped.status) && tryStreamFallback(extra, res, (nxt, ex) => pipeZenResponsesPassthrough(nxt.options, nxt.body, nxt.model, res, ex), { fallbackDelayMs: FALLBACK_DELAY_MS })) {
            finished = true;
            try { zenRes.resume(); } catch {}
            try { req.destroy(); } catch {}
            return;
          }
          finished = true;
          try { zenRes.resume(); } catch {}
          try { req.destroy(); } catch {}
          if (!res.headersSent && !res.writableEnded) res.status(mapped.status).json(out);
          else if (!res.writableEnded) { try { res.end(); } catch {} }
          return;
        }
      }
      sendHeaders();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          if (FINGERPRINT_TOOLS.includes(ev.item.name)) {
            toolMap.set(ev.item.id, { skipped: true });
            continue;
          }
          toolMap.set(ev.item.id, { skipped: false });
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } else if (ev.type === "response.function_call_arguments.delta") {
          const entry = toolMap.get(ev.item_id);
          if (entry?.skipped) continue;
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
          if (FINGERPRINT_TOOLS.includes(ev.item.name)) continue;
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      }
      if (res.flush) res.flush();
    });
    zenRes.on("end", () => {
      if (finished) return;
      if (!headersSent) {
        finished = true;
        if (!res.headersSent && !res.writableEnded) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "openai");
          res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
        } else if (!res.writableEnded) { try { res.end(); } catch {} }
        return;
      }
      if (!finished && !res.writableEnded) { finished = true; try { res.end(); } catch {} }
    });
    zenRes.on("error", (e) => {
      if (finished) return;
      try { req.destroy(); } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
      } else if (!finished && !res.writableEnded) { finished = true; try { res.end(); } catch {} }
    });
  });
  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    } else if (!finished) { finished = true; try { res.end(); } catch {} }
  });
  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    } else if (!finished) { finished = true; try { res.end(); } catch {} }
  });
  res.on("close", () => {
    if (!finished) { finished = true; try { req.destroy(); } catch {} }
  });
  req.write(body);
  req.end();
}

function pipeChatAsResponses(zenOpts, body, requestedModel, res, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const respId = ocId("resp");
  const created = Math.floor(Date.now() / 1000);
  let headersSent = false;
  let buffer = "";
  let firstChunkHandled = false;
  let finished = false;
  let textItemId = null;
  const toolMap = new Map();
  let usage = null;

  function sendHeaders() {
    if (headersSent || finished) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: respId, object: "response", created_at: created, model: requestedModel, status: "in_progress" } })}\n\n`);
  }

  function finish(status = "completed") {
    if (finished) return;
    finished = true;
    sendHeaders();
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: respId, model: requestedModel, status, usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : undefined } })}\n\n`);
    res.end();
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      buffer += chunk.toString();
      if (!firstChunkHandled) {
        const det = detectUpstreamError(buffer);
        if (det.needMore) return;
        firstChunkHandled = true;
        if (!det.isStream && det.parsed) {
          const mapped = mapZenError(zenRes.statusCode === 200 ? 429 : zenRes.statusCode, det.parsed, "openai");
          if (isRetryableUpstreamStatus(mapped.status) && tryStreamFallback(extra, res, (nxt, ex) => pipeChatAsResponses(nxt.options, nxt.body, nxt.model, res, ex), { fallbackDelayMs: FALLBACK_DELAY_MS })) {
            finished = true;
            try { zenRes.resume(); } catch {}
            try { req.destroy(); } catch {}
            return;
          }
          finished = true;
          try { zenRes.resume(); } catch {}
          try { req.destroy(); } catch {}
          if (!res.headersSent && !res.writableEnded) res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
          else if (!res.writableEnded) { try { res.end(); } catch {} }
          return;
        }
      }
      sendHeaders();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        if (parsed.usage && typeof parsed.usage === "object") usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) {
          if (parsed.choices?.[0]?.finish_reason) finish("completed");
          continue;
        }
        if (typeof delta.content === "string" && delta.content) {
          if (!textItemId) {
            textItemId = ocId("msg");
            res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: textItemId, role: "assistant", content: [] } })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: textItemId, output_index: 0, delta: delta.content })}\n\n`);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (FINGERPRINT_TOOLS.includes(tc.function?.name)) {
              if (tc.index != null) toolMap.set(tc.index, { skipped: true });
              continue;
            }
            const idx = tc.index ?? 0;
            if (!toolMap.has(idx)) {
              const itemId = ocId("fc");
              toolMap.set(idx, { skipped: false, itemId, callId: tc.id || itemId, name: tc.function?.name || "" });
              res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: toolMap.size, item: { type: "function_call", id: itemId, call_id: tc.id || itemId, name: tc.function?.name || "" } })}\n\n`);
            }
            const entry = toolMap.get(idx);
            if (entry?.skipped) continue;
            if (tc.function?.arguments) {
              res.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: entry.itemId, output_index: idx + 1, delta: tc.function.arguments })}\n\n`);
            }
          }
        }
        if (parsed.choices?.[0]?.finish_reason) finish("completed");
      }
      if (res.flush) res.flush();
    });
    zenRes.on("end", () => {
      if (finished) return;
      if (!headersSent) {
        finished = true;
        if (!res.headersSent && !res.writableEnded) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "openai");
          res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
        } else if (!res.writableEnded) { try { res.end(); } catch {} }
        return;
      }
      finish("completed");
    });
    zenRes.on("error", (e) => {
      if (finished) return;
      try { req.destroy(); } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
      } else if (!finished) { try { finish("completed"); } catch {} }
    });
  });
  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    } else if (!finished) { try { finish("completed"); } catch {} }
  });
  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    } else if (!finished) { try { finish("completed"); } catch {} }
  });
  res.on("close", () => {
    if (!finished) { finished = true; try { req.destroy(); } catch {} }
  });
  req.write(body);
  req.end();
}

function pipeZenResponse(zenOpts, body, stream, res, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;
    let buffer = "";
    let finished = false;
    let firstChunkHandled = false;

    function sendHeaders() {
      if (headersSent || finished) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
      res.flushHeaders();
    }

    zenRes.on("data", (chunk) => {
      if (finished) return;
      const str = chunk.toString();
      buffer += str;
      if (!firstChunkHandled) {
        const det = detectUpstreamError(buffer);
        if (det.needMore) return;
        firstChunkHandled = true;
        firstChunk = Buffer.from(buffer);
        if (!det.isStream && det.parsed) {
          const fb = zenRes.statusCode === 200 ? 429 : zenRes.statusCode;
          const mapped = mapZenError(fb, det.parsed, "openai");
          if (isRetryableUpstreamStatus(mapped.status) && tryStreamFallback(extra, res, (nxt, ex) => pipeZenResponse(nxt.options, nxt.body, stream, res, ex), { fallbackDelayMs: FALLBACK_DELAY_MS })) {
            finished = true;
            try {
              zenRes.resume();
            } catch {}
            try {
              req.destroy();
            } catch {}
            return;
          }
          finished = true;
          try {
            zenRes.resume();
          } catch {}
          try {
            req.destroy();
          } catch {}
          if (!res.headersSent && !res.writableEnded) {
            res.status(mapped.status).json(mapped.body);
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {}
          }
          return;
        }
      } else if (!firstChunk) {
        firstChunk = chunk;
      }

      sendHeaders();
      if (finished || res.writableEnded) return;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (finished || res.writableEnded) break;
        if (!line.startsWith("data: ")) {
          res.write(line + "\n");
          continue;
        }
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") {
          res.write(line + "\n\n");
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.tool_calls) {
            delta.tool_calls = delta.tool_calls.filter(
              (tc) => !FINGERPRINT_TOOLS.includes(tc.function?.name)
            );
            if (delta.tool_calls.length === 0 && !delta.content && !delta.reasoning_content && !delta.role) {
              continue;
            }
          }
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        } catch {
          res.write(line + "\n");
        }
      }
      if (res.flush) res.flush();
    });

    zenRes.on("end", () => {
      if (finished) return;
      if (!headersSent && !firstChunk) {
        finished = true;
        if (!res.headersSent && !res.writableEnded) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "openai");
          res.status(mapped.status).json(mapped.body);
        } else if (!res.writableEnded) {
          try {
            res.end();
          } catch {}
        }
        return;
      }
      if (headersSent && !finished && !res.writableEnded) {
        finished = true;
        res.end();
      }
    });

    zenRes.on("error", (e) => {
      if (finished) return;
      try {
        req.destroy();
      } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        res.status(mapped.status).json(mapped.body);
      } else if (!finished && !res.writableEnded) {
        finished = true;
        try {
          res.end();
        } catch {}
      }
    });
  });

  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      res.status(mapped.status).json(mapped.body);
    } else if (!finished && res.writableEnded === false) {
      finished = true;
      try {
        res.end();
      } catch {}
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      finished = true;
      try {
        res.end();
      } catch {}
    }
  });

  res.on("close", () => {
    if (!finished) {
      finished = true;
      try {
        req.destroy();
      } catch {}
    }
  });

  req.write(body);
  req.end();
}

function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const msgId = ocId("msg");

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;
    let finished = false;
    let stopSent = false;

    function sendSSE(event, data) {
      if (finished || stopSent || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    }

    function sendStopOnce(stopReason) {
      if (stopSent || res.writableEnded) return;
      stopSent = true;
      try {
        const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
        for (let i = 0; i < totalBlocks; i++) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        }
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        if (res.flush) res.flush();
      } catch {}
    }

    function endAnthropicStream(stopReason) {
      if (finished) return;
      sendStopOnce(stopReason);
      finished = true;
      try {
        if (!res.writableEnded) res.end();
      } catch {}
    }

    function sendHeaders() {
      if (headersSent || finished) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model, stop_reason: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }

    zenRes.on("data", (chunk) => {
      if (finished) return;
      const str = chunk.toString();
      buffer += str;
      if (!firstChunkHandled) {
        const det = detectUpstreamError(buffer);
        if (det.needMore) return;
        firstChunkHandled = true;
        if (!det.isStream && det.parsed) {
          const fb = zenRes.statusCode === 200 ? 429 : zenRes.statusCode;
          const mapped = mapZenError(fb, det.parsed, "anthropic");
          if (isRetryableUpstreamStatus(mapped.status) && tryStreamFallback(extra, res, (nxt, ex) => pipeZenAsAnthropic(nxt.options, nxt.body, nxt.model, res, inputTokens, ex), { fallbackDelayMs: FALLBACK_DELAY_MS })) {
            finished = true;
            try {
              zenRes.resume();
            } catch {}
            try {
              req.destroy();
            } catch {}
            return;
          }
          finished = true;
          try {
            zenRes.resume();
          } catch {}
          try {
            req.destroy();
          } catch {}
          if (!res.headersSent && !res.writableEnded) {
            res.status(mapped.status).json(mapped.body);
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {}
          }
          return;
        }
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        sendHeaders();

        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        if (delta.reasoning_content) {
          outputTokens += Math.ceil(delta.reasoning_content.length / 4);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (FINGERPRINT_TOOLS.includes(tc.function?.name)) continue;
            const idx = tc.index ?? 0;
            if (idx > toolIdx) {
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
              }
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", {
                type: "content_block_start", index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "" },
              });
            }
            if (tc.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
              outputTokens += Math.ceil(tc.function.arguments.length / 4);
            }
          }
        }

        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";
          sendStopOnce(stopReason);
        }
      }
    });

    zenRes.on("end", () => {
      if (finished) return;
      if (!headersSent) {
        finished = true;
        if (!res.headersSent && !res.writableEnded) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "anthropic");
          res.status(mapped.status).json(mapped.body);
        } else if (!res.writableEnded) {
          try {
            res.end();
          } catch {}
        }
        return;
      }
      if (!stopSent) sendStopOnce(toolIdx >= 0 ? "tool_use" : "end_turn");
      if (!finished && !res.writableEnded) {
        finished = true;
        try {
          res.end();
        } catch {}
      }
    });

    zenRes.on("error", (e) => {
      if (finished) return;
      try {
        req.destroy();
      } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
        res.status(mapped.status).json(mapped.body);
      } else if (!finished) {
        endAnthropicStream("end_turn");
      }
    });
  });

  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    try {
      req.destroy();
    } catch {}
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      endAnthropicStream("end_turn");
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      endAnthropicStream("end_turn");
    }
  });

  res.on("close", () => {
    if (!finished) {
      finished = true;
      try {
        req.destroy();
      } catch {}
    }
  });

  req.write(body);
  req.end();
}

app.get("/v1/models", async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "openai");
    return res.status(mapped.status).json(mapped.body);
  }

  await maybeRefreshModels();

  res.setHeader("x-zen-served-by", "ocodeproxy");
  res.json({
    object: "list",
    data: ALL_MODELS.map((id) => ({
      id,
      object: "model",
      created: 1779000000,
      owned_by: "opencode-free",
    })),
  });
});

app.get("/v1/models/:id", async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "openai");
    return res.status(mapped.status).json(mapped.body);
  }

  const rawId = req.params.id;
  if (typeof rawId !== "string" || !rawId.trim()) {
    return res.status(404).json({
      error: { message: "Model not found", type: "not_found_error", code: "model_not_found" },
    });
  }
  const id = resolveModel(rawId.trim());

  if (isDeprecatedModel(id)) {
    return res.status(404).json({
      error: { message: `Model '${id}' is discontinued and no longer supported.`, type: "not_found_error", code: "model_deprecated" },
    });
  }

  if (!isKnownModel(id)) {
    await maybeRefreshModels();
  }

  if (!isKnownModel(id)) {
    return res.status(404).json({
      error: { message: `Model '${id}' not found.`, type: "not_found_error", code: "model_not_found" },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  res.json({
    id,
    object: "model",
    created: 1779000000,
    owned_by: "opencode-free",
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "openai");
    return res.status(mapped.status).json(mapped.body);
  }

  const reqBody = req.body && typeof req.body === "object" ? req.body : {};
  const { model, messages, stream, tools, tool_choice } = reqBody;
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({
      error: { message: "Missing required field: model (string)", type: "invalid_request_error", code: "missing_model" },
    });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: "Missing required field: messages (array)", type: "invalid_request_error", code: "missing_messages" },
    });
  }

  const targetModel = resolveModel(model.trim());

  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({
      error: { message: `Model '${targetModel}' is discontinued and no longer supported.`, type: "invalid_request_error", code: "model_deprecated" },
    });
  }

  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
  }

  if (!isKnownModel(targetModel)) {
    return res.status(404).json({
      error: { message: `Model '${targetModel}' not found.`, type: "not_found_error", code: "model_not_found" },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  const sessionId = getSession(user);
  const zenKey = zenKeyFromReq(req);
  const models = candidateModels(targetModel);

  if (isResponsesModel(targetModel)) {
    const attempts = responsesAttempts(models, messages, tools, tool_choice, sessionId, reqBody, zenKey);
    if (stream) {
      const first = attempts[0];
      pipeZenResponses(first.options, first.body, first.model, res, fallbackExtra(attempts));
    } else {
      try {
        const zenResp = await collectAttempts(attempts);

        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
          return res.status(mapped.status).json(mapped.body);
        }
        res.json(aggregateResponsesSseToOpenAI(zenResp.raw, zenResp.model));
      } catch (e) {
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        res.status(mapped.status).json(mapped.body);
      }
    }
    return;
  }

  const chatAttemptsList = chatAttempts(models, messages, tools, tool_choice, sessionId, reqBody, zenKey);
  if (stream) {
    const first = chatAttemptsList[0];
    pipeZenResponse(first.options, first.body, true, res, fallbackExtra(chatAttemptsList));
  } else {
    try {
      const zenResp = await collectAttempts(chatAttemptsList);

      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
        return res.status(mapped.status).json(mapped.body);
      }
      res.json(aggregateSseToCompletion(zenResp.raw, zenResp.model));
    } catch (e) {
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      res.status(mapped.status).json(mapped.body);
    }
  }
});

app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "anthropic");
    return res.status(mapped.status).json(mapped.body);
  }

  const reqBody = req.body && typeof req.body === "object" ? req.body : {};
  const { model, stream } = reqBody;
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "Missing required field: model (string)" },
    });
  }
  if (!Array.isArray(reqBody.messages)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "Missing required field: messages (array)" },
    });
  }

  const targetModel = resolveModel(model.trim());

  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Model '${targetModel}' is discontinued and no longer supported.` },
    });
  }

  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
  }

  if (!isKnownModel(targetModel)) {
    return res.status(404).json({
      type: "error",
      error: { type: "not_found_error", message: `Model '${targetModel}' not found.` },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  const sessionId = getSession(user);
  const { messages, tools, params } = anthropicToOpenAI(reqBody);
  const inputTokens = 0;
  const zenKey = zenKeyFromReq(req);
  const models = candidateModels(targetModel);

  if (isResponsesModel(targetModel)) {
    const attempts = responsesAttempts(models, messages, tools, undefined, sessionId, params, zenKey);
    if (stream) {
      const first = attempts[0];
      pipeZenResponsesAsAnthropic(first.options, first.body, first.model, res, inputTokens, fallbackExtra(attempts));
    } else {
      try {
        const zenResp = await collectAttempts(attempts);

        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "anthropic");
          return res.status(mapped.status).json(mapped.body);
        }
        res.json(openAIToAnthropic(aggregateResponsesSseToOpenAI(zenResp.raw, zenResp.model), zenResp.model, inputTokens));
      } catch (e) {
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
        res.status(mapped.status).json(mapped.body);
      }
    }
    return;
  }

  const chatAttemptsList = chatAttempts(models, messages, tools, undefined, sessionId, params, zenKey);
  if (stream) {
    const first = chatAttemptsList[0];
    pipeZenAsAnthropic(first.options, first.body, first.model, res, inputTokens, fallbackExtra(chatAttemptsList));
  } else {
    try {
      const zenResp = await collectAttempts(chatAttemptsList);

      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "anthropic");
        return res.status(mapped.status).json(mapped.body);
      }
      res.json(openAIToAnthropic(aggregateSseToCompletion(zenResp.raw, zenResp.model), zenResp.model, inputTokens));
    } catch (e) {
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    }
  }
});

app.post("/v1/responses", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "authentication_error", code: "invalid_api_key" } });
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { model, input, instructions, tools, tool_choice, stream } = body;
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({ error: { message: "Missing required field: model (string)", type: "invalid_request_error", code: "missing_model" } });
  }
  if (typeof input !== "string" && !Array.isArray(input)) {
    return res.status(400).json({ error: { message: "Missing required field: input (string or array)", type: "invalid_request_error", code: "missing_input" } });
  }
  const targetModel = resolveModel(model.trim());
  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({ error: { message: `Model '${targetModel}' is discontinued and no longer supported.`, type: "invalid_request_error", code: "model_deprecated" } });
  }
  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
  }
  if (!isKnownModel(targetModel)) {
    return res.status(404).json({ error: { message: `Model '${targetModel}' not found.`, type: "not_found_error", code: "model_not_found" } });
  }
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const sessionId = getSession(user);
  const zenKey = zenKeyFromReq(req);
  const models = candidateModels(targetModel);
  if (isResponsesModel(targetModel)) {
    const attempts = responsesDirectAttempts(models, input, instructions, tools, tool_choice, sessionId, body, zenKey);
    if (stream) {
      const first = attempts[0];
      pipeZenResponsesPassthrough(first.options, first.body, first.model, res, fallbackExtra(attempts));
    } else {
      try {
        const zenResp = await collectAttempts(attempts);
        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
          return res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
        }
        res.json(aggregateResponsesSseToResponses(zenResp.raw, zenResp.model));
      } catch (e) {
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
      }
    }
    return;
  }
  const messages = responsesInputToChatMessages(input, instructions);
  const normalizedTools = normalizeResponsesTools(tools).map((t) => ({ type: "function", function: t }));
  const chatParams = { ...body };
  if (chatParams.max_output_tokens !== undefined && chatParams.max_tokens === undefined && chatParams.max_completion_tokens === undefined) {
    chatParams.max_tokens = chatParams.max_output_tokens;
  }
  const chatAttemptsList = chatAttempts(models, messages, normalizedTools.length ? normalizedTools : undefined, tool_choice, sessionId, chatParams, zenKey);
  if (stream) {
    const first = chatAttemptsList[0];
    pipeChatAsResponses(first.options, first.body, first.model, res, fallbackExtra(chatAttemptsList));
  } else {
    try {
      const zenResp = await collectAttempts(chatAttemptsList);
      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
        return res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
      }
      res.json(chatCompletionToResponses(aggregateSseToCompletion(zenResp.raw, zenResp.model), zenResp.model));
    } catch (e) {
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    }
  }
});

app.post("/v1/messages/count_tokens", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }
  const reqBody = req.body && typeof req.body === "object" ? req.body : {};
  const { model } = reqBody;
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "Missing required field: model (string)" } });
  }
  const targetModel = resolveModel(model.trim());
  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: `Model '${targetModel}' is discontinued and no longer supported.` } });
  }
  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
  }
  if (!isKnownModel(targetModel)) {
    return res.status(404).json({ type: "error", error: { type: "not_found_error", message: `Model '${targetModel}' not found.` } });
  }
  res.setHeader("x-zen-served-by", "ocodeproxy");
  res.json({ input_tokens: estimateAnthropicTokens(reqBody) });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: TUI_VERSION,
    proxy_version: `v${PROXY_VERSION}`,
    port: currentPort,
    models: ALL_MODELS.length,
    ocVersion: ocVersion,
    zenAuthMode: ZEN_AUTH_MODE,
    upstreamProxyConfigured: Boolean(upstreamProxyUrl),
    endpoints: [
      "/health",
      "/v1/models",
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/messages",
      "/v1/messages/count_tokens",
    ],
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "OCodeProxy",
    status: "running",
    version: TUI_VERSION,
    port: currentPort,
    models: ALL_MODELS.length,
    endpoints: [
      "/health",
      "/v1/models",
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/messages",
      "/v1/messages/count_tokens",
    ],
  });
});

app.use((err, req, res, _next) => {
  if (res.headersSent || res.writableEnded) return;
  const isAnthropic = typeof req.path === "string" && req.path.startsWith("/v1/messages");
  if (err?.type === "entity.too.large") {
    if (isAnthropic) {
      return res.status(413).json({ type: "error", error: { type: "invalid_request_error", message: "Request body too large" } });
    }
    return res.status(413).json({ error: { message: "Request body too large", type: "invalid_request_error", code: "body_too_large" } });
  }
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    if (isAnthropic) {
      return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } });
    }
    return res.status(400).json({ error: { message: "Invalid JSON body", type: "invalid_request_error", code: "invalid_json" } });
  }
  if (isAnthropic) {
    return res.status(500).json({ type: "error", error: { type: "api_error", message: "Internal server error" } });
  }
  res.status(500).json({ error: { message: "Internal server error", type: "api_error", code: "internal_server_error" } });
});

function renderBanner(port) {
  if (!process.stdout.isTTY) {
    console.error(`OCodeProxy listening on http://0.0.0.0:${port}`);
    return;
  }
  const localUrl = `http://localhost:${port}`;
  const networkUrl = `http://0.0.0.0:${port}`;

  const content = [
    `${pc.bold(pc.magenta("⚡ OCodeProxy"))} ${pc.dim(TUI_VERSION)}`,
    "",
    `${pc.bold("Status:")}    ${pc.green("● ONLINE")}`,
    `${pc.bold("Models:")}    ${pc.cyan(String(ALL_MODELS.length))} ${pc.dim("upstream models")}`,
    `${pc.bold("Local:")}     ${pc.cyan(localUrl)}`,
    `${pc.bold("Network:")}   ${pc.dim(networkUrl)}`,
    ...(upstreamProxyUrl ? [`${pc.bold("Proxy:")}     ${pc.yellow(upstreamProxyUrl)}`] : []),
    "",
    `${pc.bold("Endpoints:")}`,
    `  ${pc.green("GET")}   /health               ${pc.dim("→ Health & status check")}`,
    `  ${pc.green("GET")}   /v1/models            ${pc.dim("→ List models")}`,
    `  ${pc.cyan("POST")}  /v1/chat/completions  ${pc.dim("→ OpenAI chat format")}`,
    `  ${pc.cyan("POST")}  /v1/responses         ${pc.dim("→ OpenAI responses format")}`,
    `  ${pc.cyan("POST")}  /v1/messages          ${pc.dim("→ Anthropic messages format")}`,
    ...(process.stdin.isTTY
      ? [
          "",
          `${pc.bold("Controls:")}`,
          `  ${pc.yellow("[s]")} ⚙️  Settings`,
          `  ${pc.gray("[q]")} 🚪 Stop server`,
        ]
      : []),
  ].join("\n");

  console.log(
    boxen(content, {
      padding: 1,
      margin: 1,
      borderStyle: "round",
      borderColor: "cyan",
    })
  );
}

function startServer(port, opts = {}) {
  const { fatal = true } = opts;
  let settled = false;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const srv = app.listen(port, "0.0.0.0", () => {
    settled = true;
    renderBanner(port);
    readyResolve(true);
  });

  srv.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(pc.red(`\n✖ Error: port ${port} is already in use.\n`));
      if (!settled) {
        settled = true;
        readyResolve(false);
      }
      if (fatal) {
        pauseKeybindings();
        process.exit(1);
      }
    } else {
      console.error(pc.red(`Failed to bind port ${port}: ${err?.message || err}`));
      if (!settled) {
        settled = true;
        readyResolve(false);
      }
    }
  });

  srv.ready = ready;
  return srv;
}

function closeServer(srv, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!srv) return resolve();
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    srv.close(finish);
    setTimeout(() => {
      try {
        srv.closeAllConnections?.();
      } catch {}
      finish();
    }, timeoutMs);
    srv.once?.("close", finish);
  });
}

let isKeyListening = false;

function setupKeybindings() {
  if (!process.stdin.isTTY || isKeyListening) return;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("keypress", onKeypress);
  isKeyListening = true;
}

function pauseKeybindings() {
  if (!isKeyListening) return;

  process.stdin.removeListener("keypress", onKeypress);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  isKeyListening = false;
}

async function hotSwap() {
  if (!process.stdin.isTTY) {
    p.log.error("Port hot-swap requires an interactive terminal.");
    return;
  }
  p.intro(pc.bgCyan(pc.black(" ⚙️ OCodeProxy Port Hot-Swap ")));
  const newPort = await promptPortSelection(currentPort);

  if (!newPort || newPort === currentPort) {
    if (newPort === currentPort) {
      p.log.warn(`Server is already running on port ${currentPort}.`);
    } else {
      p.log.info("Port change cancelled.");
    }
    return;
  }

  const available = await isPortAvailable(newPort);
  if (!available) {
    p.log.error(pc.red(`Port ${newPort} is in use by another process. Switch cancelled.`));
    return;
  }

  const s = p.spinner();
  s.start(`Starting server on port ${newPort}...`);

  const next = startServer(newPort, { fatal: false });
  const started = await next.ready;
  if (!started) {
    s.stop(pc.red(`✖ Could not bind port ${newPort}, staying on port ${currentPort}.`));
    try {
      await closeServer(next, 5000);
    } catch {}
    return;
  }

  s.message(`Stopping server on port ${currentPort}...`);
  const old = currentServer;
  currentPort = newPort;
  currentServer = next;
  await closeServer(old, 5000);

  s.stop(pc.green(`✔ Server switched to port ${newPort}!`));
}

async function openSettings() {
  if (!process.stdin.isTTY) {
    console.error("Settings require an interactive terminal.");
    return;
  }
  pauseKeybindings();
  try {
    await openSettingsMenu();
  } catch (err) {
    console.error(pc.red(`Settings error: ${err?.message || err}`));
  } finally {
    if (process.stdout.isTTY) {
      console.clear();
      renderBanner(currentPort);
    }
    setupKeybindings();
  }
}

async function openSettingsMenu() {
  p.intro(pc.bgCyan(pc.black(" ⚙️ OCodeProxy Settings ")));

  let inSettings = true;
  while (inSettings) {
    const action = await p.select({
      message: "Settings menu:",
      options: [
        { value: "port", label: "Change / Hot-swap port", hint: `current: ${currentPort}` },
        { value: "proxy", label: "Configure Outbound Proxy (SOCKS5 / HTTP)", hint: upstreamProxyUrl ? upstreamProxyUrl : "direct connection" },
        { value: "update_ua", label: "Check & update OpenCode UA version", hint: `current: ${ocVersion}` },
        { value: "refresh_models", label: "Refresh models from upstream", hint: `${ALL_MODELS.length} discovered` },
        { value: "list_models", label: "View available models", hint: `${ALL_MODELS.length} models` },
        { value: "new_key", label: "Generate new API key", hint: "create key with custom name" },
        { value: "regenerate_keys", label: "Regenerate default keys", hint: "reset admin & user-default" },
        { value: "list_keys", label: "View active API keys", hint: `source: ${KEYS_FILE}` },
        { value: "back", label: "Back to server", hint: "resume proxy" },
      ],
    });

    if (p.isCancel(action) || action === "back") {
      inSettings = false;
      break;
    }

    if (action === "port") {
      await hotSwap();
      inSettings = false;
      break;
    } else if (action === "proxy") {
      p.log.info(pc.cyan(`Current outbound proxy: ${upstreamProxyUrl ? pc.bold(upstreamProxyUrl) : pc.dim("none (direct connection)")}`));
      const proxyChoice = await p.select({
        message: "Proxy configuration:",
        options: [
          { value: "set", label: "Set / Update proxy URL", hint: "e.g. socks5://127.0.0.1:1080 or http://127.0.0.1:8080" },
          { value: "clear", label: "Disable proxy (use direct connection)" },
          { value: "cancel", label: "Back to settings menu" },
        ],
      });

      if (!p.isCancel(proxyChoice)) {
        if (proxyChoice === "set") {
          const inputUrl = await p.text({
            message: "Enter Proxy URL (supports socks5://, socks4://, http://, https://):",
            placeholder: "socks5://127.0.0.1:1080",
            initialValue: upstreamProxyUrl,
            validate(val) {
              if (!val || !val.trim()) return "Proxy URL cannot be empty";
            },
          });

          if (!p.isCancel(inputUrl) && inputUrl.trim()) {
            setupProxyAgent(inputUrl.trim());
            saveProxyConfig();
            p.log.success(pc.green(`✔ Outbound proxy configured: ${pc.bold(upstreamProxyUrl)}`));
          }
        } else if (proxyChoice === "clear") {
          setupProxyAgent("");
          saveProxyConfig();
          p.log.success(pc.green("✔ Outbound proxy disabled. Using direct connection."));
        }
      }
    } else if (action === "update_ua") {
      const s = p.spinner();
      s.start(`Checking latest OpenCode release (current: ${ocVersion})...`);
      const res = await updateOcVersion(true);
      if (res.updated) {
        s.stop(pc.green(`✔ OpenCode UA version updated: ${res.prev} → ${pc.bold(res.version)}!`));
      } else if (!res.latest) {
        s.stop(pc.yellow(`⚠ Could not fetch latest release. Kept current version (${ocVersion}).`));
      } else if (res.latest === ocVersion) {
        s.stop(pc.cyan(`ℹ OpenCode UA version is already up to date (${pc.bold(ocVersion)}).`));
      } else {
        s.stop(pc.yellow(`⚠ Could not fetch latest release. Kept current version (${ocVersion}).`));
      }
    } else if (action === "refresh_models") {
      const s = p.spinner();
      s.start("Discovering models from upstream Zen API...");
      const ok = await refreshModels(true);
      if (ok) {
        s.stop(pc.green(`✔ Discovered ${ALL_MODELS.length} models from upstream!`));
      } else {
        s.stop(pc.yellow(`⚠ Upstream discovery failed, keeping ${ALL_MODELS.length} current models.`));
      }
    } else if (action === "list_models") {
      p.log.info(pc.cyan(`Discovered Models (${ALL_MODELS.length}):`));
      for (const m of ALL_MODELS) {
        const type = isResponsesModel(m) ? pc.magenta("responses") : pc.green("chat");
        p.log.message(`  ${pc.bold(m.padEnd(35))} ${pc.dim(`[${type}]`)}`);
      }
    } else if (action === "new_key") {
      const keyName = await p.text({
        message: "Enter name for new API key:",
        placeholder: "user-custom",
        validate(val) {
          if (!val || !val.trim()) return "Key name cannot be empty";
          if (apiKeys[val.trim()]) return "A key with this name already exists";
        },
      });

      if (!p.isCancel(keyName)) {
        const name = keyName.trim();
        const newKey = generateKeyString();
        apiKeys[name] = newKey;
        saveKeys();
        p.log.success(pc.green(`✔ Created key for "${name}": ${pc.bold(newKey)}`));
      }
    } else if (action === "regenerate_keys") {
      const confirm = await p.confirm({
        message: "Regenerate default keys? Only admin & user-default are reset, custom keys are kept.",
        initialValue: false,
      });

      if (!p.isCancel(confirm) && confirm) {
        apiKeys = {
          ...apiKeys,
          admin: generateKeyString(),
          "user-default": generateKeyString(),
        };
        saveKeys();
        p.log.success(pc.green("✔ Default keys regenerated successfully:"));
        for (const [name, key] of Object.entries(apiKeys)) {
          p.log.message(`  ${pc.bold(name.padEnd(14))} ${pc.dim(maskKey(key))}`);
        }
      }
    } else if (action === "list_keys") {
      p.log.info(pc.cyan(`Active API keys (${KEYS_FILE}):`));
      for (const [name, key] of Object.entries(apiKeys)) {
        p.log.message(`  ${pc.bold(name.padEnd(14))} ${pc.dim(maskKey(key))}`);
      }
    }
  }

}

let settingsOpen = false;

async function onKeypress(str, key) {
  if (!key || settingsOpen) return;

  if ((key.ctrl && key.name === "c") || key.name === "q") {
    gracefulShutdown("keypress");
  } else if (key.name === "s" || key.name === "p") {
    settingsOpen = true;
    try {
      await openSettings();
    } catch (err) {
      console.error(pc.red(`Settings error: ${err?.message || err}`));
    } finally {
      settingsOpen = false;
    }
  }
}

let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  pauseKeybindings();
  console.log(pc.dim(`\nReceived ${signal}, stopping server...`));
  if (currentServer) {
    currentServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error(pc.red(`Uncaught exception: ${err?.stack || err?.message || err}`));
  gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error(pc.red(`Unhandled rejection: ${reason?.stack || reason?.message || reason}`));
  gracefulShutdown("unhandledRejection");
});

currentServer = startServer(currentPort);
setupKeybindings();

updateOcVersion(true).catch(() => {});
refreshModels(true).catch(() => {});
const ocVersionTimer = setInterval(checkPeriodicOcVersion, 60 * 60 * 1000);
if (typeof ocVersionTimer.unref === "function") ocVersionTimer.unref();
