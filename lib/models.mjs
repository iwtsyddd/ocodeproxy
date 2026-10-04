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
