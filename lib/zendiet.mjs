// OCodeProxy ZenDiet: Context Governor and Optimization Engine.
// Balances token usage, context pressure, cache prefix preservation,
// and agent semantic safety across Claude Code, OpenCode, and OpenAI protocols.

import {
  isTier0Block,
  isAlreadyCompacted,
  getActiveTurnRange,
  validateToolPairing,
} from "./zendiet/safety.mjs";

import {
  DEFAULT_CONTEXT_WINDOW,
  estimateRequestTokens,
  calculateContextPressure,
  assessCacheRisk,
} from "./zendiet/analyzer.mjs";

import { deduplicateToolResults } from "./zendiet/dedup.mjs";
import { classifyToolOutput } from "./zendiet/classifier.mjs";
import { stripTerminalNoise, reduceToolOutput } from "./zendiet/reducers.mjs";
import { slimToolDescriptions } from "./zendiet/tools.mjs";

export const ZEN_DIET_MODES = new Set(["off", "safe", "balanced", "aggressive"]);
// Single tool outputs above this size are reduced even in safe mode and
// even inside the protected active turn (huge-output emergency protection).
export const HUGE_TOOL_CHARS = 8000;
// Balanced mode also engages when any single tool output exceeds this size,
// so medium outputs are not ignored just because total pressure is low.
export const PER_OUTPUT_TRIGGER_CHARS = 2500;
export { estimateRequestTokens };

// Largest tool output length in a message array (OpenAI + Anthropic shapes).
function maxToolOutputChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let max = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg.content.length > max) max = msg.content.length;
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
        if (typeof b.content === "string") {
          if (b.content.length > max) max = b.content.length;
        } else if (Array.isArray(b.content)) {
          const joined = b.content.map((x) => x?.text || "").join("\n");
          if (joined.length > max) max = joined.length;
        }
      }
    }
  }
  return max;
}

// Detect agent client from headers, user-agent, or payload signatures.
export function detectClient(headers = {}, body = {}) {
  const ua = String(headers["user-agent"] || headers["User-Agent"] || "").toLowerCase();
  if (ua.includes("claude-code") || ua.includes("claudecode")) return "claude-code";
  if (ua.includes("opencode") || headers["x-opencode-client"]) return "opencode";
  if (ua.includes("cursor")) return "cursor";
  if (ua.includes("aider")) return "aider";

  // Check payload for Claude Code attribution header in system
  const sys = body?.system;
  if (typeof sys === "string" && (sys.includes("cc_version=") || sys.includes("x-anthropic-billing-header"))) {
    return "claude-code";
  }
  if (Array.isArray(sys)) {
    for (const b of sys) {
      const txt = typeof b === "string" ? b : (typeof b?.text === "string" ? b.text : "");
      if (txt.includes("cc_version=") || txt.includes("x-anthropic-billing-header")) return "claude-code";
    }
  }

  return "generic";
}

// Top-level optimization orchestrator for requests.
// Returns { request, changed, stats, decisions, warnings }.
export function optimizeContext(body, options = {}) {
  const mode = typeof options.mode === "string" && ZEN_DIET_MODES.has(options.mode)
    ? options.mode
    : "balanced";

  const contextWindow = Number.isInteger(options.contextWindow) && options.contextWindow > 0
    ? options.contextWindow
    : DEFAULT_CONTEXT_WINDOW;

  const client = typeof options.client === "string" && options.client
    ? options.client
    : detectClient(options.headers, body);

  const decisions = [];
  const warnings = [];

  if (!body || typeof body !== "object") {
    return {
      request: body,
      changed: false,
      stats: { originalTokens: 0, optimizedTokens: 0, savedTokens: 0, savedChars: 0 },
      decisions: ["request: empty or non-object"],
      warnings,
    };
  }

  if (mode === "off") {
    return {
      request: body,
      changed: false,
      stats: { originalTokens: 0, optimizedTokens: 0, savedTokens: 0, savedChars: 0 },
      decisions: ["mode: off -> noop"],
      warnings,
    };
  }

  const tokenBreakdown = estimateRequestTokens(body);
  const pressure = calculateContextPressure(tokenBreakdown.total, contextWindow);
  decisions.push(`client: ${client}`);
  decisions.push(`pressure: ${pressure.level} (${pressure.percentage}%, ${tokenBreakdown.total}/${pressure.usableTokens} tok)`);

  // Verify pairing safety
  const toolPairing = validateToolPairing(body.messages);
  if (toolPairing.totalCalls > 0 || toolPairing.totalResults > 0) {
    decisions.push(`safety: verified ${toolPairing.totalCalls} calls and ${toolPairing.totalResults} results`);
  }

  // Check active turn
  const activeTurn = getActiveTurnRange(body.messages);
  if (activeTurn.startIndex >= 0) {
    decisions.push(`protection: locked active turn (last ${activeTurn.count} messages)`);
  }

  let currentMessages = body.messages;
  let totalSavedChars = 0;
  let totalSavedTokens = 0;
  let changed = false;

  // Build tool name lookup from earlier calls
  const toolNameMap = new Map();
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.id && tc?.function?.name) toolNameMap.set(String(tc.id), String(tc.function.name));
        }
      }
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b?.type === "tool_use" && b?.id && b?.name) toolNameMap.set(String(b.id), String(b.name));
        }
      }
    }
  }

  // Deduplication step: collapse identical tool outputs
  const dedupResult = deduplicateToolResults(body.messages, {
    activeStartIndex: activeTurn.startIndex,
    protectActiveTurn: true,
  });

  if (dedupResult.changed) {
    const shouldBlockCache = options.strictCache && !assessCacheRisk(body, dedupResult.savedTokens, tokenBreakdown.total).allowOptimization;
    if (!shouldBlockCache) {
      currentMessages = dedupResult.messages;
      totalSavedChars += dedupResult.savedChars;
      totalSavedTokens += dedupResult.savedTokens;
      changed = true;
      decisions.push(`dedup: collapsed ${dedupResult.duplicatesCount} duplicate tool results, saved ~${dedupResult.savedTokens} tok`);
    } else {
      decisions.push(`cache: skipped dedup to preserve prompt cache`);
    }
  }

  // Tool-aware reduction step: clean noise and compress older verbose tool outputs
  // - Aggressive: always reduce older tools
  // - Balanced: reduce older tools when total tokens > 2000, pressure >= 0.10,
  //   or any single tool output is large enough to matter on its own
  // - Safe: only dedup and noise stripping, plus huge-output emergency below
  const biggestToolOutput = maxToolOutputChars(currentMessages);
  const shouldReduceTools =
    mode === "aggressive" ? true :
    mode === "balanced" ? (tokenBreakdown.total > 2000 || pressure.ratio >= 0.10 || biggestToolOutput > PER_OUTPUT_TRIGGER_CHARS) :
    false;

  const shouldStripNoise = mode !== "off";

  if (Array.isArray(currentMessages)) {
    let reducedCount = 0;
    const reducedMessages = currentMessages.map((msg, idx) => {
      if (!msg || typeof msg !== "object") return msg;
      // Never modify messages in the active turn
      if (idx >= activeTurn.startIndex) return msg;

      // OpenAI tool message: role === "tool"
      if (msg.role === "tool" && typeof msg.content === "string") {
        if (isAlreadyCompacted(msg.content)) return msg;
        const toolName = toolNameMap.get(String(msg.tool_call_id)) || msg.tool_call_id || "";
        let nextContent = msg.content;
        if (shouldReduceTools) {
          const type = classifyToolOutput(toolName, nextContent);
          nextContent = reduceToolOutput(nextContent, type);
        } else if (shouldStripNoise) {
          nextContent = stripTerminalNoise(nextContent);
        }
        const delta = msg.content.length - nextContent.length;
        if (delta > 0) {
          totalSavedChars += delta;
          totalSavedTokens += Math.ceil(delta / 4);
          reducedCount++;
          changed = true;
          return { ...msg, content: nextContent };
        }
      }

      // Anthropic tool_result blocks in content array
      if (Array.isArray(msg.content)) {
        let blockChanged = false;
        const newBlocks = msg.content.map((b) => {
          if (!b || typeof b !== "object" || b.type !== "tool_result") return b;
          let origText = "";
          let isTextArray = false;
          if (typeof b.content === "string") {
            origText = b.content;
          } else if (Array.isArray(b.content) && b.content.length > 0 && typeof b.content[0]?.text === "string") {
            origText = b.content.map((x) => x?.text || "").join("\n");
            isTextArray = true;
          } else {
            return b;
          }

          if (isAlreadyCompacted(origText)) return b;

          const toolName = toolNameMap.get(String(b.tool_use_id)) || b.tool_use_id || "";
          let nextContent = origText;
          if (shouldReduceTools) {
            const type = classifyToolOutput(toolName, nextContent);
            nextContent = reduceToolOutput(nextContent, type);
          } else if (shouldStripNoise) {
            nextContent = stripTerminalNoise(nextContent);
          }
          const delta = origText.length - nextContent.length;
          if (delta > 0) {
            totalSavedChars += delta;
            totalSavedTokens += Math.ceil(delta / 4);
            reducedCount++;
            blockChanged = true;
            changed = true;
            if (isTextArray) {
              return { ...b, content: [{ type: "text", text: nextContent }] };
            }
            return { ...b, content: nextContent };
          }
          return b;
        });
        if (blockChanged) return { ...msg, content: newBlocks };
      }

      return msg;
    });

    if (reducedCount > 0) {
      currentMessages = reducedMessages;
      decisions.push(`reduction: optimized ${reducedCount} older tool results`);
    }
  }

  // Huge-output emergency: a single massive tool result is reduced even inside
  // the protected active turn and even in safe mode. Reducers preserve failure
  // markers, diff hunks and test errors, so this never drops debug context.
  if (Array.isArray(currentMessages)) {
    let emergencyCount = 0;
    const emergencyMessages = currentMessages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      if (msg.role === "tool" && typeof msg.content === "string") {
        if (msg.content.length <= HUGE_TOOL_CHARS || isAlreadyCompacted(msg.content)) return msg;
        const toolName = toolNameMap.get(String(msg.tool_call_id)) || msg.tool_call_id || "";
        const nextContent = reduceToolOutput(msg.content, classifyToolOutput(toolName, msg.content));
        const delta = msg.content.length - nextContent.length;
        if (delta > 0) {
          totalSavedChars += delta;
          totalSavedTokens += Math.ceil(delta / 4);
          emergencyCount++;
          changed = true;
          return { ...msg, content: nextContent };
        }
        return msg;
      }
      if (Array.isArray(msg.content)) {
        let blockChanged = false;
        const newBlocks = msg.content.map((b) => {
          if (!b || typeof b !== "object" || b.type !== "tool_result") return b;
          let origText = "";
          let isTextArray = false;
          if (typeof b.content === "string") {
            origText = b.content;
          } else if (Array.isArray(b.content) && b.content.length > 0 && typeof b.content[0]?.text === "string") {
            origText = b.content.map((x) => x?.text || "").join("\n");
            isTextArray = true;
          } else {
            return b;
          }
          if (origText.length <= HUGE_TOOL_CHARS || isAlreadyCompacted(origText)) return b;
          const toolName = toolNameMap.get(String(b.tool_use_id)) || b.tool_use_id || "";
          const nextContent = reduceToolOutput(origText, classifyToolOutput(toolName, origText));
          const delta = origText.length - nextContent.length;
          if (delta > 0) {
            totalSavedChars += delta;
            totalSavedTokens += Math.ceil(delta / 4);
            emergencyCount++;
            blockChanged = true;
            changed = true;
            if (isTextArray) {
              return { ...b, content: [{ type: "text", text: nextContent }] };
            }
            return { ...b, content: nextContent };
          }
          return b;
        });
        if (blockChanged) return { ...msg, content: newBlocks };
      }
      return msg;
    });
    if (emergencyCount > 0) {
      currentMessages = emergencyMessages;
      decisions.push(`emergency: reduced ${emergencyCount} huge tool results`);
    }
  }

  // Experimental tool-description slimming (opt-in via options.toolSlim).
  // Names, parameters and schemas are never touched; tools are never dropped.
  let newTools = null;
  let savedToolTokens = 0;
  if (options.toolSlim === true && Array.isArray(body.tools) && body.tools.length > 0) {
    const slim = slimToolDescriptions(body.tools);
    if (slim.changed) {
      newTools = slim.tools;
      savedToolTokens = slim.savedTokens;
      totalSavedChars += slim.savedChars;
      totalSavedTokens += slim.savedTokens;
      changed = true;
      decisions.push(`toolslim: shortened ${slim.slimmedCount} tool descriptions, saved ~${slim.savedTokens} tok`);
    }
  }

  if (!changed && pressure.level === "low") {
    decisions.push("low pressure -> noop");
  }

  const finalBody = changed
    ? { ...body, messages: currentMessages, ...(newTools ? { tools: newTools } : {}) }
    : body;
  const optimizedTokens = Math.max(0, tokenBreakdown.total - totalSavedTokens);

  return {
    request: finalBody,
    changed,
    stats: {
      originalTokens: tokenBreakdown.total,
      optimizedTokens,
      savedTokens: totalSavedTokens,
      savedChars: totalSavedChars,
      savedToolTokens,
      pressure: pressure.ratio,
      pressureLevel: pressure.level,
    },
    decisions,
    warnings,
  };
}
