import { ocId } from "./ids.mjs";
import {
  openAIContentToResponsesText,
  openAIContentToResponsesInput,
  anthropicImageToOpenAI,
  anthropicDocumentText,
  anthropicToolResultText,
  pickCacheControl,
} from "./content.mjs";

export const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];
export const DECOY_DESCRIPTION = "This tool is currently unavailable and must not be used.";

export function decoyTool(name) {
  return {
    type: "function",
    function: {
      name,
      description: DECOY_DESCRIPTION,
      parameters: { type: "object", properties: {} },
    },
  };
}

export function toolName(t) {
  return t?.function?.name || t?.name || "";
}

export function ensureFingerprintTools(tools) {
  const list = Array.isArray(tools) ? tools.filter((t) => toolName(t)) : [];
  const names = new Set(list.map(toolName));
  for (const name of FINGERPRINT_TOOLS) {
    if (!names.has(name)) list.push(decoyTool(name));
  }
  return list;
}

export function ensureAssistantReasoning(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (m && typeof m === "object" && m.role === "assistant" && typeof m.reasoning_content !== "string") {
      return { ...m, reasoning_content: "" };
    }
    return m;
  });
}

export function chatToResponses(targetModel, messages, tools, tool_choice) {
  let instructions = undefined;
  const input = [];

  for (const m of messages || []) {
    if (m.role === "system" || m.role === "developer") {
      const t = openAIContentToResponsesText(m.content);
      if (t) instructions = instructions ? instructions + "\n" + t : t;
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: openAIContentToResponsesText(m.content),
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const text = openAIContentToResponsesText(m.content);
      if (text) {
        input.push({ role: "assistant", content: [{ type: "output_text", text }] });
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
    if (m.role === "assistant") {
      const content = [];
      const text = openAIContentToResponsesText(m.content);
      if (text) content.push({ type: "output_text", text });
      if (typeof m.refusal === "string" && m.refusal) content.push({ type: "refusal", refusal: m.refusal });
      input.push({ role: "assistant", content: content.length ? content : [{ type: "output_text", text: "" }] });
    } else {
      input.push({ role: "user", content: openAIContentToResponsesInput(m.content) });
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

export function responsesToOpenAI(resp, requestedModel) {
  let text = "";
  let refusal = "";
  let reasoning = "";
  const annotations = [];
  const toolCalls = [];
  for (const item of resp?.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) {
          text += c.text;
          if (Array.isArray(c.annotations)) annotations.push(...c.annotations);
        } else if (c.type === "refusal" && c.refusal) {
          refusal += c.refusal;
        }
      }
    } else if (item.type === "reasoning") {
      for (const s of item.summary || []) {
        if (typeof s?.text === "string") reasoning += s.text;
      }
      if (typeof item.content === "string" && item.content) reasoning += item.content;
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || ocId("call"),
        type: "function",
        function: { name: item.name || "", arguments: item.arguments || "{}" },
      });
    }
  }

  let finishReason = "stop";
  if (toolCalls.length) {
    finishReason = "tool_calls";
  } else if (resp?.status === "incomplete") {
    const why = resp?.incomplete_details?.reason;
    finishReason = why === "max_output_tokens" ? "length" : why === "content_filter" ? "content_filter" : "stop";
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
        ...(refusal ? { refusal } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(annotations.length ? { annotations } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: resp?.usage?.input_tokens || 0,
      completion_tokens: resp?.usage?.output_tokens || 0,
      total_tokens: resp?.usage?.total_tokens || 0,
    },
  };
}

export function aggregateSseToCompletion(raw, model = "") {
  let id;
  let created;
  let outModel = model;
  let content = "";
  let reasoning = "";
  const toolCalls = {};
  let finish = "stop";

  let upstreamUsage = null;
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
    if (parsed.usage && typeof parsed.usage === "object") upstreamUsage = parsed.usage;
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
    usage: upstreamUsage ? {
      prompt_tokens: upstreamUsage.prompt_tokens ?? upstreamUsage.input_tokens ?? 0,
      completion_tokens: upstreamUsage.completion_tokens ?? upstreamUsage.output_tokens ?? 0,
      total_tokens: upstreamUsage.total_tokens ?? 0,
    } : {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function aggregateResponsesSseToOpenAI(raw, requestedModel) {
  let text = "";
  let refusal = "";
  let reasoning = "";
  const toolCalls = {};
  let upstreamUsage = null;
  let respStatus = null;
  let incompleteReason = null;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }
    if (ev.type === "response.output_text.delta" && ev.delta) {
      text += ev.delta;
    } else if ((ev.type === "response.reasoning_summary_text.delta" || ev.type === "response.reasoning_text.delta") && ev.delta) {
      reasoning += ev.delta;
    } else if (ev.type === "response.refusal.delta" && ev.delta) {
      refusal += ev.delta;
    } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
      const idx = Object.keys(toolCalls).length;
      toolCalls[ev.item.id] = { index: idx, id: ev.item.call_id || ev.item.id, name: ev.item.name || "", arguments: "" };
    } else if (ev.type === "response.function_call_arguments.delta" && ev.delta) {
      if (toolCalls[ev.item_id]) {
        toolCalls[ev.item_id].arguments += ev.delta;
      }
    } else if (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") {
      const resp = ev.response || {};
      if (resp.status) respStatus = resp.status;
      if (resp.incomplete_details?.reason) incompleteReason = resp.incomplete_details.reason;
      if (resp.usage && typeof resp.usage === "object") upstreamUsage = resp.usage;
    }
  }

  const calls = Object.values(toolCalls).map((tc) => ({
    id: tc.id,
    type: "function",
    function: { name: tc.name, arguments: tc.arguments || "{}" },
  }));

  let finishReason = "stop";
  if (calls.length) {
    finishReason = "tool_calls";
  } else if (respStatus === "incomplete") {
    finishReason = incompleteReason === "max_output_tokens" ? "length" : incompleteReason === "content_filter" ? "content_filter" : "stop";
  }

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
        ...(refusal ? { refusal } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: upstreamUsage ? {
      prompt_tokens: upstreamUsage.input_tokens ?? 0,
      completion_tokens: upstreamUsage.output_tokens ?? 0,
      total_tokens: upstreamUsage.total_tokens ?? 0,
    } : {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
    if (sys) {
      const sysMsg = { role: "system", content: sys };
      if (Array.isArray(body.system)) {
        for (const b of body.system) {
          const cc = pickCacheControl(b);
          if (cc) { sysMsg.cache_control = cc; break; }
        }
      }
      messages.push(sysMsg);
    }
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      const out = { role: msg.role, content: msg.content };
      const cc = pickCacheControl(msg);
      if (cc) out.cache_control = cc;
      messages.push(out);
    } else if (Array.isArray(msg.content)) {
      const textParts = [];
      const imageParts = [];
      const toolUses = [];
      const toolResults = [];
      let blockCacheControl;
      for (const b of msg.content) {
        if (!b || typeof b !== "object") continue;
        const cc = pickCacheControl(b);
        if (cc && !blockCacheControl) blockCacheControl = cc;
        if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
        else if (b.type === "image") {
          const img = anthropicImageToOpenAI(b);
          if (img) {
            if (cc) img.cache_control = cc;
            imageParts.push(img);
          }
        } else if (b.type === "document") {
          const t = anthropicDocumentText(b);
          if (t) textParts.push(t);
        } else if (b.type === "tool_use") toolUses.push(b);
        else if (b.type === "tool_result") toolResults.push(b);
      }
      const text = textParts.join("\n");
      if (toolUses.length && msg.role === "assistant") {
        const out = {
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        };
        if (blockCacheControl) out.cache_control = blockCacheControl;
        messages.push(out);
      } else if (toolResults.length) {
        if (text || imageParts.length) {
          if (imageParts.length) {
            const parts = [];
            if (text) {
              const tp = { type: "text", text };
              if (blockCacheControl) tp.cache_control = blockCacheControl;
              parts.push(tp);
            }
            parts.push(...imageParts);
            const out = { role: "user", content: parts };
            messages.push(out);
          } else {
            const out = { role: "user", content: text };
            if (blockCacheControl) out.cache_control = blockCacheControl;
            messages.push(out);
          }
        }
        for (const b of toolResults) {
          const out = { role: "tool", tool_call_id: b.tool_use_id, content: anthropicToolResultText(b) };
          const cc = pickCacheControl(b);
          if (cc) out.cache_control = cc;
          messages.push(out);
        }
      } else if (imageParts.length) {
        const parts = [];
        if (text) {
          const tp = { type: "text", text };
          if (blockCacheControl) tp.cache_control = blockCacheControl;
          parts.push(tp);
        }
        parts.push(...imageParts);
        messages.push({ role: msg.role, content: parts });
      } else {
        const out = { role: msg.role, content: text };
        if (blockCacheControl) out.cache_control = blockCacheControl;
        messages.push(out);
      }
    }
  }

  const tools = (body.tools || []).map((t) => {
    const out = {
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || {},
      },
    };
    const cc = pickCacheControl(t);
    if (cc) out.cache_control = cc;
    return out;
  });

  return { messages, tools: tools.length ? tools : undefined, params: anthropicParamsToChat(body) };
}

export function openAIToAnthropic(oaiResp, model, inputTokens) {
  let msgId = ocId("msg");
  const rawId = oaiResp?.id != null ? String(oaiResp.id) : "";
  if (rawId.startsWith("msg_")) {
    msgId = rawId;
  } else if (/^(chatcmpl[-_]|resp[-_]?)/.test(rawId)) {
    msgId = rawId.replace(/^(chatcmpl[-_]|resp[-_]?)/, "msg_");
  } else if (rawId) {
    msgId = `msg_${rawId}`;
  }
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (typeof choice.message?.reasoning_content === "string" && choice.message.reasoning_content) {
    content.push({ type: "thinking", thinking: choice.message.reasoning_content });
  }
  if (choice.message?.content) {
    const text = Array.isArray(choice.message.content)
      ? choice.message.content.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n")
      : choice.message.content;
    if (text) content.push({ type: "text", text });
  }
  if (typeof choice.message?.refusal === "string" && choice.message.refusal) {
    content.push({ type: "text", text: choice.message.refusal });
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

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "content_filter") stopReason = "refusal";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: msgId,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens ?? inputTokens ?? 0,
      output_tokens: oaiResp.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function responsesTextOf(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.text === "string" && (p.type === "input_text" || p.type === "output_text" || p.type === "text")) out.push(p.text);
  }
  return out.join("\n");
}

export function normalizeResponsesTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      if (t.type === "function" && typeof t.name === "string" && t.name) {
        return {
          type: "function",
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : {},
        };
      }
      const name = t.function?.name || t.name || "";
      if (!name) return null;
      return {
        type: "function",
        name,
        description: t.function?.description || t.description || "",
        parameters: t.function?.parameters || t.parameters || {},
      };
    })
    .filter(Boolean);
}

export function responsesInputToChatMessages(input, instructions) {
  const messages = [];
  if (typeof instructions === "string" && instructions) {
    messages.push({ role: "system", content: instructions });
  }
  const items = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || ocId("call"),
          type: "function",
          function: { name: item.name || "", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
        }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id || item.id || "", content: out });
      continue;
    }
    if (item.type === "message" && typeof item.role === "string") {
      const text = responsesTextOf(item.content);
      messages.push({ role: item.role === "assistant" ? "assistant" : "user", content: text || "" });
      continue;
    }
    if (item.role === "user") {
      if (typeof item.content === "string") {
        messages.push({ role: "user", content: item.content });
      } else if (Array.isArray(item.content)) {
        const text = responsesTextOf(item.content);
        const images = item.content
          .filter((p) => p && (p.type === "input_image" || p.type === "image_url"))
          .map((p) => {
            const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
            return url ? { type: "image_url", image_url: { url } } : null;
          })
          .filter(Boolean);
        if (images.length) {
          const parts = [];
          if (text) parts.push({ type: "text", text });
          parts.push(...images);
          messages.push({ role: "user", content: parts });
        } else {
          messages.push({ role: "user", content: text });
        }
      }
      continue;
    }
    if (item.role === "assistant") {
      const text = responsesTextOf(item.content);
      messages.push({ role: "assistant", content: text || null });
      continue;
    }
  }
  return messages;
}

export function chatCompletionToResponses(completion, requestedModel) {
  const choice = completion?.choices?.[0];
  const msg = choice?.message || {};
  const output = [];
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    output.push({ type: "reasoning", summary: [{ type: "summary_text", text: msg.reasoning_content }] });
  }
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p?.text || "").join("\n") : "";
  if (text) {
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  }
  for (const tc of msg.tool_calls || []) {
    if (FINGERPRINT_TOOLS.includes(tc.function?.name)) continue;
    output.push({
      type: "function_call",
      id: tc.id || ocId("fc"),
      call_id: tc.id || ocId("call"),
      name: tc.function?.name || "",
      arguments: tc.function?.arguments || "{}",
    });
  }
  if (!output.length) {
    output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] });
  }
  let status = "completed";
  if (choice?.finish_reason === "length") status = "incomplete";
  else if (choice?.finish_reason === "content_filter") status = "incomplete";
  return {
    id: completion?.id ? String(completion.id).replace(/^chatcmpl[-_]/, "resp_") : ocId("resp"),
    object: "response",
    created_at: completion?.created || Math.floor(Date.now() / 1000),
    model: requestedModel,
    output,
    status,
    usage: {
      input_tokens: completion?.usage?.prompt_tokens ?? 0,
      output_tokens: completion?.usage?.completion_tokens ?? 0,
      total_tokens: completion?.usage?.total_tokens ?? 0,
    },
  };
}

export function aggregateResponsesSseToResponses(raw, requestedModel) {
  const completion = aggregateResponsesSseToOpenAI(raw, requestedModel);
  return chatCompletionToResponses(completion, requestedModel);
}

function countTextTokens(s) {
  if (typeof s !== "string" || !s) return 0;
  return Math.ceil(s.length / 4);
}
export function estimateAnthropicTokens(body) {
  let tokens = 0;
  const b = body && typeof body === "object" ? body : {};
  const sys = b.system;
  if (typeof sys === "string") tokens += countTextTokens(sys);
  else if (Array.isArray(sys)) {
    for (const part of sys) {
      if (typeof part?.text === "string") tokens += countTextTokens(part.text);
    }
  }
  for (const msg of Array.isArray(b.messages) ? b.messages : []) {
    tokens += 4;
    const c = msg?.content;
    if (typeof c === "string") {
      tokens += countTextTokens(c);
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string") tokens += countTextTokens(block.text);
        else if (block.type === "image") tokens += 85;
        else if (block.type === "tool_use") tokens += countTextTokens(block.name || "") + countTextTokens(JSON.stringify(block.input ?? {}));
        else if (block.type === "tool_result") {
          tokens += 2;
          if (typeof block.content === "string") tokens += countTextTokens(block.content);
          else if (Array.isArray(block.content)) {
            for (const sub of block.content) {
              if (typeof sub?.text === "string") tokens += countTextTokens(sub.text);
            }
          }
        } else if (block.type === "document") tokens += countTextTokens(block.title || "") + 20;
      }
    }
  }
  if (Array.isArray(b.tools)) {
    tokens += 2;
    tokens += countTextTokens(JSON.stringify(b.tools));
  }
  return tokens;
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function asFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asPositiveInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function asStop(v) {
  if (typeof v === "string" && v) return v;
  if (Array.isArray(v) && v.length && v.every((s) => typeof s === "string" && s)) return v;
  return undefined;
}

// allowlist of OpenAI chat-completions sampling params; invalid values are dropped
export function pickChatParams(source) {
  const out = {};
  const s = source && typeof source === "object" ? source : {};
  const temperature = asFiniteNumber(s.temperature);
  if (temperature !== undefined && temperature >= 0 && temperature <= 2) out.temperature = temperature;
  const topP = asFiniteNumber(s.top_p);
  if (topP !== undefined && topP >= 0 && topP <= 1) out.top_p = topP;
  const maxTokens = asPositiveInt(s.max_tokens);
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  const maxCompletion = asPositiveInt(s.max_completion_tokens);
  if (maxCompletion !== undefined) out.max_completion_tokens = maxCompletion;
  const stop = asStop(s.stop);
  if (stop !== undefined) out.stop = stop;
  const presence = asFiniteNumber(s.presence_penalty);
  if (presence !== undefined && presence >= -2 && presence <= 2) out.presence_penalty = presence;
  const frequency = asFiniteNumber(s.frequency_penalty);
  if (frequency !== undefined && frequency >= -2 && frequency <= 2) out.frequency_penalty = frequency;
  const seed = asPositiveInt(s.seed);
  if (seed !== undefined) out.seed = seed;
  if (typeof s.reasoning_effort === "string" && REASONING_EFFORTS.has(s.reasoning_effort)) {
    out.reasoning_effort = s.reasoning_effort;
  }
  if (typeof s.parallel_tool_calls === "boolean") out.parallel_tool_calls = s.parallel_tool_calls;
  return out;
}

// allowlist of OpenAI Responses sampling params; max_tokens is accepted as alias
export function pickResponsesParams(source) {
  const out = {};
  const s = source && typeof source === "object" ? source : {};
  const temperature = asFiniteNumber(s.temperature);
  if (temperature !== undefined && temperature >= 0 && temperature <= 2) out.temperature = temperature;
  const topP = asFiniteNumber(s.top_p);
  if (topP !== undefined && topP >= 0 && topP <= 1) out.top_p = topP;
  const maxOut = asPositiveInt(s.max_output_tokens) ?? asPositiveInt(s.max_tokens) ?? asPositiveInt(s.max_completion_tokens);
  if (maxOut !== undefined) out.max_output_tokens = maxOut;
  if (s.truncation === "auto" || s.truncation === "disabled") out.truncation = s.truncation;
  if (s.reasoning && typeof s.reasoning === "object" && !Array.isArray(s.reasoning)) {
    const r = {};
    if (typeof s.reasoning.effort === "string" && REASONING_EFFORTS.has(s.reasoning.effort)) r.effort = s.reasoning.effort;
    if (typeof s.reasoning.summary === "string" && ["auto", "concise", "detailed"].includes(s.reasoning.summary)) r.summary = s.reasoning.summary;
    if (Object.keys(r).length) out.reasoning = r;
  } else if (typeof s.reasoning_effort === "string" && REASONING_EFFORTS.has(s.reasoning_effort)) {
    out.reasoning = { effort: s.reasoning_effort };
  }
  if (typeof s.parallel_tool_calls === "boolean") out.parallel_tool_calls = s.parallel_tool_calls;
  return out;
}

// map chat-style params (OpenAI chat / Anthropic) onto Responses upstream fields
export function chatParamsToResponsesParams(source) {
  const chat = pickChatParams(source);
  const out = {};
  if (chat.temperature !== undefined) out.temperature = chat.temperature;
  if (chat.top_p !== undefined) out.top_p = chat.top_p;
  const maxOut = chat.max_completion_tokens ?? chat.max_tokens;
  if (maxOut !== undefined) out.max_output_tokens = maxOut;
  if (chat.reasoning_effort !== undefined) out.reasoning = { effort: chat.reasoning_effort };
  if (chat.parallel_tool_calls !== undefined) out.parallel_tool_calls = chat.parallel_tool_calls;
  return out;
}

// map Anthropic sampling fields onto OpenAI chat params (top_k has no equivalent and is dropped)
export function anthropicParamsToChat(source) {
  const s = source && typeof source === "object" ? source : {};
  const mapped = {};
  if (s.max_tokens !== undefined) mapped.max_tokens = s.max_tokens;
  if (s.temperature !== undefined) mapped.temperature = s.temperature;
  if (s.top_p !== undefined) mapped.top_p = s.top_p;
  if (s.stop_sequences !== undefined) mapped.stop = s.stop_sequences;
  if (s.reasoning_effort !== undefined) mapped.reasoning_effort = s.reasoning_effort;
  return pickChatParams(mapped);
}
