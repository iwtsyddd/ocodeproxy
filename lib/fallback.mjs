import { isRetryableUpstreamStatus, retryAfterMs } from "./errors.mjs";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Buffered (non-stream) fallback across prebuilt attempts [{ body, options, model }].
// collectFn(options, body) must resolve { status, raw?, error?, headers? } or throw.
// Returns the result tagged with the serving model. Throws only when every
// attempt throws (last error wins); JSON error results are returned, not thrown.
export async function collectWithFallback(attempts, collectFn, opts = {}) {
  const list = Array.isArray(attempts) ? attempts.filter(Boolean) : [];
  if (!list.length) throw new Error("collectWithFallback requires at least one attempt");
  const fallbackDelayMs = Number.isFinite(opts.fallbackDelayMs) ? Math.max(0, opts.fallbackDelayMs) : 300;
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const hasNext = i + 1 < list.length;
    try {
      const resp = await collectFn(cur.options, cur.body);
      const failed = resp?.error || Number(resp?.status) >= 400;
      if (failed && hasNext && isRetryableUpstreamStatus(resp?.status)) {
        const sameModel = list[i + 1]?.model === cur.model;
        await sleep(sameModel ? retryAfterMs(resp?.headers, 500) : fallbackDelayMs);
        continue;
      }
      return { ...resp, model: cur.model };
    } catch (err) {
      if (err?.upstreamStarted) throw err;
      if (!hasNext) throw err;
      await sleep(fallbackDelayMs);
    }
  }
  throw new Error("collectWithFallback exhausted attempts");
}

// Streaming pre-stream failover. Call from a pipe's early JSON-error branch
// (before any bytes were sent) to switch to the next prebuilt attempt.
// Returns true when a retry was scheduled (caller must return without responding).
export function tryStreamFallback(extra, res, retry, opts = {}) {
  const idx = Number.isInteger(extra?.attemptIndex) ? extra.attemptIndex : 0;
  const list = Array.isArray(extra?.attempts) ? extra.attempts : [];
  if (res?.headersSent || res?.writableEnded) return false;
  if (idx + 1 >= list.length) return false;
  if (typeof retry !== "function") return false;
  const nxt = list[idx + 1];
  const delay = Number.isFinite(opts.fallbackDelayMs) ? Math.max(0, opts.fallbackDelayMs) : 300;
  const ex = { ...extra, attemptIndex: idx + 1 };
  setTimeout(() => retry(nxt, ex), delay);
  return true;
}
