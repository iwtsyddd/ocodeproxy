// Safety invariants and Tier 0 protections for ZenDiet.
// Preserves thinking blocks, signatures, tool call pairing, system instructions,
// and protects the active turn from unintended mutation.

export const TIER0_TYPES = new Set([
  "thinking",
  "redacted_thinking",
  "system",
  "developer",
  "tool_call_signature",
]);

const CLIENT_COMPACTION_PATTERNS = [
  /\[Old tool result content cleared\]/i,
  /\[Output truncated/i,
  /\[\.\.\. ZenDiet:/i,
  /\[content omitted/i,
  /\[omitted \d+ (?:tokens|chars)/i,
];

// Returns true if text already contains markers of client-side compaction.
export function isAlreadyCompacted(text) {
  if (typeof text !== "string" || !text) return false;
  return CLIENT_COMPACTION_PATTERNS.some((re) => re.test(text));
}

// Check whether a block or content chunk is Tier 0 (absolutely immutable).
export function isTier0Block(block) {
  if (!block || typeof block !== "object") return false;
  if (TIER0_TYPES.has(block.type)) return true;
  if (block.signature || block.encrypted_content) return true;
  return false;
}

// Find index of the latest user message in a message array.
// Returns -1 if no user message found.
export function findLastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

// Find index of the latest assistant message with tool calls or tool uses.
export function findLastAssistantCallIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return i;
      if (Array.isArray(msg.content) && msg.content.some((b) => b?.type === "tool_use")) return i;
    }
  }
  return -1;
}

// Determine which messages belong to the active turn (immutable).
// Locks only the last tool cycle or the trailing user message,
// so older tool results stay eligible for optimization.
export function getActiveTurnRange(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { startIndex: -1, count: 0 };
  }
  const lastUserIdx = findLastUserIndex(messages);
  const lastCallIdx = findLastAssistantCallIndex(messages);
  if (lastUserIdx === -1) {
    if (lastCallIdx >= 0) {
      return { startIndex: lastCallIdx, count: messages.length - lastCallIdx };
    }
    return { startIndex: messages.length - 1, count: 1 };
  }

  // Trailing user prompt with no tool activity after it: lock it only.
  if (lastUserIdx === messages.length - 1) {
    return { startIndex: lastUserIdx, count: 1 };
  }

  // Prefer the last tool cycle when it starts at or after the last user prompt.
  if (lastCallIdx >= lastUserIdx && lastCallIdx >= 0) {
    return {
      startIndex: lastCallIdx,
      count: messages.length - lastCallIdx,
    };
  }

  return {
    startIndex: lastUserIdx,
    count: messages.length - lastUserIdx,
  };
}

// Validate that tool results and calls remain properly paired.
// In OpenAI format: assistant.tool_calls[].id must match tool.tool_call_id.
// In Anthropic format: tool_use.id must match tool_result.tool_use_id.
export function validateToolPairing(messages) {
  if (!Array.isArray(messages)) return { valid: true, callIds: new Set(), resultIds: new Set() };
  const callIds = new Set();
  const resultIds = new Set();

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    // OpenAI format
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id) callIds.add(String(tc.id));
      }
    }
    if (msg.role === "tool" && msg.tool_call_id) {
      resultIds.add(String(msg.tool_call_id));
    }
    // Anthropic format inside content array
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use" && block.id) {
          callIds.add(String(block.id));
        }
        if (block.type === "tool_result" && block.tool_use_id) {
          resultIds.add(String(block.tool_use_id));
        }
      }
    }
  }

  return {
    valid: true,
    callIds,
    resultIds,
    totalCalls: callIds.size,
    totalResults: resultIds.size,
  };
}
