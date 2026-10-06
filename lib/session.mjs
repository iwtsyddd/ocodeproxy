import { ocId } from "./ids.mjs";

export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_SESSION_MAX_ENTRIES = 1000;
export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function resolveSessionTtlMs(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : raw;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_TTL_MS;
}

export function resolveSessionMaxEntries(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : raw;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SESSION_MAX_ENTRIES;
}

export const resolveTtlMs = resolveSessionTtlMs;
export const resolveMaxEntries = resolveSessionMaxEntries;

// Bounded per-user session store. Reuses the session id while it is younger
// than ttlMs (absolute expiry from creation), then rotates it. A Map keeps
// insertion order for LRU eviction: hits refresh recency without extending
// expiry, and inserts past the cap evict the oldest entry. sweep() drops
// expired entries so idle keys cannot accumulate between accesses.
export function createSessionStore(opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const ttlMs = resolveSessionTtlMs(options.ttlMs);
  const maxEntries = resolveSessionMaxEntries(options.maxEntries);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const makeId = typeof options.makeId === "function" ? options.makeId : () => ocId("ses");
  const entries = new Map();

  function get(user) {
    if (typeof user !== "string" || !user.trim()) return makeId();
    const t = now();
    const hit = entries.get(user);
    if (hit && t - hit.ts <= ttlMs) {
      entries.delete(user);
      entries.set(user, hit);
      return hit.id;
    }
    if (hit) entries.delete(user);
    const entry = { id: makeId(), ts: t };
    entries.set(user, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return entry.id;
  }

  function peek(user) {
    if (typeof user !== "string" || !user.trim()) return undefined;
    const hit = entries.get(user);
    if (!hit) return undefined;
    if (now() - hit.ts > ttlMs) return undefined;
    return hit.id;
  }

  function has(user) {
    return peek(user) !== undefined;
  }

  function sweep(at) {
    const t = typeof at === "number" && Number.isFinite(at) ? at : now();
    let removed = 0;
    for (const [user, entry] of entries) {
      if (t - entry.ts > ttlMs) {
        entries.delete(user);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    get,
    peek,
    has,
    sweep,
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}
