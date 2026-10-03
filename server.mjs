import express from "express";
import boxen from "boxen";
import pc from "picocolors";
import * as p from "@clack/prompts";
import readline from "node:readline";
import net from "node:net";
import crypto from "node:crypto";
import https from "node:https";
import fs from "node:fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

process.title = "OCodeProxy";
if (process.stdout.isTTY) {
  process.stdout.write("\x1b]0;OCodeProxy\x07");
}

const TUI_VERSION = "v0.1.0-t1";
const PROXY_VERSION = process.env.PROXY_VERSION || "16";
const OC_VERSION = process.env.OC_VERSION || "1.18.30";
const AI_SDK_VER = process.env.AI_SDK_VER || "4.0.23";
const BUN_VER = process.env.BUN_VER || "1.3.13";
const OPENCODE_CLIENT = process.env.OPENCODE_CLIENT || "cli";
const OPENCODE_PROJECT = process.env.OPENCODE_PROJECT || "global";
const ZEN_AUTH_MODE = process.env.ZEN_AUTH_MODE || "public";
const KEYS_FILE = process.env.KEYS_FILE || "./api-keys.json";

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

function generateKeyString() {
  return "oc-" + crypto.randomBytes(20).toString("hex");
}

function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2), "utf8");
}

function loadKeys() {
  try {
    apiKeys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: generateKeyString(),
      "user-default": generateKeyString(),
    };
    saveKeys();
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (tok === key) return name;
  }
  return null;
}

function ocId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: ocId("ses"), ts: now };
  }
  return userSessions[user].id;
}

function buildZenHeaders(sessionId, requestId, isStream = false, bodyLength = 0) {
  const reqId = requestId || ocId("msg");
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${ZEN_AUTH_MODE}`,
    "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/${AI_SDK_VER} runtime/bun/${BUN_VER}`,
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

function chatToResponses(targetModel, messages, tools, tool_choice) {
  let instructions = undefined;
  const input = [];

  for (const m of messages || []) {
    if (m.role === "system" || m.role === "developer") {
      const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      if (t) instructions = instructions ? instructions + "\n" + t : t;
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
      for (const tc of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        });
      }
      continue;
    }
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role === "assistant") {
      input.push({ role: "assistant", content: [{ type: "output_text", text }] });
    } else {
      input.push({ role: m.role === "developer" ? "user" : m.role, content: [{ type: "input_text", text }] });
    }
  }

  const reqBody = { model: targetModel, input };
  if (instructions) reqBody.instructions = instructions;
  if (tools?.length) {
    reqBody.tools = tools.map((t) => ({
      type: "function",
      name: t.function?.name || t.name || "",
      description: t.function?.description || t.description || "",
      parameters: t.function?.parameters || t.parameters || {},
    }));
  }
  if (tool_choice) {
    if (typeof tool_choice === "string") reqBody.tool_choice = tool_choice;
    else if (tool_choice.function?.name) reqBody.tool_choice = { type: "function", name: tool_choice.function.name };
  }
  return reqBody;
}

const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];
const DECOY_DESCRIPTION = "This tool is currently unavailable and must not be used.";

function decoyTool(name) {
  return {
    type: "function",
    function: {
      name,
      description: DECOY_DESCRIPTION,
      parameters: { type: "object", properties: {} },
    },
  };
}

function toolName(t) {
  return t?.function?.name || t?.name || "";
}

function ensureFingerprintTools(tools) {
  const list = Array.isArray(tools) ? tools.filter((t) => toolName(t)) : [];
  const names = new Set(list.map(toolName));
  for (const name of FINGERPRINT_TOOLS) {
    if (!names.has(name)) list.push(decoyTool(name));
  }
  return list;
}

function ensureAssistantReasoning(messages) {
  for (const m of messages || []) {
    if (m && typeof m === "object" && m.role === "assistant") {
      if (typeof m.reasoning_content !== "string") {
        m.reasoning_content = "";
      }
    }
  }
  return messages;
}

function zenRequest(model, messages, _stream, tools, tool_choice, sessionId) {
  const preparedMessages = ensureAssistantReasoning(messages);
  const hadClientTools = Array.isArray(tools) && tools.length > 0;
  const mergedTools = ensureFingerprintTools(tools);

  const reqBody = {
    model,
    messages: preparedMessages,
    stream: true,
    tools: mergedTools,
  };
  if (tool_choice) {
    reqBody.tool_choice = tool_choice;
  } else if (!hadClientTools) {
    reqBody.tool_choice = "none";
  }

  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");
  const headers = buildZenHeaders(sessionId, requestId, true, Buffer.byteLength(body));

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/chat/completions",
      method: "POST",
      headers,
      timeout: 120000,
    },
  };
}

function zenResponsesRequest(targetModel, messages, _stream, tools, tool_choice, sessionId) {
  const reqPayload = chatToResponses(targetModel, messages, tools, tool_choice);
  reqPayload.stream = true;
  const body = JSON.stringify(reqPayload);
  const requestId = ocId("msg");
  const headers = buildZenHeaders(sessionId, requestId, true, Buffer.byteLength(body));

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/responses",
      method: "POST",
      headers,
      timeout: 120000,
    },
  };
}

const CHAT_MODELS = [
  "deepseek-v4-flash-free",
  "big-pickle",
  "space-bunny-free",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "ling-3.1-flash-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "longcat-2.5-preview-free",
  "fledge-alpha-free",
];

const RESPONSES_MODELS = [
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.3",
  "muse-spark-1.2-contributor-free",
];

const MODEL_ALIASES = {
  "deepseek-v4-flash": "deepseek-v4-flash-free",
  "muse-spark-1.3-free": "muse-spark-1.3-contributor-free",
  "mimo-v2.6-flash": "mimo-v2.6-flash-free",
};

const DISCONTINUED_MODELS = new Set([
  "jev-1.13-free",
]);

const ALL_MODELS = [...CHAT_MODELS, ...RESPONSES_MODELS];
const RESPONSES_SET = new Set(RESPONSES_MODELS);

function isDeprecatedModel(model) {
  return DISCONTINUED_MODELS.has(model);
}

function resolveModel(model) {
  return MODEL_ALIASES[model] || model;
}

function isResponsesModel(model) {
  return RESPONSES_SET.has(resolveModel(model));
}

function responsesToOpenAI(resp, requestedModel) {
  let text = "";
  const toolCalls = [];
  for (const item of resp?.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) text += c.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || ocId("call"),
        type: "function",
        function: { name: item.name || "", arguments: item.arguments || "{}" },
      });
    }
  }

  return {
    id: resp?.id ? `chatcmpl-${resp.id}` : ocId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: resp?.usage?.input_tokens || 0,
      completion_tokens: resp?.usage?.output_tokens || 0,
      total_tokens: resp?.usage?.total_tokens || 0,
    },
  };
}

function responsesErrorStatus(data) {
  const msg = data?.error?.message || data?.message || "";
  if (data?.error?.code === "rate_limit_exceeded" || data?.error?.type === "rate_limit_error" || /rate_limit|Rate limit/i.test(msg)) {
    return 429;
  }
  return null;
}

function mapZenError(status, errData, format = "openai") {
  let rawMsg = errData?.error?.message || errData?.message || "Upstream error";
  let code = errData?.error?.code || (status === 429 ? "rate_limit_exceeded" : "upstream_error");
  let type = errData?.error?.type || (status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : "upstream_error");
  let finalStatus = status || 502;

  if (status === 429 || /rate_limit|FreeUsageLimitError/i.test(rawMsg)) {
    finalStatus = 429;
    type = "rate_limit_error";
    code = "rate_limit_exceeded";
    rawMsg = `${rawMsg} (free model rate limit)`;
  } else if (status === 401) {
    type = "authentication_error";
  } else if (status === 403) {
    type = "permission_error";
  }

  if (format === "anthropic") {
    return { status: finalStatus, body: { type: "error", error: { type, message: rawMsg } } };
  }
  return { status: finalStatus, body: { error: { message: rawMsg, type, code } } };
}

function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: zenRes.statusCode, data: JSON.parse(raw), raw });
        } catch {
          resolve({ status: zenRes.statusCode, data: null, raw });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Upstream timeout")); });
    req.write(body);
    req.end();
  });
}

async function executeWithRetry(requestFn, maxRetries = 1) {
  let attempt = 0;
  while (true) {
    try {
      const resp = await requestFn();
      if ((resp.status >= 500 || resp.status === 429) && attempt < maxRetries) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      return resp;
    } catch (err) {
      if (attempt < maxRetries) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw err;
    }
  }
}

function aggregateSseToCompletion(raw, model = "") {
  let id;
  let created;
  let outModel = model;
  let content = "";
  let reasoning = "";
  const toolCalls = {};
  let finish = "stop";

  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed.id) id = parsed.id;
    if (parsed.created) created = parsed.created;
    if (parsed.model) outModel = parsed.model;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        const slot = (toolCalls[idx] ??= {
          id: tc.id || ocId("call"),
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  const calls = Object.values(toolCalls).filter(
    (c) => !FINGERPRINT_TOOLS.includes(c.function?.name)
  );

  return {
    id: id || ocId("chatcmpl"),
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: outModel || model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: calls.length ? "tool_calls" : finish || "stop",
    }],
    usage: {
      prompt_tokens: Math.ceil(content.length / 4),
      completion_tokens: Math.ceil((content.length + reasoning.length) / 4),
      total_tokens: Math.ceil((content.length * 2 + reasoning.length) / 4),
    },
  };
}

function aggregateResponsesSseToOpenAI(raw, requestedModel) {
  let text = "";
  const toolCalls = {};
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }
    if (ev.type === "response.output_text.delta" && ev.delta) {
      text += ev.delta;
    } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
      const idx = Object.keys(toolCalls).length;
      toolCalls[ev.item.id] = { index: idx, id: ev.item.call_id || ev.item.id, name: ev.item.name || "", arguments: "" };
    } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
      if (toolCalls[ev.item_id]) {
        toolCalls[ev.item_id].arguments += ev.delta;
      }
    }
  }

  const calls = Object.values(toolCalls).map((tc) => ({
    id: tc.id,
    type: "function",
    function: { name: tc.name, arguments: tc.arguments || "{}" },
  }));

  return {
    id: ocId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: calls.length ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: Math.ceil(text.length / 4),
      completion_tokens: Math.ceil(text.length / 4),
      total_tokens: Math.ceil(text.length / 2),
    },
  };
}

function collectZenSse(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const trimmed = raw.trim();
        if (trimmed.startsWith("{") && (trimmed.includes('"error"') || trimmed.includes("FreeTierError") || trimmed.includes("FreeUsageLimitError") || trimmed.includes("rate_limit"))) {
          try {
            const errObj = JSON.parse(trimmed);
            if (errObj.error || errObj.type === "error") {
              return resolve({ status: zenRes.statusCode >= 400 ? zenRes.statusCode : 403, error: errObj });
            }
          } catch {}
        }
        resolve({ status: zenRes.statusCode, raw });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Upstream timeout")); });
    req.write(body);
    req.end();
  });
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolUses = msg.content.filter((b) => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some((b) => b.type === "tool_result")) {
        for (const b of msg.content.filter((b) => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function pipeZenResponses(zenOpts, body, requestedModel, res) {
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

  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      const str = chunk.toString();
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes('"error"') || trimmed.includes("rate_limit"))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error) {
              const mapped = mapZenError(responsesErrorStatus(parsed) || zenRes.statusCode || 502, parsed, "openai");
              if (!res.headersSent) {
                res.status(mapped.status).json(mapped.body);
              }
              zenRes.resume();
              finished = true;
              return;
            }
          } catch {}
        }
      }
      if (finished) return;

      buffer += str;
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
        if (!res.headersSent) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "openai");
          res.status(mapped.status).json(mapped.body);
        }
        finished = true;
        return;
      }
      finish(toolMap.size ? "tool_calls" : "stop");
    });
  });

  req.on("error", (e) => {
    if (!res.headersSent && !headersSent) {
      const mapped = mapZenError(502, { message: e.message }, "openai");
      res.status(mapped.status).json(mapped.body);
    } else if (headersSent && !finished) {
      try { finish("stop"); } catch {}
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent && !headersSent) {
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      res.status(mapped.status).json(mapped.body);
    }
  });

  req.write(body);
  req.end();
}

function pipeZenResponsesAsAnthropic(zenOpts, body, model, res, inputTokens) {
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

  const req = https.request(zenOpts, (zenRes) => {
    zenRes.on("data", (chunk) => {
      const str = chunk.toString();
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes('"error"') || trimmed.includes("rate_limit"))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error) {
              const mapped = mapZenError(responsesErrorStatus(parsed) || zenRes.statusCode || 502, parsed, "anthropic");
              if (!res.headersSent) {
                res.status(mapped.status).json(mapped.body);
              }
              finished = true;
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }
      if (finished) return;

      buffer += str;
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
        if (!res.headersSent) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "anthropic");
          res.status(mapped.status).json(mapped.body);
        }
        finished = true;
        return;
      }
      closeBlocksAndStop(toolEntries.length ? "tool_use" : "end_turn");
    });
  });

  req.on("error", (e) => {
    if (!res.headersSent && !headersSent) {
      const mapped = mapZenError(502, { message: e.message }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent && !headersSent) {
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    }
  });

  req.write(body);
  req.end();
}

function pipeZenResponse(zenOpts, body, stream, res) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;
    let buffer = "";

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
    }

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();

      if (!firstChunk) {
        firstChunk = chunk;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes("FreeTierError") || trimmed.includes('"error"'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              const mapped = mapZenError(zenRes.statusCode === 200 ? 429 : zenRes.statusCode, parsed, "openai");
              if (!res.headersSent) {
                res.status(mapped.status).json(mapped.body);
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      sendHeaders();
      buffer += str;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
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
      if (!headersSent && !firstChunk) {
        if (!res.headersSent) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "openai");
          res.status(mapped.status).json(mapped.body);
        }
        return;
      }
      if (headersSent) res.end();
    });
  });

  req.on("error", (e) => {
    if (!res.headersSent) {
      const mapped = mapZenError(502, { message: e.message }, "openai");
      res.status(mapped.status).json(mapped.body);
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "openai");
      res.status(mapped.status).json(mapped.body);
    }
  });

  req.write(body);
  req.end();
}

function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens) {
  res.setHeader("x-zen-served-by", "ocodeproxy");
  const msgId = ocId("msg");

  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;

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

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();

      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              const mapped = mapZenError(zenRes.statusCode === 200 ? 429 : zenRes.statusCode, parsed, "anthropic");
              if (!res.headersSent) {
                res.status(mapped.status).json(mapped.body);
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      buffer += str;
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
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
            sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          }

          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";

          sendSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
          });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent) {
        if (!res.headersSent) {
          const mapped = mapZenError(502, { message: "Empty response from upstream" }, "anthropic");
          res.status(mapped.status).json(mapped.body);
        }
        return;
      }
      res.end();
    });
  });

  req.on("error", (e) => {
    if (!res.headersSent) {
      const mapped = mapZenError(502, { message: e.message }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      const mapped = mapZenError(504, { message: "Upstream timeout" }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    }
  });

  req.write(body);
  req.end();
}

app.get("/v1/models", (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "openai");
    return res.status(mapped.status).json(mapped.body);
  }

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

app.post("/v1/chat/completions", async (req, res) => {
  const user = auth(req);
  if (!user) {
    const mapped = mapZenError(401, { message: "Invalid API key" }, "openai");
    return res.status(mapped.status).json(mapped.body);
  }

  const { model, messages, stream, tools, tool_choice } = req.body;

  if (isDeprecatedModel(model)) {
    return res.status(400).json({
      error: { message: `Model '${model}' is discontinued and no longer supported.`, type: "invalid_request_error", code: "model_deprecated" },
    });
  }

  if (!ALL_MODELS.includes(model) && !MODEL_ALIASES[model]) {
    return res.status(400).json({
      error: { message: `Unknown model: ${model}. Available: ${ALL_MODELS.join(", ")}`, type: "invalid_request_error" },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  const sessionId = getSession(user);
  const targetModel = resolveModel(model);

  if (isResponsesModel(model)) {
    if (stream) {
      const { body, options } = zenResponsesRequest(targetModel, messages, true, tools, tool_choice, sessionId);
      pipeZenResponses(options, body, model, res);
    } else {
      try {
        const zenResp = await executeWithRetry(async () => {
          const { body, options } = zenResponsesRequest(targetModel, messages, true, tools, tool_choice, sessionId);
          return collectZenSse(options, body);
        }, 1);

        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
          return res.status(mapped.status).json(mapped.body);
        }
        res.json(aggregateResponsesSseToOpenAI(zenResp.raw, model));
      } catch (e) {
        const mapped = mapZenError(502, { message: e.message }, "openai");
        res.status(mapped.status).json(mapped.body);
      }
    }
    return;
  }

  if (stream) {
    const { body, options } = zenRequest(targetModel, messages, true, tools, tool_choice, sessionId);
    pipeZenResponse(options, body, true, res);
  } else {
    try {
      const zenResp = await executeWithRetry(async () => {
        const { body, options } = zenRequest(targetModel, messages, true, tools, tool_choice, sessionId);
        return collectZenSse(options, body);
      }, 1);

      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "openai");
        return res.status(mapped.status).json(mapped.body);
      }
      res.json(aggregateSseToCompletion(zenResp.raw, model));
    } catch (e) {
      const mapped = mapZenError(502, { message: e.message }, "openai");
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

  const { model, stream } = req.body;

  if (isDeprecatedModel(model)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Model '${model}' is discontinued and no longer supported.` },
    });
  }

  if (!ALL_MODELS.includes(model) && !MODEL_ALIASES[model]) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${ALL_MODELS.join(", ")}` },
    });
  }

  res.setHeader("x-zen-served-by", "ocodeproxy");
  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);
  const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
  const targetModel = resolveModel(model);

  if (isResponsesModel(model)) {
    if (stream) {
      const { body, options } = zenResponsesRequest(targetModel, messages, true, tools, undefined, sessionId);
      pipeZenResponsesAsAnthropic(options, body, model, res, inputTokens);
    } else {
      try {
        const zenResp = await executeWithRetry(async () => {
          const { body, options } = zenResponsesRequest(targetModel, messages, true, tools, undefined, sessionId);
          return collectZenSse(options, body);
        }, 1);

        if (zenResp.error || zenResp.status >= 400) {
          const mapped = mapZenError(zenResp.status, zenResp.error, "anthropic");
          return res.status(mapped.status).json(mapped.body);
        }
        res.json(openAIToAnthropic(aggregateResponsesSseToOpenAI(zenResp.raw, model), model, inputTokens));
      } catch (e) {
        const mapped = mapZenError(502, { message: e.message }, "anthropic");
        res.status(mapped.status).json(mapped.body);
      }
    }
    return;
  }

  if (stream) {
    const { body, options } = zenRequest(targetModel, messages, true, tools, undefined, sessionId);
    pipeZenAsAnthropic(options, body, model, res, inputTokens);
  } else {
    try {
      const zenResp = await executeWithRetry(async () => {
        const { body, options } = zenRequest(targetModel, messages, true, tools, undefined, sessionId);
        return collectZenSse(options, body);
      }, 1);

      if (zenResp.error || zenResp.status >= 400) {
        const mapped = mapZenError(zenResp.status, zenResp.error, "anthropic");
        return res.status(mapped.status).json(mapped.body);
      }
      res.json(openAIToAnthropic(aggregateSseToCompletion(zenResp.raw, model), model, inputTokens));
    } catch (e) {
      const mapped = mapZenError(502, { message: e.message }, "anthropic");
      res.status(mapped.status).json(mapped.body);
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: TUI_VERSION,
    proxy_version: `v${PROXY_VERSION}`,
    port: currentPort,
    models: ALL_MODELS.length,
    ocVersion: OC_VERSION,
    ua: `opencode/${OC_VERSION} ai-sdk/provider-utils/${AI_SDK_VER} runtime/bun/${BUN_VER}`,
    zenAuthMode: ZEN_AUTH_MODE,
    endpoints: [
      "/health",
      "/v1/models",
      "/v1/chat/completions",
      "/v1/messages",
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
      "/v1/messages",
    ],
  });
});

function renderBanner(port) {
  const localUrl = `http://localhost:${port}`;
  const networkUrl = `http://0.0.0.0:${port}`;

  const content = [
    `${pc.bold(pc.magenta("⚡ OCodeProxy"))} ${pc.dim(TUI_VERSION)}`,
    "",
    `${pc.bold("Status:")}    ${pc.green("● ONLINE")}`,
    `${pc.bold("Models:")}    ${pc.cyan(String(ALL_MODELS.length))} ${pc.dim("upstream models")}`,
    `${pc.bold("Local:")}     ${pc.cyan(localUrl)}`,
    `${pc.bold("Network:")}   ${pc.dim(networkUrl)}`,
    "",
    `${pc.bold("Endpoints:")}`,
    `  ${pc.green("GET")}   /health               ${pc.dim("→ Health & status check")}`,
    `  ${pc.green("GET")}   /v1/models            ${pc.dim("→ List models")}`,
    `  ${pc.cyan("POST")}  /v1/chat/completions  ${pc.dim("→ OpenAI chat format")}`,
    `  ${pc.cyan("POST")}  /v1/messages          ${pc.dim("→ Anthropic messages format")}`,
    ...(process.stdin.isTTY
      ? [
          "",
          `${pc.bold("Controls:")}`,
          `  ${pc.yellow("[s]")} ⚙️  Settings (hot-swap port, manage API keys)`,
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

function startServer(port) {
  const srv = app.listen(port, "0.0.0.0", () => {
    renderBanner(port);
  });

  srv.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(pc.red(`\n✖ Error: port ${port} is already in use.\n`));
      if (!isKeyListening && !process.stdin.isTTY) process.exit(1);
    } else {
      console.error(err);
    }
  });

  return srv;
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
  s.start(`Stopping server on port ${currentPort}...`);

  await new Promise((resolve) => currentServer.close(resolve));

  s.message(`Starting server on port ${newPort}...`);
  currentPort = newPort;
  currentServer = startServer(currentPort);

  s.stop(pc.green(`✔ Server switched to port ${newPort}!`));
}

async function openSettings() {
  pauseKeybindings();

  p.intro(pc.bgCyan(pc.black(" ⚙️ OCodeProxy Settings ")));

  let inSettings = true;
  while (inSettings) {
    const action = await p.select({
      message: "Settings menu:",
      options: [
        { value: "port", label: "Change / Hot-swap port", hint: `current: ${currentPort}` },
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
        message: "Are you sure you want to regenerate default keys? Existing keys will be replaced.",
        initialValue: false,
      });

      if (!p.isCancel(confirm) && confirm) {
        apiKeys = {
          admin: generateKeyString(),
          "user-default": generateKeyString(),
        };
        saveKeys();
        p.log.success(pc.green("✔ Default keys regenerated successfully:"));
        for (const [name, key] of Object.entries(apiKeys)) {
          p.log.message(`  ${pc.bold(name.padEnd(14))} ${pc.dim(key)}`);
        }
      }
    } else if (action === "list_keys") {
      p.log.info(pc.cyan(`Active API keys (${KEYS_FILE}):`));
      for (const [name, key] of Object.entries(apiKeys)) {
        p.log.message(`  ${pc.bold(name.padEnd(14))} ${pc.dim(key)}`);
      }
    }
  }

  p.outro(pc.dim("Proxy listening resumed."));
  setupKeybindings();
}

async function onKeypress(str, key) {
  if (!key) return;

  if ((key.ctrl && key.name === "c") || key.name === "q") {
    pauseKeybindings();
    console.log(pc.dim("\nStopping server..."));
    if (currentServer) {
      currentServer.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
  } else if (key.name === "s" || key.name === "p") {
    await openSettings();
  }
}

currentServer = startServer(currentPort);
setupKeybindings();
