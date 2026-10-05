// Tool result deduplication engine for ZenDiet.
// Hashes tool execution outputs with sha256. When the same output appears
// multiple times in a conversation (e.g. repeated file reads, identical diffs,
// repeated command runs), subsequent occurrences are replaced with compact
// references to the earlier result.

import crypto from "node:crypto";
import { isAlreadyCompacted } from "./safety.mjs";
import { stripAnsi } from "./reducers.mjs";

export const MIN_DEDUP_CHARS = 120;

// Compute hex SHA-256 hash of a string.
export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Normalize output before hashing so results differing only in terminal
// escape codes, carriage-return rewrites or trailing whitespace still match.
export function normalizeForHash(text) {
  const noAnsi = stripAnsi(text);
  return noAnsi
    .split("\n")
    .map((line) => {
      const segs = line.split("\r").filter(Boolean);
      const last = segs.length ? segs[segs.length - 1] : "";
      return last.replace(/[ \t]+$/g, "");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Extract plain text from an Anthropic tool_result block (string or text array).
function anthropicResultText(block) {
  if (typeof block.content === "string") return { text: block.content, isTextArray: false };
  if (Array.isArray(block.content)) {
    const parts = block.content.filter((x) => x && typeof x.text === "string").map((x) => x.text);
    if (parts.length > 0) return { text: parts.join("\n"), isTextArray: true };
  }
  return { text: "", isTextArray: false };
}
// Format the compact duplicate replacement placeholder.
export function formatDuplicateNotice(originalRef, hashShort, originalChars) {
  const refPart = originalRef ? ` #${originalRef}` : "";
  return `[ZenDiet: duplicate of tool result${refPart} (sha256: ${hashShort}, ${originalChars} chars)]`;
}

// Deduplicate tool results across a message array.
// Supports both OpenAI { role: "tool", content } and Anthropic { type: "tool_result", content }.
// Returns { messages, changed, duplicatesCount, savedChars, savedTokens, records }.
export function deduplicateToolResults(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages,
      changed: false,
      duplicatesCount: 0,
      savedChars: 0,
      savedTokens: 0,
      records: [],
    };
  }

  const minChars = Number.isInteger(options.minChars) && options.minChars >= 0
    ? options.minChars
    : MIN_DEDUP_CHARS;

  const protectActiveTurn = options.protectActiveTurn !== false;
  const activeStartIndex = Number.isInteger(options.activeStartIndex)
    ? options.activeStartIndex
    : (protectActiveTurn ? messages.length - 1 : Infinity);

  // Map of hash -> { refId, chars }
  const seenOutputs = new Map();
  const records = [];
  let duplicatesCount = 0;
  let savedChars = 0;

  let toolSeq = 0;
  let anyModified = false;

  const newMessages = messages.map((msg, msgIdx) => {
    if (!msg || typeof msg !== "object") return msg;

    // Skip messages in the protected active turn
    const isProtected = protectActiveTurn && msgIdx >= activeStartIndex;

    // Case 1: OpenAI tool message { role: "tool", tool_call_id, content }
    if (msg.role === "tool") {
      toolSeq++;
      const currentToolId = msg.tool_call_id || String(toolSeq);
      const text = typeof msg.content === "string" ? msg.content : "";

      if (text.length >= minChars && !isAlreadyCompacted(text)) {
        const hash = sha256(normalizeForHash(text));
        if (seenOutputs.has(hash)) {
          if (!isProtected) {
            const first = seenOutputs.get(hash);
            const notice = formatDuplicateNotice(first.refId, hash.slice(0, 12), text.length);
            const delta = text.length - notice.length;
            if (delta > 0) {
              savedChars += delta;
              duplicatesCount++;
              anyModified = true;
              records.push({
                msgIndex: msgIdx,
                toolId: currentToolId,
                firstRefId: first.refId,
                originalLength: text.length,
                savedChars: delta,
                hash: hash.slice(0, 12),
              });
              return { ...msg, content: notice };
            }
          }
        } else {
          seenOutputs.set(hash, { refId: currentToolId, chars: text.length });
        }
      }
      return msg;
    }

    // Case 2: Anthropic message with content array containing tool_result blocks
    if (Array.isArray(msg.content)) {
      let contentModified = false;
      const newContent = msg.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        if (block.type !== "tool_result") return block;

        toolSeq++;
        const currentToolId = block.tool_use_id || String(toolSeq);
        const { text, isTextArray } = anthropicResultText(block);

        if (text.length >= minChars && !isAlreadyCompacted(text)) {
          const hash = sha256(normalizeForHash(text));
          if (seenOutputs.has(hash)) {
            if (!isProtected) {
              const first = seenOutputs.get(hash);
              const notice = formatDuplicateNotice(first.refId, hash.slice(0, 12), text.length);
              const delta = text.length - notice.length;
              if (delta > 0) {
                savedChars += delta;
                duplicatesCount++;
                contentModified = true;
                records.push({
                  msgIndex: msgIdx,
                  toolId: currentToolId,
                  firstRefId: first.refId,
                  originalLength: text.length,
                  savedChars: delta,
                  hash: hash.slice(0, 12),
                });
                if (isTextArray) {
                  return { ...block, content: [{ type: "text", text: notice }] };
                }
                return { ...block, content: notice };
              }
            }
          } else {
            seenOutputs.set(hash, { refId: currentToolId, chars: text.length });
          }
        }
        return block;
      });

      if (contentModified) {
        anyModified = true;
        return { ...msg, content: newContent };
      }
      return msg;
    }

    return msg;
  });

  return {
    messages: anyModified ? newMessages : messages,
    changed: anyModified,
    duplicatesCount,
    savedChars,
    savedTokens: Math.ceil(savedChars / 4),
    records,
  };
}
