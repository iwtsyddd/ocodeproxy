// Protocol repair for strict upstreams (OpenCode Zen providers).
// User-interrupted sessions leave orphan tool calls (tool_use / tool_calls /
// function_call without a matching result) and runs of consecutive user
// messages. Anthropic tolerates both, but strict OpenAI/Responses backends
// reject them with 400 invalid parameters. These helpers close orphans with
// explicit cancellation stubs and fold user runs, before diet/forwarding.

export const CANCELLED_TOOL_NOTICE = "[Tool execution was cancelled or rejected by user]";

// Collect tool_call ids issued by assistant messages (OpenAI chat shape).
function chatCallIds(messages) {
  const ids = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc && typeof tc.id === "string" && tc.id) ids.push(tc.id);
    }
  }
  return ids;
}

// Collect tool_call_ids answered by tool messages (OpenAI chat shape).
function chatResultIds(messages) {
  const ids = new Set();
  for (const m of messages) {
    if (m && typeof m === "object" && m.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id) {
      ids.add(m.tool_call_id);
    }
  }
  return ids;
}

// Insert cancellation stubs for orphan assistant tool calls, right after the
// issuing message. Returns the input array unchanged when there is nothing
// to repair.
export function closeOrphanToolCalls(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const answered = chatResultIds(messages);
  const orphans = new Set(chatCallIds(messages).filter((id) => !answered.has(id)));
  if (orphans.size === 0) return messages;

  const out = [];
  for (const m of messages) {
    out.push(m);
    if (!m || typeof m !== "object" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (tc && typeof tc.id === "string" && orphans.has(tc.id)) {
        orphans.delete(tc.id);
        out.push({ role: "tool", tool_call_id: tc.id, content: CANCELLED_TOOL_NOTICE });
      }
    }
  }
  return out;
}

// Fold runs of adjacent string-content user messages into one.
// Array-content messages break the run and are left untouched.
export function mergeConsecutiveUserMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let merged = false;
  const out = [];
  for (const m of messages) {
    const prev = out.length ? out[out.length - 1] : null;
    if (
      prev && typeof prev === "object" && prev.role === "user" && typeof prev.content === "string" &&
      m && typeof m === "object" && m.role === "user" && typeof m.content === "string"
    ) {
      merged = true;
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${m.content}` };
      continue;
    }
    out.push(m);
  }
  return merged ? out : messages;
}

// Full chat-shape repair: close orphans first, then fold user runs.
export function repairChatMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return mergeConsecutiveUserMessages(closeOrphanToolCalls(messages));
}

function responsesCallId(item) {
  if (!item || typeof item !== "object") return "";
  const id = item.call_id || item.id;
  return typeof id === "string" && id ? id : "";
}

// Insert cancellation outputs for orphan Responses function_call items.
export function closeOrphanFunctionCalls(items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const answered = new Set();
  for (const item of items) {
    if (item && typeof item === "object" && item.type === "function_call_output") {
      const id = responsesCallId(item);
      if (id) answered.add(id);
    }
  }
  const orphans = new Set();
  for (const item of items) {
    if (item && typeof item === "object" && item.type === "function_call") {
      const id = responsesCallId(item);
      if (id && !answered.has(id)) orphans.add(id);
    }
  }
  if (orphans.size === 0) return items;

  const out = [];
  for (const item of items) {
    out.push(item);
    if (item && typeof item === "object" && item.type === "function_call") {
      const id = responsesCallId(item);
      if (id && orphans.has(id)) {
        orphans.delete(id);
        out.push({ type: "function_call_output", call_id: id, output: CANCELLED_TOOL_NOTICE });
      }
    }
  }
  return out;
}

// Fold runs of adjacent plain user message items (string content only).
export function mergeConsecutiveUserInputs(items) {
  if (!Array.isArray(items) || items.length === 0) return items;
  let merged = false;
  const out = [];
  for (const item of items) {
    const prev = out.length ? out[out.length - 1] : null;
    if (
      prev && typeof prev === "object" && prev.role === "user" && typeof prev.content === "string" &&
      item && typeof item === "object" && item.role === "user" && typeof item.content === "string"
    ) {
      merged = true;
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${item.content}` };
      continue;
    }
    out.push(item);
  }
  return merged ? out : items;
}

// Full Responses-input repair. String input passes through untouched.
export function repairResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  return mergeConsecutiveUserInputs(closeOrphanFunctionCalls(input));
}
