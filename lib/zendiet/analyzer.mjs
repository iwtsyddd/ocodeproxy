// Context analyzer and pressure calculator for ZenDiet.
// Measures token distribution, evaluates context window pressure,
// and assesses cache preservation risk.

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_RESERVE_TOKENS = 8_192;
export const MIN_SAVINGS_TOKENS = 3_000;
export const MIN_SAVINGS_RATIO = 0.05;

// Estimate token count for a text string using 4 chars/token heuristic.
export function countCharsTokens(str) {
  if (typeof str !== "string" || !str) return 0;
  return Math.ceil(str.length / 4);
}

// Estimate tokens for any request body (Anthropic or OpenAI format).
// Returns breakdown by category: system, messages, tools, toolResults, reasoning.
export function estimateRequestTokens(body) {
  const breakdown = {
    total: 0,
    system: 0,
    messages: 0,
    tools: 0,
    toolResults: 0,
    reasoning: 0,
  };
  if (!body || typeof body !== "object") return breakdown;

  // System instructions
  if (typeof body.system === "string") {
    breakdown.system += countCharsTokens(body.system);
  } else if (Array.isArray(body.system)) {
    for (const part of body.system) {
      if (typeof part?.text === "string") breakdown.system += countCharsTokens(part.text);
      else if (typeof part === "string") breakdown.system += countCharsTokens(part);
    }
  }

  // Tools definitions
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    try {
      breakdown.tools += countCharsTokens(JSON.stringify(body.tools));
    } catch {}
  }

  // Messages array
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      // Per-message framing overhead
      breakdown.messages += 4;

      if (msg.role === "system" || msg.role === "developer") {
        const sysTok = typeof msg.content === "string" ? countCharsTokens(msg.content) : 0;
        breakdown.system += sysTok;
        continue;
      }

      if (msg.role === "tool") {
        const resTok = typeof msg.content === "string" ? countCharsTokens(msg.content) : countCharsTokens(JSON.stringify(msg.content ?? ""));
        breakdown.toolResults += resTok;
        continue;
      }

      if (typeof msg.content === "string") {
        breakdown.messages += countCharsTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            breakdown.messages += countCharsTokens(block.text);
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            const thinkTok = typeof block.thinking === "string" ? countCharsTokens(block.thinking) : 0;
            breakdown.reasoning += thinkTok;
          } else if (block.type === "tool_result") {
            const resTok = typeof block.content === "string"
              ? countCharsTokens(block.content)
              : countCharsTokens(JSON.stringify(block.content ?? ""));
            breakdown.toolResults += resTok;
          } else if (block.type === "tool_use") {
            const useTok = countCharsTokens(block.name || "") + countCharsTokens(JSON.stringify(block.input ?? {}));
            breakdown.messages += useTok;
          } else if (block.type === "image") {
            breakdown.messages += 85;
          }
        }
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const callTok = countCharsTokens(tc?.function?.name || "") + countCharsTokens(tc?.function?.arguments || "");
          breakdown.messages += callTok;
        }
      }
    }
  }

  breakdown.total = breakdown.system + breakdown.messages + breakdown.tools + breakdown.toolResults + breakdown.reasoning;
  return breakdown;
}

// Calculate context pressure based on total tokens and model context window.
export function calculateContextPressure(totalTokens, contextWindow = DEFAULT_CONTEXT_WINDOW, options = {}) {
  const win = Number.isInteger(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const reserve = Number.isInteger(options.reserveTokens) && options.reserveTokens >= 0 ? options.reserveTokens : DEFAULT_RESERVE_TOKENS;
  const usable = Math.max(win - reserve, 1000);
  const ratio = Math.max(0, totalTokens / usable);

  let level = "low";
  let action = "noop";

  if (ratio >= 0.85) {
    level = "critical";
    action = "emergency";
  } else if (ratio >= 0.70) {
    level = "high";
    action = "balanced";
  } else if (ratio >= 0.55) {
    level = "moderate";
    action = "light";
  }

  return {
    totalTokens,
    contextWindow: win,
    reserveTokens: reserve,
    usableTokens: usable,
    ratio: Math.round(ratio * 1000) / 1000,
    percentage: Math.round(ratio * 100),
    level,
    action,
  };
}

// Detect whether the request carries explicit prompt cache directives.
export function hasCacheDirectives(body) {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body.system)) {
    if (body.system.some((b) => b?.cache_control)) return true;
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg?.cache_control) return true;
      if (Array.isArray(msg.content)) {
        if (msg.content.some((b) => b?.cache_control)) return true;
      }
    }
  }
  if (Array.isArray(body.tools)) {
    if (body.tools.some((t) => t?.cache_control)) return true;
  }
  return false;
}

// Assess cache risk: changing early context breaks prompt cache prefix.
// If savings are minor (<3k tokens or <5%), do not risk invalidating cache.
export function assessCacheRisk(body, candidateSavingsTokens, totalTokens) {
  const hasCache = hasCacheDirectives(body);
  if (!hasCache) {
    return { hasCache: false, risk: "low", allowOptimization: true, reason: "no_cache_directives" };
  }
  const minTokens = MIN_SAVINGS_TOKENS;
  const minRatio = MIN_SAVINGS_RATIO;
  const relativeSavings = totalTokens > 0 ? candidateSavingsTokens / totalTokens : 0;

  if (candidateSavingsTokens < minTokens && relativeSavings < minRatio) {
    return {
      hasCache: true,
      risk: "high",
      allowOptimization: false,
      reason: "savings_too_small_to_risk_cache",
      candidateSavingsTokens,
      relativeSavings: Math.round(relativeSavings * 1000) / 1000,
    };
  }

  return {
    hasCache: true,
    risk: "acceptable",
    allowOptimization: true,
    reason: "savings_exceed_cache_threshold",
    candidateSavingsTokens,
    relativeSavings: Math.round(relativeSavings * 1000) / 1000,
  };
}
