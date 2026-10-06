export const DEFAULT_CHAT_MODELS = [
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

export const DEFAULT_RESPONSES_MODELS = [
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
];

export const MODEL_ALIASES = {
  "muse-spark-1.3-free": "muse-spark-1.3-contributor-free",
  "mimo-v2.6-flash": "mimo-v2.6-flash-free",
};

export const DISCONTINUED_MODELS = new Set([
  "jev-1.13-free",
  "deepseek-v4-flash-free",
  "deepseek-v4-flash",
]);

export const DEFAULT_MAX_CONSECUTIVE_SHRINKS = 3;
export const DEFAULT_SHRINK_TTL_MS = 60 * 60 * 1000; // 1 hour

const RESPONSES_PREFIX = "muse-spark";

// Claude Code model discovery keeps only ids containing "claude" or
// "anthropic" (case-insensitive). Our upstream free models do not match,
// so advertise canonical Claude aliases that resolve to real models.
export const CLAUDE_DISCOVERY_ALIASES = [
  "claude-sonnet-5-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-opus-4-8",
  "claude-opus-4-5",
  "claude-haiku-4-5",
];

export function isClaudeGatewayId(model) {
  return typeof model === "string" && /claude|anthropic/i.test(model);
}

export function resolveModel(model, aliases = MODEL_ALIASES) {
  return aliases[model] || model;
}

export function isModelDeprecated(model, discontinued = DISCONTINUED_MODELS, aliases = MODEL_ALIASES) {
  return discontinued.has(model) || discontinued.has(resolveModel(model, aliases));
}

export function isModelKnown(model, allModels, aliases = MODEL_ALIASES) {
  const resolved = resolveModel(model, aliases);
  return allModels.includes(model) || allModels.includes(resolved);
}

export function isModelResponses(model, responsesSet, aliases = MODEL_ALIASES) {
  return responsesSet.has(resolveModel(model, aliases));
}

// DISCONTINUED_MODELS stays authoritative for exclusions and models.dev
// `status` never filters. A live id is kept when the name matches
// (*free*/big-pickle) or when catalog metadata marks it free-by-cost
// (catches suffixless free models like grok-code). Metadata never adds
// discontinued ids and never removes name-matched ones.
export function partitionDiscovered(ids, discontinued = DISCONTINUED_MODELS, metaMap = null) {
  const freeIds = (ids || []).filter((id) => {
    if (typeof id !== "string" || !id) return false;
    if (discontinued.has(id)) return false;
    if (id.includes("free") || id === "big-pickle") return true;
    const meta = metaMap instanceof Map ? metaMap.get(id) : undefined;
    return !!(meta && meta.free === true);
  });
  const chat = [];
  const responses = [];
  for (const id of freeIds) {
    if (id.startsWith(RESPONSES_PREFIX)) responses.push(id);
    else chat.push(id);
  }
  return { chat, responses };
}

export function shouldKeepCurrent(current, discovered, options = {}) {
  const curChat = Array.isArray(current?.chat) ? current.chat : [];
  const curResp = Array.isArray(current?.responses) ? current.responses : [];
  const discChat = Array.isArray(discovered?.chat) ? discovered.chat : [];
  const discResp = Array.isArray(discovered?.responses) ? discovered.responses : [];

  const total = discChat.length + discResp.length;
  const have = curChat.length + curResp.length;

  let candidateReason = null;
  if (have > 0 && total < have) {
    candidateReason = "shrink";
  } else if (curChat.length > 0 && discChat.length === 0) {
    candidateReason = "empty-chat";
  } else if (curResp.length > 0 && discResp.length === 0) {
    candidateReason = "empty-responses";
  }

  const opts = options && typeof options === "object" ? options : {};
  const updateState = (c, f) => {
    if (opts && typeof opts === "object" && !Object.isFrozen(opts)) {
      opts.consecutive = c;
      opts.firstShrinkAt = f;
    }
  };

  if (!candidateReason) {
    updateState(0, 0);
    return { keep: false, reason: "ok" };
  }

  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const maxConsecutive =
    typeof opts.maxConsecutive === "number" && opts.maxConsecutive > 0
      ? opts.maxConsecutive
      : DEFAULT_MAX_CONSECUTIVE_SHRINKS;
  const ttlMs =
    typeof opts.ttlMs === "number" && opts.ttlMs >= 0
      ? opts.ttlMs
      : DEFAULT_SHRINK_TTL_MS;

  const currentConsecutive =
    typeof opts.consecutive === "number" && opts.consecutive >= 0
      ? opts.consecutive
      : 0;
  const nextConsecutive = currentConsecutive + 1;
  const effectiveFirstShrinkAt =
    typeof opts.firstShrinkAt === "number" && opts.firstShrinkAt > 0
      ? opts.firstShrinkAt
      : now;

  // Never drop the entire model catalog to empty unless explicitly permitted
  if (total === 0 && have > 0 && !opts.allowEmpty) {
    updateState(nextConsecutive, effectiveFirstShrinkAt);
    return {
      keep: true,
      reason: candidateReason || "empty",
      consecutive: nextConsecutive,
      firstShrinkAt: effectiveFirstShrinkAt,
    };
  }

  const hitConsecutive = nextConsecutive >= maxConsecutive;
  const hitTtl = ttlMs > 0 && effectiveFirstShrinkAt > 0 && (now - effectiveFirstShrinkAt) >= ttlMs;

  if (hitConsecutive || hitTtl) {
    updateState(0, 0);
    return {
      keep: false,
      reason: hitConsecutive ? "force-replace-consecutive" : "force-replace-ttl",
      forced: true,
      consecutive: 0,
      firstShrinkAt: 0,
    };
  }

  updateState(nextConsecutive, effectiveFirstShrinkAt);
  return {
    keep: true,
    reason: candidateReason,
    consecutive: nextConsecutive,
    firstShrinkAt: effectiveFirstShrinkAt,
  };
}

export function getFallbackModels(target, chat, responses, aliases = MODEL_ALIASES) {
  const resolved = resolveModel(target, aliases);
  const pool = Array.isArray(chat) ? chat : [];
  const respPool = Array.isArray(responses) ? responses : [];
  const sameFamily = respPool.includes(resolved) || respPool.includes(target) ? respPool : pool;
  return sameFamily.filter((id) => id !== target && id !== resolved);
}

// Build the upstream attempt chain: target first, then same-family fallbacks.
// Never repeats a model (no same-model retries that double-bill on error) and
// never exceeds maxAttempts, so maxAttempts=1 means exactly one attempt.
export function candidateModels(target, chat, responses, maxAttempts, aliases = MODEL_ALIASES) {
  if (typeof target !== "string" || !target) return [];
  const n = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  const seen = new Set();
  const out = [];
  for (const id of [target, ...getFallbackModels(target, chat, responses, aliases)]) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= n) break;
  }
  return out;
}

// Exact gateway aliases we advertise via /v1/models (Claude Code discovery
// keeps only ids containing "claude"/"anthropic"). Unknown bare ids that
// merely contain those substrings (e.g. "claude-sonnet-4-55") are typos and
// must 404 loudly instead of silently running on the fallback model.
export function isKnownGatewayAlias(model, gatewayIds = CLAUDE_DISCOVERY_ALIASES) {
  if (typeof model !== "string" || !model) return false;
  const list = Array.isArray(gatewayIds) ? gatewayIds : [];
  return list.includes(model);
}

// Provider-routed ids carry an explicit routing prefix ("bedrock/...",
// "vertex_ai/..."). Unlike bare typos they express real routing intent, so
// unknown ones still map to the fallback instead of 404.
export function isProviderRoutedId(model) {
  return typeof model === "string" && model.includes("/");
}

// Closest known id for "did you mean" 404 hints. Returns undefined when
// nothing is close enough or inputs are malformed.
export function suggestModelId(input, candidates) {
  if (typeof input !== "string" || !input) return undefined;
  const pool = Array.isArray(candidates) ? candidates.filter((c) => typeof c === "string" && c) : [];
  if (!pool.length) return undefined;
  const lowered = input.toLowerCase();
  let best;
  let bestDist = Infinity;
  for (const c of pool) {
    const d = editDistance(lowered, c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= 3 ? best : undefined;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[n];
}

// Resolve a client-requested model to a real upstream id. Known ids and
// aliases resolve normally. Unknown ids map to the fallback only when they
// are exact gateway aliases or provider-routed claude/anthropic ids;
// anything else (including bare claude/anthropic typos) passes through
// unresolved so routes answer 404 instead of running the wrong model.
export function resolveGatewayModel(model, allModels, fallbackModel, aliases = MODEL_ALIASES, gatewayIds = CLAUDE_DISCOVERY_ALIASES) {
  const resolved = resolveModel(model, aliases);
  const list = Array.isArray(allModels) ? allModels : [];
  if (list.includes(model) || list.includes(resolved)) return resolved;
  if (typeof fallbackModel === "string" && fallbackModel) {
    if (isKnownGatewayAlias(model, gatewayIds) || isKnownGatewayAlias(resolved, gatewayIds)) {
      return resolveModel(fallbackModel, aliases);
    }
    if (isClaudeGatewayId(model) && isProviderRoutedId(model)) {
      return resolveModel(fallbackModel, aliases);
    }
  }
  return resolved;
}

// Build the /v1/models discovery list: real ids plus canonical Claude
// aliases (deduped) so Claude Code's discovery filter keeps entries.
export function buildDiscoveryList(allModels) {
  const list = Array.isArray(allModels) ? [...allModels] : [];
  for (const alias of CLAUDE_DISCOVERY_ALIASES) {
    if (!list.includes(alias)) list.push(alias);
  }
  return list;
}
