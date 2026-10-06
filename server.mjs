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
  responsesInputToChatMessages,
  chatCompletionToResponses,
  normalizeResponsesTools,
  estimateAnthropicTokens,
  pickChatParams,
  pickResponsesParams,
  chatParamsToResponsesParams,
  anthropicToOpenAI,
  openAIToAnthropic,
  validateAnthropicMessagesBody,
  createAnthropicBlockTracker,
  createChatToolTracker,
  responsesToolCallKey,
  responsesToolCallKeys,
} from "./lib/convert.mjs";
import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_RESPONSES_MODELS,
  DEFAULT_MAX_CONSECUTIVE_SHRINKS,
  DEFAULT_SHRINK_TTL_MS,
  MODEL_ALIASES,
  DISCONTINUED_MODELS,
  CLAUDE_DISCOVERY_ALIASES,
  resolveGatewayModel,
  buildDiscoveryList,
  isModelDeprecated,
  isModelKnown,
  isModelResponses,
  partitionDiscovered,
  shouldKeepCurrent,
  getFallbackModels,
  candidateModels,
  suggestModelId,
} from "./lib/models.mjs";
import {
  MODELS_DEV_DEFAULT_URL,
  MODELS_DEV_DEFAULT_TTL_MS,
  MODELS_DEV_DEFAULT_FILE,
  parseModelsDevCatalog,
  serializeMetaMap,
  deserializeMetaMap,
  metaForId,
} from "./lib/catalog.mjs";
import {
  responsesErrorStatus,
  mapZenError,
  publicNetworkMessage,
  detectUpstreamError,
  isRetryableUpstreamStatus,
  gatewayRetryHeaders,
  asyncHandler,
} from "./lib/errors.mjs";
import { collectWithFallback, tryStreamFallback, abortClientStream, lazyAttempt } from "./lib/fallback.mjs";
import {
  DEFAULT_BUFFERED_SSE_MAX_BYTES,
  DEFAULT_AUX_FETCH_MAX_BYTES,
  resolveBufferedSseMaxBytes,
  resolveAuxFetchMaxBytes,
  createBufferedSseCollector,
  createBufferedJsonCollector,
  collectBoundedResponse,
  BufferLimitError,
} from "./lib/buffered.mjs";
import {
  createSseLineSplitter,
  safeWrite,
  safeFlush,
  safeEnd,
  isStreamClosed,
} from "./lib/sse.mjs";
import { repairChatMessages, repairResponsesInput } from "./lib/repair.mjs";
import { createSessionStore, DEFAULT_SESSION_SWEEP_INTERVAL_MS } from "./lib/session.mjs";

const app = express();
app.use(express.json({ limit: "10mb" }));

process.title = "OCodeProxy";
if (process.stdout.isTTY) {
  process.stdout.write("\x1b]0;OCodeProxy\x07");
}

const TUI_VERSION = "v0.1.2";
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
const MODELS_DEV_URL = process.env.MODELS_DEV_URL || MODELS_DEV_DEFAULT_URL;
const MODELS_DEV_FILE = process.env.MODELS_DEV_FILE || MODELS_DEV_DEFAULT_FILE;
const MODELS_DEV_TTL_MS = parsePositiveIntEnv("MODELS_DEV_TTL_MS", MODELS_DEV_DEFAULT_TTL_MS, 60 * 1000, 30 * 24 * 60 * 60 * 1000);
const PROXY_CONFIG_FILE = process.env.PROXY_CONFIG_FILE || "./proxy-config.json";
let zenDietMode = (process.env.ZEN_DIET || "balanced").toLowerCase();
if (!["balanced", "safe", "aggressive", "off"].includes(zenDietMode)) {
  zenDietMode = "balanced";
}
// Experimental: shorten long tool descriptions to their first sentence.
// May degrade tool selection; off by default, toggle live in Settings.
let zenToolSlim = ["1", "true", "yes", "on"].includes(String(process.env.ZEN_TOOL_SLIM ?? "").toLowerCase().trim());

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

const AUX_FETCH_MAX_BYTES = resolveAuxFetchMaxBytes(process.env.AUX_FETCH_MAX_BYTES ?? DEFAULT_AUX_FETCH_MAX_BYTES);

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

    const req = https.request(options, async (res) => {
      try {
        const { ok, text } = await collectBoundedResponse(res, req, AUX_FETCH_MAX_BYTES);
        if (!ok || res.statusCode !== 200) return resolve(null);
        const pkg = JSON.parse(text);
        if (typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version)) {
          return resolve(pkg.version);
        }
        resolve(null);
      } catch {
        resolve(null);
      }
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

// Diet status color: red flags aggressive mode and description slimming
// (both can degrade agent behavior), green otherwise.
function dietStatusColor() {
  return zenDietMode === "aggressive" || zenToolSlim ? pc.red : pc.green;
}

// Per-request diet summary for the access log. Shows estimated savings and
// the tool-results share of context, so small savings are explainable.
function formatDietSuffix(info) {
  if (!info || !Number.isFinite(info.totalTokens) || info.totalTokens <= 0) return "";
  const saved = Math.max(0, Math.round(info.savedTokens || 0));
  const fmt = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : `${saved}`;
  return ` diet -${fmt} (tools ${info.toolShare || 0}%)`;
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const time = new Date().toLocaleTimeString();
    const dietSuffix = formatDietSuffix(req.dietInfo);
    if (!process.stdout.isTTY) {
      console.error(`[${time}] ${req.method.padEnd(6)} ${req.originalUrl.padEnd(24)} ${res.statusCode} ${duration}ms${dietSuffix}`);
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
      `${pc.dim(`${duration}ms`)}` +
      (dietSuffix ? pc.dim(dietSuffix) : "")
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
  // Claude Code >=2.1.248 sends both credential headers; try every value.
  const candidates = [];
  for (const raw of [req.headers.authorization, req.headers["x-api-key"]]) {
    if (Array.isArray(raw)) {
      for (const v of raw) if (typeof v === "string" && v) candidates.push(v);
    } else if (typeof raw === "string" && raw) {
      candidates.push(raw);
    }
  }
  for (const hdr of candidates) {
    const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
    if (!tok) continue;
    const tokBuf = Buffer.from(tok);
    for (const [name, key] of Object.entries(apiKeys)) {
      if (typeof key !== "string" || !key) continue;
      const keyBuf = Buffer.from(key);
      if (tokBuf.length === keyBuf.length && crypto.timingSafeEqual(tokBuf, keyBuf)) return name;
    }
  }
  return null;
}

// Bounded session ids per authenticated user (Map + LRU cap + sweep,
// so unique-key spam cannot grow memory without bound).
const sessionStore = createSessionStore();
function getSession(user) {
  return sessionStore.get(user);
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
const BUFFERED_SSE_MAX_BYTES = resolveBufferedSseMaxBytes(process.env.BUFFERED_SSE_MAX_BYTES ?? DEFAULT_BUFFERED_SSE_MAX_BYTES);

// Copy Claude Code retry/ratelimit headers from the upstream onto the client
// response (retry-after, x-should-retry, anthropic-ratelimit-unified-*).
function applyGatewayHeaders(res, upstreamHeaders, status) {
  try {
    if (res.headersSent || res.writableEnded) return;
    const headers = gatewayRetryHeaders(upstreamHeaders, status);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  } catch {}
}

// Map an upstream failure to the client protocol and send it with gateway
// headers so Claude Code retries and usage-limit display keep working.
function sendUpstreamError(res, status, errData, format, upstreamHeaders) {
  const mapped = mapZenError(status, errData, format);
  applyGatewayHeaders(res, upstreamHeaders, mapped.status);
  return res.status(mapped.status).json(mapped.body);
}

// Forward SSE keep-alives (comments and ping events) to the client so idle
// watchdogs don't abort long thinking pauses. Call only after headersSent:
// callers drop pre-stream keep-alives. Returns true when the line was one.
function forwardKeepAlive(res, line, anthropicStyle) {
  if (!line || line[0] === ":") {
    safeWrite(res, (line || "") + "\n");
    safeFlush(res);
    return true;
  }
  if (line === "event: ping") {
    if (anthropicStyle) safeWrite(res, `event: ping\ndata: {"type":"ping"}\n\n`);
    else safeWrite(res, `: ping\n\n`);
    safeFlush(res);
    return true;
  }
  return false;
}

function candidateModelsForRequest(targetModel) {
  return candidateModels(targetModel, CHAT_MODELS, RESPONSES_MODELS, FALLBACK_ATTEMPTS);
}

function fallbackExtra(attempts, inTokens = 0) {
  return {
    attempts,
    inTokens,
    attemptIndex: 0,
    fallbackDelayMs: FALLBACK_DELAY_MS,
    onDone: (outTokens) => recordStreamResult(inTokens, outTokens),
  };
}

function chatAttempts(models, messages, tools, tool_choice, sessionId, params, zenKey) {
  return models.map((m) => lazyAttempt(m, () => zenRequest(m, messages, true, tools, tool_choice, sessionId, params, zenKey)));
}

function responsesAttempts(models, messages, tools, tool_choice, sessionId, params, zenKey) {
  return models.map((m) => lazyAttempt(m, () => zenResponsesRequest(m, messages, true, tools, tool_choice, sessionId, params, zenKey)));
}

function responsesDirectAttempts(models, input, instructions, tools, tool_choice, sessionId, params, zenKey) {
  return models.map((m) => lazyAttempt(m, () => zenResponsesDirectRequest(m, input, instructions, tools, tool_choice, sessionId, params, zenKey)));
}

function collectAttempts(attempts) {
  return collectWithFallback(attempts, (options, body, model) => collectZenSse(options, body, model), { fallbackDelayMs: FALLBACK_DELAY_MS });
}

// Extract estimated token counts from a buffered upstream result. Prefers
// real upstream usage from the already-parsed aggregator result, else falls
// back to a chars/4 estimate over aggregated content or totalBytes.
// Returns { inTok, outTok }. Never scans raw payloads.
function estimateBufferedTokens(zenResp) {
  const completion = zenResp?.completion ?? zenResp?.data;
  if (completion && typeof completion === "object") {
    const usage = completion.usage;
    if (usage && typeof usage === "object") {
      const inTok = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
      const outTok = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
      if (inTok > 0 || outTok > 0) return { inTok, outTok };
    }
    const msg = completion.choices?.[0]?.message;
    let chars = 0;
    if (typeof msg?.content === "string") chars += msg.content.length;
    if (typeof msg?.reasoning_content === "string") chars += msg.reasoning_content.length;
    if (typeof msg?.refusal === "string") chars += msg.refusal.length;
    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (typeof tc?.function?.arguments === "string") chars += tc.function.arguments.length;
        if (typeof tc?.function?.name === "string") chars += tc.function.name.length;
      }
    }
    if (chars > 0) return { inTok: 0, outTok: Math.ceil(chars / 4) };
    if (Number.isFinite(zenResp?.totalBytes) && zenResp.totalBytes > 0) {
      return { inTok: 0, outTok: Math.ceil(zenResp.totalBytes / 4) };
    }
    return { inTok: 0, outTok: 0 };
  }
  if (Number.isFinite(zenResp?.totalBytes) && zenResp.totalBytes > 0) {
    return { inTok: 0, outTok: Math.ceil(zenResp.totalBytes / 4) };
  }
  return { inTok: 0, outTok: 0 };
}

function recordBufferedResult(zenResp, inTokens = 0) {
  if (!zenResp) return;
  STATS.requests += 1;
  if (zenResp.error || Number(zenResp.status) >= 400) {
    STATS.upstreamErrors += 1;
    return;
  }
  const { inTok, outTok } = estimateBufferedTokens(zenResp);
  const finalIn = inTok > 0 ? inTok : (inTokens || 0);
  STATS.inTokens += finalIn;
  STATS.outTokens += outTok;
}

function recordStreamResult(inTokens, outTokens) {
  STATS.requests += 1;
  if (Number.isFinite(inTokens) && inTokens > 0) STATS.inTokens += Math.round(inTokens);
  if (Number.isFinite(outTokens) && outTokens > 0) STATS.outTokens += Math.round(outTokens);
}

// Upstream-bound input estimate. Includes the fingerprint decoy tools that
// every upstream request carries, so traffic stats don't understate cost.
function estimateUpstreamInput(messages, tools) {
  return estimateRequestTokens({ messages, tools: ensureFingerprintTools(tools) }).total;
}

function applyZenDietIfEnabled(model, messages, tools, extra = {}) {
  if (zenDietMode === "off") return { messages, tools, changed: false };
  const pre = estimateRequestTokens({ messages, tools });
  const meta = metaForId(model, META_MAP, defaultFallbackModel(), MODEL_ALIASES);
  const contextWindow = extra.contextWindow || (meta && meta.contextWindow) || 128_000;
  const dietRes = optimizeContext({ messages, tools }, {
    mode: zenDietMode,
    model,
    contextWindow,
    headers: extra.headers,
    client: extra.client,
    toolSlim: zenToolSlim,
  });
  if (extra.req) {
    extra.req.dietInfo = {
      savedTokens: dietRes.changed ? dietRes.stats.savedTokens : 0,
      toolShare: pre.total > 0 ? Math.round((pre.toolResults / pre.total) * 100) : 0,
      totalTokens: pre.total,
    };
  }
  if (dietRes.changed) {
    STATS.zenDietSavedChars += dietRes.stats.savedChars;
    STATS.zenDietSavedTokens += dietRes.stats.savedTokens;
    STATS.zenDietOptimizedReqs += 1;
    return {
      messages: Array.isArray(dietRes.request.messages) ? dietRes.request.messages : messages,
      tools: Array.isArray(dietRes.request.tools) ? dietRes.request.tools : tools,
      changed: true,
      stats: dietRes.stats,
    };
  }
  return { messages, tools, changed: false, stats: dietRes.stats };
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
const modelShrinkState = { consecutive: 0, firstShrinkAt: 0 };
// Enrichment sidecar: Map<id, meta> from models.dev. Empty when the fetch
// failed, timed out, or is disabled. Never affects which ids are served.
let META_MAP = new Map();
let lastMetaFetchTime = 0;
let metaSource = "none";

function loadMetaCache() {
  try {
    const raw = fs.readFileSync(MODELS_DEV_FILE, "utf8");
    const restored = deserializeMetaMap(JSON.parse(raw));
    if (restored.size > 0) {
      META_MAP = restored;
      metaSource = "cache";
    }
  } catch {}
}

function saveMetaCache() {
  try {
    fs.writeFileSync(MODELS_DEV_FILE, JSON.stringify(serializeMetaMap(META_MAP), null, 2), "utf8");
  } catch {}
}
loadMetaCache();

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

// Lifetime gateway stats (reset on restart): estimated tokens served,
// completed requests, upstream timeouts and upstream errors.
const STATS = {
  inTokens: 0,
  outTokens: 0,
  requests: 0,
  timeouts: 0,
  upstreamErrors: 0,
  zenDietSavedTokens: 0,
  zenDietSavedChars: 0,
  zenDietOptimizedReqs: 0,
};
const STARTED_AT = Date.now();

function logUpstreamTimeout(model, elapsedMs) {
  STATS.timeouts += 1;
  const label = typeof model === "string" && model ? model : "unknown model";
  console.error(pc.yellow(`⚠ Upstream timeout: ${label} after ${elapsedMs}ms`));
}


function isDeprecatedModel(model) {
  return isModelDeprecated(model);
}

function isResponsesModel(model) {
  return isModelResponses(model, RESPONSES_SET);
}

function isKnownModel(model) {
  return isModelKnown(model, ALL_MODELS);
}

function defaultFallbackModel() {
  return CHAT_MODELS[0] || ALL_MODELS[0] || DEFAULT_CHAT_MODELS[0];
}

// Served model object for /v1/models and /v1/models/:id. OpenAI-style id
// plus real catalog fields when models.dev metadata is available
// (context_window, max_output_tokens, description). Unknown ids get the
// bare shape; Claude discovery aliases inherit the fallback's numbers.
function servedModelObject(id) {
  const meta = metaForId(id, META_MAP, defaultFallbackModel(), MODEL_ALIASES);
  const obj = {
    id,
    object: "model",
    type: "model",
    created: 1779000000,
    created_at: "2026-07-24T00:00:00Z",
    owned_by: "opencode-free",
    display_name: (meta && meta.name) || id,
    description: (meta && meta.description)
      || (CLAUDE_DISCOVERY_ALIASES.includes(id) && !ALL_MODELS.includes(id)
        ? `OCodeProxy alias for ${defaultFallbackModel()}`
        : "OCodeProxy Zen gateway model"),
  };
  if (meta && meta.contextWindow) obj.context_window = meta.contextWindow;
  if (meta && meta.maxOutputTokens) obj.max_output_tokens = meta.maxOutputTokens;
  return obj;
}

// Claude Code sends Anthropic model ids (gateway aliases we advertise,
// provider-prefixed ids like bedrock/anthropic.claude-...). Only those map
// to the default model; any other unknown id (including bare claude/typo
// ids) stays unresolved so routes answer 404 instead of silently running
// the wrong model.
function resolveRequestModel(rawModel) {
  const fallback = defaultFallbackModel();
  const resolved = resolveGatewayModel(rawModel, ALL_MODELS, fallback);
  if (isModelKnown(resolved, ALL_MODELS)) return { model: resolved, known: true };
  return { model: resolved, known: false };
}

// 404 message for unknown models with a "did you mean" hint when a known
// id or gateway alias is close to the requested one.
function modelNotFoundMessage(requested) {
  const hint = suggestModelId(requested, buildDiscoveryList(ALL_MODELS));
  return hint && hint !== requested
    ? `Model '${requested}' not found. Did you mean '${hint}'?`
    : `Model '${requested}' not found.`;
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

    const req = https.request(options, async (res) => {
      try {
        const { ok, text } = await collectBoundedResponse(res, req, AUX_FETCH_MAX_BYTES);
        if (!ok || res.statusCode !== 200) {
          return resolve(null);
        }
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed?.data) ? parsed.data : [];
        if (!list.length) return resolve(null);

        const discoveredIds = list.map((m) => m.id).filter(Boolean);
        const { chat: newChat, responses: newResponses } = partitionDiscovered(discoveredIds, DISCONTINUED_MODELS, META_MAP);

        if (!newChat.length && !newResponses.length) return resolve(null);

        resolve({ chat: newChat, responses: newResponses });
      } catch {
        resolve(null);
      }
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Fetch the models.dev catalog and extract opencode free-model metadata.
// Runs on its own TTL (default 24h), never blocks model discovery, and
// never affects which ids are served — enrichment only.
function fetchModelsDevMeta() {
  return new Promise((resolve) => {
    if (!MODELS_DEV_URL || !MODELS_DEV_URL.trim()) return resolve(null);
    let url;
    try {
      url = new URL(MODELS_DEV_URL.trim());
    } catch {
      return resolve(null);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return resolve(null);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "OCodeProxy" },
      timeout: 30000,
    };
    applyUpstreamProxy(options);
    const req = https.request(options, async (res) => {
      try {
        const { ok, text } = await collectBoundedResponse(res, req, AUX_FETCH_MAX_BYTES);
        if (!ok || res.statusCode !== 200) return resolve(null);
        const parsed = JSON.parse(text);
        const map = parseModelsDevCatalog(parsed);
        resolve(map.size > 0 ? map : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function maybeRefreshMeta() {
  if (!MODELS_DEV_URL || !MODELS_DEV_URL.trim()) return false;
  if (META_MAP.size > 0 && Date.now() - lastMetaFetchTime <= MODELS_DEV_TTL_MS) return true;
  const map = await fetchModelsDevMeta().catch(() => null);
  lastMetaFetchTime = Date.now();
  if (map && map.size > 0) {
    META_MAP = map;
    metaSource = "live";
    saveMetaCache();
    return true;
  }
  return false;
}

async function refreshModels(silent = false, opts = {}) {
  await maybeRefreshMeta().catch(() => false);
  const result = await fetchUpstreamModels();
  if (result) {
    const guard = shouldKeepCurrent(
      { chat: CHAT_MODELS, responses: RESPONSES_MODELS },
      result,
      modelShrinkState
    );
    if (guard.keep) {
      lastModelsFetchTime = Date.now();
      const total = result.chat.length + result.responses.length;
      console.log(
        pc.yellow(
          `Upstream returned only ${total} models (have ${ALL_MODELS.length}), keeping current list (${modelShrinkState.consecutive}/${DEFAULT_MAX_CONSECUTIVE_SHRINKS}).`
        )
      );
      return false;
    }
    if (guard.forced) {
      const total = result.chat.length + result.responses.length;
      console.log(
        pc.yellow(
          `Upstream model list shrank to ${total} models; forced update applied (${guard.reason}).`
        )
      );
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

function zenRequestFull(zenOpts, body, maxBytes = BUFFERED_SSE_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    applyUpstreamProxy(zenOpts);
    const collector = createBufferedJsonCollector(maxBytes);
    const req = https.request(zenOpts, (zenRes) => {
      zenRes.on("data", (c) => {
        try {
          collector.push(c);
        } catch (e) {
          if (e instanceof BufferLimitError) {
            try { zenRes.destroy(); } catch {}
            try { req.destroy(); } catch {}
            return resolve({ status: 413, data: null, error: { message: e.message, type: "invalid_request_error", code: "buffer_limit_exceeded" }, headers: zenRes.headers || {} });
          }
          try { zenRes.destroy(); } catch {}
          try { req.destroy(); } catch {}
          return reject(e);
        }
      });
      zenRes.on("end", () => {
        let text = "";
        try {
          text = collector.finish().text;
        } catch (e) {
          if (e instanceof BufferLimitError) {
            return resolve({ status: 413, data: null, error: { message: e.message, type: "invalid_request_error", code: "buffer_limit_exceeded" }, headers: zenRes.headers || {} });
          }
          return reject(e);
        }
        const headers = zenRes.headers || {};
        try {
          resolve({ status: zenRes.statusCode, data: JSON.parse(text), raw: text, headers });
        } catch {
          resolve({ status: zenRes.statusCode, data: null, raw: text, headers });
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

function collectZenSse(zenOpts, body, model = "") {
  return new Promise((resolve, reject) => {
    applyUpstreamProxy(zenOpts);
    let receivedBytes = 0;
    const collector = createBufferedSseCollector(BUFFERED_SSE_MAX_BYTES, model);
    let limitError = null;
    const markStarted = (err) => {
      if (receivedBytes > 0) err.upstreamStarted = true;
      return err;
    };
    const req = https.request(zenOpts, (zenRes) => {
      zenRes.on("data", (c) => {
        receivedBytes += c.length;
        if (limitError) return;
        try {
          collector.push(c);
        } catch (e) {
          if (e instanceof BufferLimitError) {
            limitError = e;
            try { zenRes.destroy(); } catch {}
            try { req.destroy(); } catch {}
            return;
          }
          try { zenRes.destroy(); } catch {}
          try { req.destroy(); } catch {}
          reject(markStarted(e));
        }
      });
      zenRes.on("end", () => {
        const headers = zenRes.headers || {};
        if (limitError) {
          return resolve({ status: 413, error: { message: limitError.message, type: "invalid_request_error", code: "buffer_limit_exceeded" }, headers });
        }
        let done;
        try {
          done = collector.finish();
        } catch (e) {
          if (e instanceof BufferLimitError) {
            return resolve({ status: 413, error: { message: e.message, type: "invalid_request_error", code: "buffer_limit_exceeded" }, headers });
          }
          return reject(markStarted(e));
        }
        if (!done.sawData) {
          const det = detectUpstreamError(done.head);
          if (!det.needMore && !det.isStream && det.parsed) {
            const fb = zenRes.statusCode >= 400 ? zenRes.statusCode : 502;
            return resolve({ status: responsesErrorStatus(det.parsed, fb), error: det.parsed, headers });
          }
        }
        if (!done.completion.model && model) done.completion.model = model;
        resolve({ status: zenRes.statusCode, completion: done.completion, totalBytes: done.totalBytes, headers });
      });
      zenRes.on("error", (e) => {
        if (limitError) return;
        reject(markStarted(e));
      });
    });
    req.on("error", (e) => reject(markStarted(e)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Upstream timeout")); });
    req.write(body);
    req.end();
  });
}

function pipeZenResponses(zenOpts, body, requestedModel, res, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const upstreamStartedAt = Date.now();
  const chatId = ocId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let headersSent = false;
  const splitter = createSseLineSplitter();
  let pendingLines = [];
  let firstChunkHandled = false;
  const toolMap = new Map();
  function getToolEntry(ev) {
    for (const k of responsesToolCallKeys(ev)) {
      const entry = toolMap.get(k);
      if (entry) return entry;
    }
    return undefined;
  }
  function setToolEntry(entry, ev) {
    for (const k of responsesToolCallKeys(ev)) {
      toolMap.set(k, entry);
    }
  }
  let finished = false;
  let outChars = 0;

  function sendHeaders() {
    if (headersSent || finished || isStreamClosed(res)) return;
    headersSent = true;
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    } catch {}
    safeWrite(res, `data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
  }

  function sendDelta(delta, finishReason = null) {
    if (finished || isStreamClosed(res)) return;
    safeWrite(res, `data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    safeFlush(res);
  }

  function finish(finishReason) {
    if (finished) return;
    try {
      extra.onDone?.(Math.ceil(outChars / 4));
    } catch {}
    sendHeaders();
    sendDelta({}, finishReason);
    safeWrite(res, "data: [DONE]\n\n");
    finished = true;
    safeEnd(res);
  }

  // Upstream failure after streaming started: record stats, then tear the
  // socket instead of faking a normal stop the agent would chat on.
  function abort() {
    if (finished) return;
    finished = true;
    try {
      extra.onDone?.(Math.ceil(outChars / 4));
    } catch {}
    try {
      req.destroy();
    } catch {}
    abortClientStream(res);
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      let lines;
      try {
        lines = splitter.push(chunk);
      } catch (e) {
        if (e?.code === "buffer_limit_exceeded") {
          if (!headersSent && !res.headersSent) {
            finished = true;
            try { zenRes.resume(); } catch {}
            try { req.destroy(); } catch {}
            const mapped = mapZenError(413, { message: e.message }, "openai");
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            if (!res.writableEnded) res.status(mapped.status).json(mapped.body);
          } else {
            try { abort(); } catch {}
          }
          return;
        }
        throw e;
      }
      outChars += Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length;
      if (!firstChunkHandled) {
        const det = detectUpstreamError(splitter.head());
        if (det.needMore) {
          pendingLines.push(...lines);
          return;
        }
        firstChunkHandled = true;
        if (pendingLines.length) {
          lines = [...pendingLines, ...lines];
          pendingLines = [];
        }
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
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            res.status(mapped.status).json(mapped.body);
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {}
          }
          return;
        }
      }

      for (const line of lines) {
        if (finished || isStreamClosed(res)) break;
        if (!line.startsWith("data: ")) {
          if (headersSent) forwardKeepAlive(res, line, false);
          continue;
        }
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }

        if (ev.type === "response.output_text.delta" && ev.delta) {
          sendHeaders();
          sendDelta({ content: ev.delta });
        } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          sendHeaders();
          const callId = ev.item.call_id || ev.item.id || responsesToolCallKey(ev);
          let entry = getToolEntry(ev);
          if (!entry) {
            const idx = new Set(toolMap.values()).size;
            entry = { index: idx, name: ev.item.name || "", call_id: callId };
            setToolEntry(entry, ev);
            sendDelta({ tool_calls: [{ index: idx, id: callId, type: "function", function: { name: ev.item.name || "", arguments: "" } }] });
          } else {
            if (!entry.name && ev.item.name) entry.name = ev.item.name;
            if (callId) entry.call_id = callId;
            setToolEntry(entry, ev);
          }
        } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
          sendHeaders();
          const key = responsesToolCallKey(ev);
          let entry = getToolEntry(ev);
          if (!entry) {
            const idx = new Set(toolMap.values()).size;
            entry = { index: idx, name: "", call_id: key };
            setToolEntry(entry, ev);
          }
          sendDelta({ tool_calls: [{ index: entry.index, function: { arguments: ev.delta } }] });
        } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
          let entry = getToolEntry(ev);
          if (!entry) {
            sendHeaders();
            const idx = new Set(toolMap.values()).size;
            const callId = ev.item.call_id || ev.item.id || responsesToolCallKey(ev);
            entry = { index: idx, name: ev.item.name || "", call_id: callId };
            setToolEntry(entry, ev);
            sendDelta({ tool_calls: [{ index: idx, id: callId, type: "function", function: { name: ev.item.name || "", arguments: ev.item.arguments || "{}" } }] });
          } else {
            setToolEntry(entry, ev);
          }
        } else if (ev.type === "response.completed") {
          const resp = ev.response || {};
          let finishReason = "stop";
          for (const item of resp.output || []) {
            if (item.type === "function_call") { finishReason = "tool_calls"; break; }
          }
          finish(finishReason);
        } else if (ev.type === "response.failed" || ev.type === "response.incomplete") {
          const maxTokensCut = ev.type === "response.incomplete" && ev.response?.incomplete_details?.reason === "max_output_tokens";
          if (maxTokensCut) finish("stop");
          else abort();
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
      abort();
    });

    zenRes.on("error", (e) => {
      if (finished) return;
      try {
        req.destroy();
      } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json(mapped.body);
      } else if (!finished) {
        try { abort(); } catch {}
      }
    });
  });

  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (headersSent && !finished) {
      try { abort(); } catch {}
    }
  });

  req.on("timeout", () => {
    req.destroy();
    logUpstreamTimeout(requestedModel, Date.now() - upstreamStartedAt);
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (headersSent && !finished) {
      try { abort(); } catch {}
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
  const upstreamStartedAt = Date.now();
  const msgId = ocId("msg");
  let headersSent = false;
  const splitter = createSseLineSplitter();
  let pendingLines = [];
  let firstChunkHandled = false;
  let finished = false;
  const blocks = createAnthropicBlockTracker((event, data) => sendSSE(event, data));
  const toolKeyByItem = new Map();
  function getAnthropicToolKey(ev) {
    for (const k of responsesToolCallKeys(ev)) {
      const key = toolKeyByItem.get(k);
      if (key !== undefined) return key;
    }
    return undefined;
  }
  function setAnthropicToolKey(blockKey, ev) {
    for (const k of responsesToolCallKeys(ev)) {
      toolKeyByItem.set(k, blockKey);
    }
  }
  let outputTokens = 0;

  function sendSSE(event, data) {
    if (finished || isStreamClosed(res)) return;
    safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    safeFlush(res);
  }

  function sendHeaders() {
    if (headersSent || finished || isStreamClosed(res)) return;
    headersSent = true;
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    } catch {}
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
    try {
      blocks.stopAll();
    } catch {}
    try {
      extra.onDone?.(outputTokens);
    } catch {}
    sendSSE("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
    sendSSE("message_stop", { type: "message_stop" });
    finished = true;
    safeEnd(res);
  }

  // Upstream failure after streaming started: record stats, then tear the
  // socket instead of faking end_turn the agent would chat on.
  function abort() {
    if (finished) return;
    finished = true;
    try {
      extra.onDone?.(outputTokens);
    } catch {}
    try {
      req.destroy();
    } catch {}
    abortClientStream(res);
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      let lines;
      try {
        lines = splitter.push(chunk);
      } catch (e) {
        if (e?.code === "buffer_limit_exceeded") {
          if (!headersSent && !res.headersSent) {
            finished = true;
            try { zenRes.resume(); } catch {}
            try { req.destroy(); } catch {}
            const mapped = mapZenError(413, { message: e.message }, "anthropic");
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            if (!res.writableEnded) res.status(mapped.status).json(mapped.body);
          } else {
            try { abort(); } catch {}
          }
          return;
        }
        throw e;
      }
      if (!firstChunkHandled) {
        const det = detectUpstreamError(splitter.head());
        if (det.needMore) {
          pendingLines.push(...lines);
          return;
        }
        firstChunkHandled = true;
        if (pendingLines.length) {
          lines = [...pendingLines, ...lines];
          pendingLines = [];
        }
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
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            res.status(mapped.status).json(mapped.body);
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {}
          }
          return;
        }
      }

      for (const line of lines) {
        if (finished || isStreamClosed(res)) break;
        if (!line.startsWith("data: ")) {
          if (headersSent) forwardKeepAlive(res, line, true);
          continue;
        }
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }

        if (ev.type === "response.output_text.delta" && ev.delta) {
          sendHeaders();
          blocks.stopKey("think");
          const tIdx = blocks.start("text", { type: "text", text: "" });
          sendSSE("content_block_delta", { type: "content_block_delta", index: tIdx, delta: { type: "text_delta", text: ev.delta } });
          outputTokens += Math.ceil(ev.delta.length / 4);
        } else if (
          (ev.type === "response.reasoning_summary_text.delta" || ev.type === "response.reasoning_text.delta") && ev.delta
        ) {
          sendHeaders();
          if (!blocks.has("think") && !blocks.has("text") && toolKeyByItem.size === 0) {
            blocks.start("think", { type: "thinking", thinking: "" });
            sendSSE("content_block_delta", { type: "content_block_delta", index: blocks.keyIndex("think"), delta: { type: "thinking_delta", thinking: ev.delta } });
          }
          outputTokens += Math.ceil(ev.delta.length / 4);
        } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          sendHeaders();
          blocks.stopKey("think");
          const callId = ev.item.call_id || ev.item.id || responsesToolCallKey(ev);
          let key = getAnthropicToolKey(ev);
          if (key === undefined) {
            key = `tool:${callId}`;
            setAnthropicToolKey(key, ev);
            blocks.start(key, {
              type: "tool_use", id: callId, name: ev.item.name || "",
            });
          } else {
            setAnthropicToolKey(key, ev);
          }
        } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
          sendHeaders();
          blocks.stopKey("think");
          let key = getAnthropicToolKey(ev);
          if (key === undefined) {
            const primaryKey = responsesToolCallKey(ev);
            key = `tool:${primaryKey}`;
            setAnthropicToolKey(key, ev);
            blocks.start(key, { type: "tool_use", id: primaryKey, name: "" });
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: blocks.keyIndex(key),
            delta: { type: "input_json_delta", partial_json: ev.delta },
          });
          outputTokens += Math.ceil(ev.delta.length / 4);
        } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
          let key = getAnthropicToolKey(ev);
          if (key === undefined) {
            sendHeaders();
            blocks.stopKey("think");
            const callId = ev.item.call_id || ev.item.id || responsesToolCallKey(ev);
            key = `tool:${callId}`;
            setAnthropicToolKey(key, ev);
            blocks.start(key, {
              type: "tool_use", id: callId, name: ev.item.name || "",
            });
            if (ev.item.arguments) {
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blocks.keyIndex(key),
                delta: { type: "input_json_delta", partial_json: ev.item.arguments },
              });
              outputTokens += Math.ceil(ev.item.arguments.length / 4);
            }
          } else {
            setAnthropicToolKey(key, ev);
          }
        } else if (ev.type === "response.completed") {
          sendHeaders();
          let stopReason = "end_turn";
          for (const item of ev.response?.output || []) {
            if (item.type === "function_call") { stopReason = "tool_use"; break; }
          }
          closeBlocksAndStop(stopReason);
        } else if (ev.type === "response.incomplete") {
          sendHeaders();
          const reason = ev.response?.incomplete_details?.reason;
          if (reason === "max_output_tokens") closeBlocksAndStop("max_tokens");
          else abort();
        } else if (ev.type === "response.failed") {
          sendHeaders();
          abort();
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
      abort();
    });

    zenRes.on("error", (e) => {
      if (finished) return;
      try {
        req.destroy();
      } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json(mapped.body);
      } else if (!finished) {
        try {
          abort();
        } catch {}
      }
    });
  });

  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      try {
        abort();
      } catch {}
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "anthropic");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      try {
        abort();
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
  const splitter = createSseLineSplitter();
  let pendingLines = [];
  let firstChunkHandled = false;
  let finished = false;
  const toolMap = new Map();
  function getPassthroughEntry(ev) {
    for (const k of responsesToolCallKeys(ev)) {
      const entry = toolMap.get(k);
      if (entry) return entry;
    }
    return undefined;
  }
  function setPassthroughEntry(entry, ev) {
    for (const k of responsesToolCallKeys(ev)) {
      toolMap.set(k, entry);
    }
  }
  let outChars = 0;

  function sendHeaders() {
    if (headersSent || finished || isStreamClosed(res)) return;
    headersSent = true;
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    } catch {}
    safeWrite(res, `data: ${JSON.stringify({ type: "response.created", response: { id: respId, model: requestedModel, status: "in_progress" } })}\n\n`);
  }

  function finish(completed) {
    if (finished) return;
    try {
      extra.onDone?.(Math.ceil(outChars / 4));
    } catch {}
    sendHeaders();
    safeWrite(res, `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
    finished = true;
    safeEnd(res);
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      let lines;
      try {
        lines = splitter.push(chunk);
      } catch (e) {
        if (e?.code === "buffer_limit_exceeded") {
          finished = true;
          try { zenRes.resume(); } catch {}
          try { req.destroy(); } catch {}
          if (!headersSent && !res.headersSent && !res.writableEnded) {
            const mapped = mapZenError(413, { message: e.message }, "openai");
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
          } else if (!res.writableEnded) {
            try { res.end(); } catch {}
          }
          return;
        }
        throw e;
      }
      outChars += chunk.length;
      if (!firstChunkHandled) {
        const det = detectUpstreamError(splitter.head());
        if (det.needMore) {
          pendingLines.push(...lines);
          return;
        }
        firstChunkHandled = true;
        if (pendingLines.length) {
          lines = [...pendingLines, ...lines];
          pendingLines = [];
        }
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
          if (!res.headersSent && !res.writableEnded) { applyGatewayHeaders(res, zenRes.headers, mapped.status); res.status(mapped.status).json(out); }
          else if (!res.writableEnded) { try { res.end(); } catch {} }
          return;
        }
      }
      sendHeaders();
      for (const line of lines) {
        if (finished || isStreamClosed(res)) break;
        if (!line.startsWith("data: ")) {
          if (headersSent) forwardKeepAlive(res, line, false);
          continue;
        }
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
          const isDecoy = FINGERPRINT_TOOLS.includes(ev.item.name);
          const entry = { skipped: isDecoy };
          setPassthroughEntry(entry, ev);
          if (isDecoy) continue;
          safeWrite(res, `data: ${JSON.stringify(ev)}\n\n`);
        } else if (ev.type === "response.function_call_arguments.delta") {
          const entry = getPassthroughEntry(ev);
          if (entry?.skipped) continue;
          safeWrite(res, `data: ${JSON.stringify(ev)}\n\n`);
        } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
          const entry = getPassthroughEntry(ev);
          if (entry?.skipped || FINGERPRINT_TOOLS.includes(ev.item.name)) continue;
          safeWrite(res, `data: ${JSON.stringify(ev)}\n\n`);
        } else {
          safeWrite(res, `data: ${JSON.stringify(ev)}\n\n`);
        }
      }
      safeFlush(res);
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
        applyGatewayHeaders(res, undefined, mapped.status);
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
  const splitter = createSseLineSplitter();
  let pendingLines = [];
  let firstChunkHandled = false;
  let finished = false;
  let textItemId = null;
  const toolMap = new Map();
  let usage = null;

  function sendHeaders() {
    if (headersSent || finished || isStreamClosed(res)) return;
    headersSent = true;
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    } catch {}
    safeWrite(res, `data: ${JSON.stringify({ type: "response.created", response: { id: respId, object: "response", created_at: created, model: requestedModel, status: "in_progress" } })}\n\n`);
  }

  function finish(status = "completed") {
    if (finished) return;
    try {
      const outTok = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
      const inTok = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : (extra?.inTokens || 0);
      STATS.requests += 1;
      STATS.inTokens += inTok;
      STATS.outTokens += outTok;
    } catch {}
    sendHeaders();
    safeWrite(res, `data: ${JSON.stringify({ type: "response.completed", response: { id: respId, model: requestedModel, status, usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : undefined } })}\n\n`);
    finished = true;
    safeEnd(res);
  }

  // Upstream failure after streaming started: record stats, then tear the
  // socket instead of faking completion the agent would chat on.
  function abort() {
    if (finished) return;
    finished = true;
    try {
      const outTok = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
      const inTok = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : (extra?.inTokens || 0);
      STATS.requests += 1;
      STATS.inTokens += inTok;
      STATS.outTokens += outTok;
    } catch {}
    try {
      req.destroy();
    } catch {}
    abortClientStream(res);
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      let lines;
      try {
        lines = splitter.push(chunk);
      } catch (e) {
        if (e?.code === "buffer_limit_exceeded") {
          if (!headersSent && !res.headersSent) {
            finished = true;
            try { zenRes.resume(); } catch {}
            try { req.destroy(); } catch {}
            const mapped = mapZenError(413, { message: e.message }, "openai");
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            if (!res.writableEnded) res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
          } else if (!finished) {
            try { abort(); } catch {}
          }
          return;
        }
        throw e;
      }
      if (!firstChunkHandled) {
        const det = detectUpstreamError(splitter.head());
        if (det.needMore) {
          pendingLines.push(...lines);
          return;
        }
        firstChunkHandled = true;
        if (pendingLines.length) {
          lines = [...pendingLines, ...lines];
          pendingLines = [];
        }
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
          if (!res.headersSent && !res.writableEnded) { applyGatewayHeaders(res, zenRes.headers, mapped.status); res.status(mapped.status).json({ error: mapped.body?.error || mapped.body }); }
          else if (!res.writableEnded) { try { res.end(); } catch {} }
          return;
        }
      }
      sendHeaders();
      for (const line of lines) {
        if (finished || isStreamClosed(res)) break;
        if (!line.startsWith("data: ")) {
          if (headersSent) forwardKeepAlive(res, line, false);
          continue;
        }
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
            safeWrite(res, `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: textItemId, role: "assistant", content: [] } })}\n\n`);
          }
          safeWrite(res, `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: textItemId, output_index: 0, delta: delta.content })}\n\n`);
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
              const callId = tc.id || itemId;
              const outputIndex = toolMap.size + 1;
              toolMap.set(idx, { skipped: false, itemId, callId, name: tc.function?.name || "", outputIndex });
              safeWrite(res, `data: ${JSON.stringify({ type: "response.output_item.added", output_index: outputIndex, item: { type: "function_call", id: itemId, call_id: callId, name: tc.function?.name || "" } })}\n\n`);
            }
            const entry = toolMap.get(idx);
            if (entry?.skipped) continue;
            if (tc.function?.arguments) {
              safeWrite(res, `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: entry.itemId, call_id: entry.callId, output_index: entry.outputIndex, delta: tc.function.arguments })}\n\n`);
            }
          }
        }
        if (parsed.choices?.[0]?.finish_reason) finish("completed");
      }
      safeFlush(res);
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
      abort();
    });
    zenRes.on("error", (e) => {
      if (finished) return;
      try { req.destroy(); } catch {}
      if (!headersSent && !res.headersSent) {
        finished = true;
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
      } else if (!finished) { try { abort(); } catch {} }
    });
  });
  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    } else if (!finished) { try { abort(); } catch {} }
  });
  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    } else if (!finished) { try { abort(); } catch {} }
  });
  res.on("close", () => {
    if (!finished) { finished = true; try { req.destroy(); } catch {} }
  });
  req.write(body);
  req.end();
}

function pipeZenResponse(zenOpts, body, stream, res, extra = {}) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  let firstChunk = null;
  let headersSent = false;
  const splitter = createSseLineSplitter();
  let pendingLines = [];
  let finished = false;
  let firstChunkHandled = false;
  let outChars = 0;
  let seenGracefulEnd = false;

  function doneStreaming() {
    if (finished) return;
    finished = true;
    try {
      extra.onDone?.(Math.ceil(outChars / 4));
    } catch {}
  }

  // Upstream failure after streaming started: record stats, then tear the
  // socket instead of faking a normal end the agent would chat on.
  function abort() {
    if (finished) return;
    finished = true;
    try {
      extra.onDone?.(Math.ceil(outChars / 4));
    } catch {}
    try {
      req.destroy();
    } catch {}
    abortClientStream(res);
  }

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

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      if (finished) return;
      let lines;
      try {
        lines = splitter.push(chunk);
      } catch (e) {
        if (e?.code === "buffer_limit_exceeded") {
          if (!headersSent && !res.headersSent && !res.writableEnded) {
            finished = true;
            try { zenRes.resume(); } catch {}
            try { req.destroy(); } catch {}
            const mapped = mapZenError(413, { message: e.message }, "openai");
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            res.status(mapped.status).json(mapped.body);
          } else {
            try { abort(); } catch {}
          }
          return;
        }
        throw e;
      }
      outChars += Buffer.isBuffer(chunk) ? chunk.length : String(chunk).length;
      if (!firstChunkHandled) {
        const det = detectUpstreamError(splitter.head());
        if (det.needMore) {
          pendingLines.push(...lines);
          return;
        }
        firstChunkHandled = true;
        if (pendingLines.length) {
          lines = [...pendingLines, ...lines];
          pendingLines = [];
        }
        firstChunk = true;
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
          if (!res.headersSent && !res.writableEnded) {
            finished = true;
            try {
              zenRes.resume();
            } catch {}
            try {
              req.destroy();
            } catch {}
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            res.status(mapped.status).json(mapped.body);
          } else {
            try {
              abort();
            } catch {}
          }
          return;
        }
      } else if (!firstChunk) {
        firstChunk = true;
      }

      sendHeaders();
      if (finished || isStreamClosed(res)) return;

      for (const line of lines) {
        if (finished || isStreamClosed(res)) break;
        if (!line.startsWith("data: ")) {
          safeWrite(res, line + "\n");
          continue;
        }
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          seenGracefulEnd = true;
          safeWrite(res, line + "\n\n");
          continue;
        }
        if (!payload) {
          safeWrite(res, line + "\n\n");
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          if (parsed.choices?.[0]?.finish_reason != null) seenGracefulEnd = true;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.tool_calls) {
            delta.tool_calls = delta.tool_calls.filter(
              (tc) => !FINGERPRINT_TOOLS.includes(tc.function?.name)
            );
            if (delta.tool_calls.length === 0 && !delta.content && !delta.reasoning_content && !delta.role) {
              continue;
            }
          }
          safeWrite(res, `data: ${JSON.stringify(parsed)}\n\n`);
        } catch {
          safeWrite(res, line + "\n");
        }
      }
      safeFlush(res);
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
        if (seenGracefulEnd) {
          doneStreaming();
          try {
            res.end();
          } catch {}
        } else {
          try {
            abort();
          } catch {}
        }
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
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json(mapped.body);
      } else if (!finished && !res.writableEnded) {
        try {
          abort();
        } catch {}
      }
    });
  });

  req.on("error", (e) => {
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (!finished && res.writableEnded === false) {
      try {
        abort();
      } catch {}
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      try {
        abort();
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
  let headersSent = false;
  const splitter = createSseLineSplitter();
  let pendingLines = [];
  let outputTokens = 0;
  const blocks = createAnthropicBlockTracker((event, data) => sendSSE(event, data));
  const toolTracker = createChatToolTracker(ocId);
  let firstChunkHandled = false;
  let finished = false;
  let stopSent = false;

  function sendSSE(event, data) {
    if (finished || stopSent || isStreamClosed(res)) return;
    safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    safeFlush(res);
  }

  function sendStopOnce(stopReason) {
    if (stopSent || isStreamClosed(res)) return;
    try {
      blocks.stopAll();
    } catch {}
    stopSent = true;
    try {
      extra.onDone?.(outputTokens);
    } catch {}
    safeWrite(res, `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } })}\n\n`);
    safeWrite(res, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    safeFlush(res);
  }

  function endAnthropicStream(stopReason) {
    if (finished) return;
    sendStopOnce(stopReason);
    finished = true;
    safeEnd(res);
  }

  // Upstream failure after streaming started: record stats, then tear the
  // socket instead of faking end_turn the agent would chat on.
  function abort() {
    if (finished) return;
    finished = true;
    try {
      extra.onDone?.(outputTokens);
    } catch {}
    try {
      req.destroy();
    } catch {}
    abortClientStream(res);
  }

  function sendHeaders() {
    if (headersSent || finished || isStreamClosed(res)) return;
    headersSent = true;
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    } catch {}

    sendSSE("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", content: [],
        model, stop_reason: null,
        usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  applyUpstreamProxy(zenOpts);
  const req = https.request(zenOpts, (zenRes) => {

    zenRes.on("data", (chunk) => {
      if (finished) return;
      let lines;
      try {
        lines = splitter.push(chunk);
      } catch (e) {
        if (e?.code === "buffer_limit_exceeded") {
          if (!headersSent && !res.headersSent) {
            finished = true;
            try { zenRes.resume(); } catch {}
            try { req.destroy(); } catch {}
            const mapped = mapZenError(413, { message: e.message }, "anthropic");
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            if (!res.writableEnded) res.status(mapped.status).json(mapped.body);
          } else if (!finished) {
            try { abort(); } catch {}
          }
          return;
        }
        throw e;
      }
      if (!firstChunkHandled) {
        const det = detectUpstreamError(splitter.head());
        if (det.needMore) {
          pendingLines.push(...lines);
          return;
        }
        firstChunkHandled = true;
        if (pendingLines.length) {
          lines = [...pendingLines, ...lines];
          pendingLines = [];
        }
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
            applyGatewayHeaders(res, zenRes.headers, mapped.status);
            res.status(mapped.status).json(mapped.body);
          } else if (!res.writableEnded) {
            try {
              res.end();
            } catch {}
          }
          return;
        }
      }

      for (const line of lines) {
        if (finished || isStreamClosed(res)) break;
        if (!line.startsWith("data: ")) {
          if (headersSent) forwardKeepAlive(res, line, true);
          continue;
        }
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        sendHeaders();

        if (delta.reasoning_content) {
          if (!blocks.has("think") && !blocks.has("text") && !toolTracker.hasStartedTools()) {
            blocks.start("think", { type: "thinking", thinking: "" });
            sendSSE("content_block_delta", {
              type: "content_block_delta", index: blocks.keyIndex("think"),
              delta: { type: "thinking_delta", thinking: delta.reasoning_content },
            });
          }
          outputTokens += Math.ceil(delta.reasoning_content.length / 4);
        }

        if (delta.content) {
          blocks.stopKey("think");
          const tIdx = blocks.start("text", { type: "text", text: "" });
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: tIdx,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        if (Array.isArray(delta.tool_calls)) {
          const calls = [...delta.tool_calls].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          for (const tc of calls) {
            const res = toolTracker.processCall(tc);
            if (!res || res.skipped) continue;

            if (res.firstTimeSeen) {
              blocks.stopKey("think");
              blocks.start(res.key, {
                type: "tool_use",
                id: res.id,
                name: res.name || "",
              });
            }

            if (res.arguments) {
              sendSSE("content_block_delta", {
                type: "content_block_delta",
                index: blocks.keyIndex(res.key),
                delta: { type: "input_json_delta", partial_json: res.arguments },
              });
              outputTokens += Math.ceil(res.arguments.length / 4);
            }
          }
        }

        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";
          else if (fr === "stop_sequence") stopReason = "stop_sequence";
          else if (fr === "content_filter") stopReason = "refusal";
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
      if (!stopSent) {
        abort();
        return;
      }
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
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json(mapped.body);
      } else if (!finished) {
        abort();
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
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      abort();
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (finished || res.writableEnded) return;
    if (!res.headersSent && !headersSent) {
      finished = true;
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "anthropic");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    } else if (!finished) {
      abort();
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

app.get("/v1/models", asyncHandler(async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "openai");
    return res.status(mapped.status).json(mapped.body);
  }

  // Serve from cache instantly: Claude Code discovery (GET /v1/models?limit=1000)
  // fails on slow responses (3s timeout, redirect = failure), so refresh runs
  // in the background. display_name/description keep the /model picker useful.
  maybeRefreshModels().catch(() => {});

  res.setHeader("x-zen-served-by", "ocodeproxy");
  // Claude Code discovery: GET /v1/models?limit=1000, 3s timeout, redirect =
  // failure. Serve from cache, honor limit, include claude-compatible alias
  // ids (discovery filter keeps only ids containing claude/anthropic).
  let limit = 1000;
  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (Number.isInteger(n) && n > 0) limit = Math.min(n, 1000);
  }
  const ids = buildDiscoveryList(ALL_MODELS).slice(0, limit);
  res.json({
    object: "list",
    data: ids.map((id) => servedModelObject(id)),
  });
}));

app.get("/v1/models/:id", asyncHandler(async (req, res) => {
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
  const id = resolveRequestModel(rawId.trim()).model;

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
      error: { message: modelNotFoundMessage(id), type: "not_found_error", code: "model_not_found" },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  res.json(servedModelObject(id));
}));

app.post("/v1/chat/completions", asyncHandler(async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "openai");
    return res.status(mapped.status).json(mapped.body);
  }

  const reqBody = req.body && typeof req.body === "object" ? req.body : {};
  let { model, messages, stream, tools, tool_choice } = reqBody;
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
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return res.status(400).json({
        error: { message: `Invalid message at index ${i}: expected object`, type: "invalid_request_error", code: "invalid_message" },
      });
    }
  }

  let targetModel = resolveRequestModel(model.trim()).model;

  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({
      error: { message: `Model '${targetModel}' is discontinued and no longer supported.`, type: "invalid_request_error", code: "model_deprecated" },
    });
  }

  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
    targetModel = resolveRequestModel(model.trim()).model;
  }

  if (!isKnownModel(targetModel)) {
    return res.status(404).json({
      error: { message: modelNotFoundMessage(targetModel), type: "not_found_error", code: "model_not_found" },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  const sessionId = getSession(user);
  const zenKey = zenKeyFromReq(req);
  const models = candidateModelsForRequest(targetModel);

  messages = repairChatMessages(messages);
  const diet = applyZenDietIfEnabled(targetModel, messages, tools, { headers: req.headers, req });
  messages = diet.messages;
  tools = diet.tools;
  const inTokens = estimateUpstreamInput(messages, tools);

  if (isResponsesModel(targetModel)) {
    const attempts = responsesAttempts(models, messages, tools, tool_choice, sessionId, reqBody, zenKey);
    if (stream) {
      const first = attempts[0];
      pipeZenResponses(first.options, first.body, first.model, res, fallbackExtra(attempts, inTokens));
    } else {
      try {
        const zenResp = await collectAttempts(attempts);
        recordBufferedResult(zenResp, inTokens);

        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
          applyGatewayHeaders(res, zenResp.headers, mapped.status);
          return res.status(mapped.status).json(mapped.body);
        }
        res.json(zenResp.completion);
      } catch (e) {
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json(mapped.body);
      }
    }
    return;
  }

  const chatAttemptsList = chatAttempts(models, messages, tools, tool_choice, sessionId, reqBody, zenKey);
  if (stream) {
    const first = chatAttemptsList[0];
    pipeZenResponse(first.options, first.body, true, res, fallbackExtra(chatAttemptsList, inTokens));
  } else {
    try {
      const zenResp = await collectAttempts(chatAttemptsList);
      recordBufferedResult(zenResp, inTokens);

      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
        applyGatewayHeaders(res, zenResp.headers, mapped.status);
        return res.status(mapped.status).json(mapped.body);
      }
      res.json(zenResp.completion);
    } catch (e) {
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    }
  }
}));

app.post("/v1/messages", asyncHandler(async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "anthropic");
    return res.status(mapped.status).json(mapped.body);
  }

  const reqBody = req.body && typeof req.body === "object" ? req.body : {};
  const { model, stream } = reqBody;
  const validationError = validateAnthropicMessagesBody(reqBody);
  if (validationError) {
    const status = validationError.startsWith("Missing required field: model") ? 400 : 400;
    return res.status(status).json({
      type: "error",
      error: { type: "invalid_request_error", message: validationError },
      request_id: ocId("req"),
    });
  }

  let targetModel = resolveRequestModel(model.trim()).model;

  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Model '${targetModel}' is discontinued and no longer supported.` },
    });
  }

  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
    targetModel = resolveRequestModel(model.trim()).model;
  }

  if (!isKnownModel(targetModel)) {
    return res.status(404).json({
      type: "error",
      error: { type: "not_found_error", message: modelNotFoundMessage(targetModel) },
    });
  }

  // max_tokens: 0 pre-warms the prompt cache without generating a response.
  if (reqBody.max_tokens === 0) {
    res.setHeader("x-zen-served-by", "ocodeproxy");
    return res.json({
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [],
      model: targetModel,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  res.setHeader("request-id", ocId("req"));
  const sessionId = getSession(user);
  let { messages, tools, params } = anthropicToOpenAI(reqBody);
  messages = repairChatMessages(messages);
  const diet = applyZenDietIfEnabled(targetModel, messages, tools, { headers: req.headers, req });
  messages = diet.messages;
  tools = diet.tools;
  const inTokens = estimateUpstreamInput(messages, tools);
  const zenKey = zenKeyFromReq(req);
  const models = candidateModelsForRequest(targetModel);

  if (isResponsesModel(targetModel)) {
    const attempts = responsesAttempts(models, messages, tools, undefined, sessionId, params, zenKey);
    if (stream) {
      const first = attempts[0];
      pipeZenResponsesAsAnthropic(first.options, first.body, first.model, res, inTokens, fallbackExtra(attempts, inTokens));
    } else {
      try {
        const zenResp = await collectAttempts(attempts);
        recordBufferedResult(zenResp, inTokens);

        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "anthropic");
          applyGatewayHeaders(res, zenResp.headers, mapped.status);
          return res.status(mapped.status).json(mapped.body);
        }
        res.json(openAIToAnthropic(zenResp.completion, zenResp.model, inTokens));
      } catch (e) {
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json(mapped.body);
      }
    }
    return;
  }

  const chatAttemptsList = chatAttempts(models, messages, tools, undefined, sessionId, params, zenKey);
  if (stream) {
    const first = chatAttemptsList[0];
    pipeZenAsAnthropic(first.options, first.body, first.model, res, inTokens, fallbackExtra(chatAttemptsList, inTokens));
  } else {
    try {
      const zenResp = await collectAttempts(chatAttemptsList);
      recordBufferedResult(zenResp, inTokens);

      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "anthropic");
        applyGatewayHeaders(res, zenResp.headers, mapped.status);
        return res.status(mapped.status).json(mapped.body);
      }
      res.json(openAIToAnthropic(zenResp.completion, zenResp.model, inTokens));
    } catch (e) {
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "anthropic");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json(mapped.body);
    }
  }
}));

app.post("/v1/responses", asyncHandler(async (req, res) => {
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
  let targetModel = resolveRequestModel(model.trim()).model;
  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({ error: { message: `Model '${targetModel}' is discontinued and no longer supported.`, type: "invalid_request_error", code: "model_deprecated" } });
  }
  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
    targetModel = resolveRequestModel(model.trim()).model;
  }
  if (!isKnownModel(targetModel)) {
    return res.status(404).json({ error: { message: modelNotFoundMessage(targetModel), type: "not_found_error", code: "model_not_found" } });
  }
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const sessionId = getSession(user);
  const zenKey = zenKeyFromReq(req);
  const models = candidateModelsForRequest(targetModel);
  if (isResponsesModel(targetModel)) {
    const repairedInput = repairResponsesInput(input);
    const attempts = responsesDirectAttempts(models, repairedInput, instructions, tools, tool_choice, sessionId, body, zenKey);
    const inTokens = estimateUpstreamInput(responsesInputToChatMessages(repairedInput, instructions), normalizeResponsesTools(tools));
    if (stream) {
      const first = attempts[0];
      pipeZenResponsesPassthrough(first.options, first.body, first.model, res, fallbackExtra(attempts, inTokens));
    } else {
      try {
        const zenResp = await collectAttempts(attempts);
        recordBufferedResult(zenResp, inTokens);
        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
          applyGatewayHeaders(res, zenResp.headers, mapped.status);
          return res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
        }
        res.json(chatCompletionToResponses(zenResp.completion, zenResp.model));
      } catch (e) {
        const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
        applyGatewayHeaders(res, undefined, mapped.status);
        res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
      }
    }
    return;
  }
  let messages = responsesInputToChatMessages(input, instructions);
  messages = repairChatMessages(messages);
  let normalizedTools = normalizeResponsesTools(tools).map((t) => ({ type: "function", function: t }));
  const diet = applyZenDietIfEnabled(targetModel, messages, normalizedTools.length ? normalizedTools : undefined, { headers: req.headers, req });
  messages = diet.messages;
  if (diet.tools) normalizedTools = diet.tools;
  const inTokens = estimateUpstreamInput(messages, normalizedTools);
  const chatParams = { ...body };
  if (chatParams.max_output_tokens !== undefined && chatParams.max_tokens === undefined && chatParams.max_completion_tokens === undefined) {
    chatParams.max_tokens = chatParams.max_output_tokens;
  }
  const chatAttemptsList = chatAttempts(models, messages, normalizedTools.length ? normalizedTools : undefined, tool_choice, sessionId, chatParams, zenKey);
  if (stream) {
    const first = chatAttemptsList[0];
    pipeChatAsResponses(first.options, first.body, first.model, res, fallbackExtra(chatAttemptsList, inTokens));
  } else {
    try {
      const zenResp = await collectAttempts(chatAttemptsList);
      recordBufferedResult(zenResp, inTokens);
      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
        applyGatewayHeaders(res, zenResp.headers, mapped.status);
        return res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
      }
      res.json(chatCompletionToResponses(zenResp.completion, zenResp.model));
    } catch (e) {
      const mapped = mapZenError(502, { message: publicNetworkMessage(e) }, "openai");
      applyGatewayHeaders(res, undefined, mapped.status);
      res.status(mapped.status).json({ error: mapped.body?.error || mapped.body });
    }
  }
}));

app.post("/v1/messages/count_tokens", asyncHandler(async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }
  const reqBody = req.body && typeof req.body === "object" ? req.body : {};
  const { model } = reqBody;
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "Missing required field: model (string)" } });
  }
  let targetModel = resolveRequestModel(model.trim()).model;
  if (isDeprecatedModel(targetModel)) {
    return res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: `Model '${targetModel}' is discontinued and no longer supported.` } });
  }
  if (!isKnownModel(targetModel)) {
    await maybeRefreshModels();
    targetModel = resolveRequestModel(model.trim()).model;
  }
  if (!isKnownModel(targetModel)) {
    return res.status(404).json({ type: "error", error: { type: "not_found_error", message: modelNotFoundMessage(targetModel) } });
  }
  res.setHeader("x-zen-served-by", "ocodeproxy");
  res.json({ input_tokens: estimateAnthropicTokens(reqBody) });
}));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: TUI_VERSION,
    port: currentPort,
    models: ALL_MODELS.length,
    modelsMeta: { entries: META_MAP.size, source: metaSource },
    ocVersion: ocVersion,
    zenAuthMode: ZEN_AUTH_MODE,
    upstreamProxyConfigured: Boolean(upstreamProxyUrl),
    zenDiet: {
      mode: zenDietMode,
      savedTokens: STATS.zenDietSavedTokens,
      savedChars: STATS.zenDietSavedChars,
      optimizedRequests: STATS.zenDietOptimizedReqs,
    },
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

// Claude Code connection-warming probe (HEAD, no credentials). Answered
// locally with a static 200 and never forwarded upstream.
app.head("/api/hello", (_req, res) => {
  res.status(200).end();
});
app.get("/api/hello", (_req, res) => {
  res.status(200).json({ status: "ok" });
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
    `${pc.bold("Models:")}    ${pc.cyan(String(ALL_MODELS.length))} ${pc.dim("upstream models")}`,
    `${pc.bold("ZenDiet:")}   ${dietStatusColor()(`● ${zenDietMode.toUpperCase()}${zenToolSlim ? "+SLIM" : ""}`)} ${pc.dim("(Context Governor)")}`,
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
          `  ${pc.yellow("[i]")} ℹ️  Server info`,
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
        { value: "refresh_meta", label: "Refresh model metadata (models.dev)", hint: metaSource === "live" ? `${META_MAP.size} entries` : "not loaded" },
        { value: "new_key", label: "Generate new API key", hint: "create key with custom name" },
        { value: "regenerate_keys", label: "Regenerate default keys", hint: "reset admin & user-default" },
        { value: "zendiet", label: "ZenDiet Mode (Token Saver)", hint: `current: ${zenDietMode.toUpperCase()}${zenToolSlim ? "+SLIM" : ""}` },
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
        const meta = META_MAP.get(m);
        const window = meta && meta.contextWindow ? pc.dim(` ${meta.contextWindow}`) : "";
        p.log.message(`  ${pc.bold(m.padEnd(35))} ${pc.dim(`[${type}]`)}${window}`);
      }
    } else if (action === "refresh_meta") {
      const s = p.spinner();
      s.start("Fetching model metadata from models.dev...");
      lastMetaFetchTime = 0;
      const ok = await maybeRefreshMeta().catch(() => false);
      if (ok) {
        s.stop(pc.green(`✔ Loaded metadata for ${META_MAP.size} models (source: ${metaSource}).`));
      } else {
        s.stop(pc.yellow(`⚠ Metadata fetch failed, keeping ${META_MAP.size} cached entries (source: ${metaSource}).`));
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
    } else if (action === "zendiet") {
      const modeChoice = await p.select({
        message: "Select ZenDiet optimization mode:",
        options: [
          { value: "balanced", label: "Balanced (Recommended)", hint: "dedup + safe reduction at 70% pressure" },
          { value: "safe", label: "Safe", hint: "dedup + terminal noise stripping only" },
          { value: "aggressive", label: "Aggressive", hint: "active reduction at 55% pressure" },
          { value: "off", label: "Off", hint: "bypass all context optimization" },
        ],
      });
      if (!p.isCancel(modeChoice)) {
        zenDietMode = modeChoice;
        p.log.success(pc.green(`✔ ZenDiet mode set to: ${pc.bold(zenDietMode.toUpperCase())}`));
      }
      const slimChoice = await p.select({
        message: "Slim long tool descriptions to first sentence? (experimental, may degrade tool use)",
        options: [
          { value: "on", label: "On", hint: "saves tokens on large tool schemas" },
          { value: "off", label: "Off", hint: "keep full tool descriptions" },
        ],
      });
      if (!p.isCancel(slimChoice)) {
        zenToolSlim = slimChoice === "on";
        p.log.success(pc.green(`✔ Tool slimming ${zenToolSlim ? "enabled" : "disabled"}`));
      }
    }
  }

}

let settingsOpen = false;

function formatUptime() {
  const s = Math.floor((Date.now() - STARTED_AT) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function showInfoPanel() {
  const meta = META_MAP.get(defaultFallbackModel());
  const content = [
    `${pc.bold(pc.cyan("ℹ️  OCodeProxy Info"))} ${pc.dim(`${TUI_VERSION} · up ${formatUptime()} · port ${currentPort}`)}`,
    "",
    `${pc.bold("Upstream:")}  ${pc.dim(`opencode.ai/zen/v1 (${ZEN_AUTH_MODE})`)}`,
    `${pc.bold("OpenCode:")}  ${pc.dim(`opencode/${ocVersion}`)}`,
    `${pc.bold("Models:")}    ${pc.cyan(String(ALL_MODELS.length))} ${pc.dim(`discovered (${metaSource} meta: ${META_MAP.size})`)}`,
    ...(meta && meta.contextWindow
      ? [`${pc.bold("Fallback:")}  ${pc.dim(`${defaultFallbackModel()} · ${meta.contextWindow} ctx${meta.maxOutputTokens ? ` / ${meta.maxOutputTokens} out` : ""}`)}`]
      : []),
    ...(upstreamProxyUrl ? [`${pc.bold("Proxy:")}     ${pc.yellow(upstreamProxyUrl)}`] : []),
    `${pc.bold("Keys:")}      ${pc.dim(`${Object.keys(apiKeys).length} local (${KEYS_FILE})`)}`,
    "",
    `${pc.bold("ZenDiet:")}   ${dietStatusColor()(`● ${zenDietMode.toUpperCase()}${zenToolSlim ? "+SLIM" : ""}`)} ${pc.dim(`(~${STATS.zenDietSavedTokens} tok saved · ${STATS.zenDietOptimizedReqs} reqs)`)}`,
    `${pc.bold("Traffic:")}   ${pc.dim(`${STATS.requests} req · in ~${STATS.inTokens} / out ~${STATS.outTokens} tok (est.)`)}`,
    `${pc.bold("Upstream:")}  ${pc.dim(`${STATS.timeouts} timeouts · ${STATS.upstreamErrors} errors`)}`,
    ...(process.stdin.isTTY ? ["", pc.dim("Press any key to return")] : []),
  ].join("\n");
  console.log(
    boxen(content, {
      padding: 1,
      margin: 1,
      borderStyle: "round",
      borderColor: "blue",
    })
  );
}

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
  } else if (key.name === "i") {
    settingsOpen = true;
    try {
      pauseKeybindings();
      if (process.stdout.isTTY) console.clear();
      showInfoPanel();
      if (process.stdin.isTTY) {
        await new Promise((resolve) => process.stdin.once("keypress", () => resolve()));
      }
    } finally {
      if (process.stdout.isTTY) {
        console.clear();
        renderBanner(currentPort);
      }
      setupKeybindings();
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
maybeRefreshMeta().catch(() => {});
const ocVersionTimer = setInterval(checkPeriodicOcVersion, 60 * 60 * 1000);
if (typeof ocVersionTimer.unref === "function") ocVersionTimer.unref();
const sessionSweepTimer = setInterval(() => sessionStore.sweep(), DEFAULT_SESSION_SWEEP_INTERVAL_MS);
if (typeof sessionSweepTimer.unref === "function") sessionSweepTimer.unref();
