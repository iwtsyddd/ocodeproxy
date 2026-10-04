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

export function partitionDiscovered(ids, discontinued = DISCONTINUED_MODELS) {
  const freeIds = (ids || []).filter(
    (id) => typeof id === "string" && id && (id.includes("free") || id === "big-pickle") && !discontinued.has(id)
  );
  const chat = [];
  const responses = [];
  for (const id of freeIds) {
    if (id.startsWith(RESPONSES_PREFIX)) responses.push(id);
    else chat.push(id);
  }
  return { chat, responses };
}

export function shouldKeepCurrent(current, discovered) {
  const total = discovered.chat.length + discovered.responses.length;
  const have = current.chat.length + current.responses.length;
  if (have > 0 && total < have) return { keep: true, reason: "shrink" };
  if (current.chat.length > 0 && discovered.chat.length === 0) return { keep: true, reason: "empty-chat" };
  if (current.responses.length > 0 && discovered.responses.length === 0) return { keep: true, reason: "empty-responses" };
  return { keep: false, reason: "ok" };
}

export function getFallbackModels(target, chat, responses, aliases = MODEL_ALIASES) {
  const resolved = resolveModel(target, aliases);
  const pool = Array.isArray(chat) ? chat : [];
  const respPool = Array.isArray(responses) ? responses : [];
  const sameFamily = respPool.includes(resolved) || respPool.includes(target) ? respPool : pool;
  return sameFamily.filter((id) => id !== target && id !== resolved);
}

// Resolve a client-requested model to a real upstream id. Known ids and
// aliases resolve normally. Unknown ids containing "claude"/"anthropic"
// (Claude Code default models, provider-prefixed ids like
// "bedrock/anthropic.claude-..." or gateway aliases) map to the fallback
// model instead of 404. Anything else passes through unresolved.
export function resolveGatewayModel(model, allModels, fallbackModel, aliases = MODEL_ALIASES) {
  const resolved = resolveModel(model, aliases);
  const list = Array.isArray(allModels) ? allModels : [];
  if (list.includes(model) || list.includes(resolved)) return resolved;
  if (isClaudeGatewayId(model) && typeof fallbackModel === "string" && fallbackModel) {
    return resolveModel(fallbackModel, aliases);
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
