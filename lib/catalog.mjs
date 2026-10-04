// Catalog metadata sidecar for Zen models, sourced from the models.dev
// opencode provider entry. Zen /v1/models stays the source of truth for
// which ids exist and DISCONTINUED_MODELS stays authoritative for
// exclusions; models.dev only enriches live ids with catalog metadata
// (context window, output limit, description, capabilities). Name-based
// filtering in partitionDiscovered remains the fallback when metadata is
// missing (new model, fetch failure, disabled via env).

export const MODELS_DEV_DEFAULT_URL = "https://models.dev/api.json";
export const MODELS_DEV_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MODELS_DEV_DEFAULT_FILE = "./models-meta.json";

// A model counts as free only on an explicit all-zero price. Absent cost
// means unknown, never free (models.dev omits prices it does not know).
export function isFreeByCost(entry) {
  const cost = entry && typeof entry === "object" ? entry.cost : undefined;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return false;
  return cost.input === 0 && cost.output === 0;
}

// Extract the fields the gateway serves from one models.dev model entry.
// Missing limit/cost sections yield undefined fields, never a throw.
// `status` (e.g. "deprecated") is informational only: models.dev marks
// models deprecated that Zen still serves, so it must not filter.
export function extractModelMeta(id, entry) {
  if (typeof id !== "string" || !id) return null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const limit = entry.limit && typeof entry.limit === "object" && !Array.isArray(entry.limit)
    ? entry.limit
    : {};
  const modalities = entry.modalities && typeof entry.modalities === "object" && !Array.isArray(entry.modalities)
    ? entry.modalities
    : {};
  const provider = entry.provider && typeof entry.provider === "object" && !Array.isArray(entry.provider)
    ? entry.provider
    : {};
  const meta = { id };
  if (typeof entry.name === "string" && entry.name) meta.name = entry.name;
  if (typeof entry.description === "string" && entry.description) meta.description = entry.description;
  if (typeof entry.family === "string" && entry.family) meta.family = entry.family;
  if (Number.isInteger(limit.context) && limit.context > 0) meta.contextWindow = limit.context;
  if (Number.isInteger(limit.output) && limit.output > 0) meta.maxOutputTokens = limit.output;
  if (typeof entry.tool_call === "boolean") meta.toolCall = entry.tool_call;
  if (typeof entry.reasoning === "boolean") meta.reasoning = entry.reasoning;
  if (typeof entry.attachment === "boolean") meta.attachment = entry.attachment;
  if (Array.isArray(modalities.input)) meta.inputModalities = modalities.input.filter((m) => typeof m === "string");
  if (Array.isArray(modalities.output)) meta.outputModalities = modalities.output.filter((m) => typeof m === "string");
  if (typeof provider.npm === "string" && provider.npm) meta.providerNpm = provider.npm;
  if (typeof entry.status === "string" && entry.status) meta.status = entry.status;
  meta.free = isFreeByCost(entry);
  return meta;
}

// Parse a models.dev api.json payload into Map<id, meta> for the opencode
// provider. Only free-by-cost entries are kept (paid catalog is irrelevant
// to this gateway). Malformed payloads yield an empty map, never a throw.
export function parseModelsDevCatalog(payload) {
  const out = new Map();
  const provider = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.opencode
    : undefined;
  const models = provider && typeof provider === "object" && !Array.isArray(provider)
    ? provider.models
    : undefined;
  if (!models || typeof models !== "object" || Array.isArray(models)) return out;
  for (const id of Object.keys(models)) {
    const entry = models[id];
    if (!isFreeByCost(entry)) continue;
    const meta = extractModelMeta(id, entry);
    if (meta) out.set(id, meta);
  }
  return out;
}

// Serialize a metadata map for the disk cache (models-meta.json).
export function serializeMetaMap(metaMap) {
  const obj = {};
  if (metaMap instanceof Map) {
    for (const [id, meta] of metaMap) {
      if (meta && typeof meta === "object") obj[id] = meta;
    }
  }
  return { fetchedAt: new Date().toISOString(), meta: obj };
}

// Restore a metadata map from a parsed disk-cache payload.
export function deserializeMetaMap(payload) {
  const out = new Map();
  const obj = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.meta
    : undefined;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const id of Object.keys(obj)) {
    const meta = obj[id];
    if (meta && typeof meta === "object" && !Array.isArray(meta)) out.set(id, { id, ...meta });
  }
  return out;
}

// Metadata lookup for a served id. Claude discovery aliases are not real
// upstream ids, so they inherit the fallback model's numbers instead of
// serving bare entries.
export function metaForId(id, metaMap, fallbackId) {
  const map = metaMap instanceof Map ? metaMap : new Map();
  if (map.has(id)) return map.get(id);
  if (typeof fallbackId === "string" && fallbackId && map.has(fallbackId)) {
    return { ...map.get(fallbackId), id, aliasFor: fallbackId };
  }
  return undefined;
}

// Supplementary Responses-route signal from models.dev provider metadata.
// The gateway's muse-spark prefix rule stays primary; this only corroborates.
// Returns true/false when the npm package is known, undefined otherwise.
export function isResponsesByNpm(meta) {
  const npm = meta && typeof meta === "object" ? meta.providerNpm : undefined;
  if (npm === "@ai-sdk/openai") return true;
  if (typeof npm === "string" && npm) return false;
  return undefined;
}
