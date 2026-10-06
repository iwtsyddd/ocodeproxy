import { isRetryableUpstreamStatus, retryAfterMs } from "./errors.mjs";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Buffered (non-stream) fallback across attempts [{ body, options, model }].
// Attempts may be lazy (see lazyAttempt): body/options build on first access,
// so only visited models pay the clone + stringify cost.
// collectFn(options, body, model) must resolve { status, raw?, completion?, error?, headers? } or throw.
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
      const resp = await collectFn(cur.options, cur.body, cur.model);
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

// Lazily built fallback attempt. build() must return { body, options } and
// runs only on first body/options access, then cached. Keeps large request
// bodies (10MB messages x N models) from cloning + stringifying upfront:
// only the served attempt pays the cost, fallbacks build on demand.
export function lazyAttempt(model, build) {
  if (typeof build !== "function") throw new TypeError("lazyAttempt requires a build function");
  let cached = null;
  const ensure = () => {
    if (!cached) cached = build();
    return cached;
  };
  return {
    model,
    get body() {
      return ensure().body;
    },
    get options() {
      return ensure().options;
    },
  };
}

// True when the client connection is already gone (finished, destroyed or
// closed). Firing an upstream retry in that state burns tokens into the void.
export function isClientGone(res) {
  if (!res || typeof res !== "object") return true;
  return Boolean(res.writableEnded || res.destroyed || res.closed || res.socket?.destroyed);
}

// Tear down a client stream after an upstream failure without faking a normal
// end. A destroyed socket surfaces as an error instead of truncated "success".
export function abortClientStream(res) {
  if (!res || typeof res !== "object") return;
  try {
    if (!res.writableEnded && !res.destroyed && typeof res.destroy === "function") res.destroy();
  } catch {}
}

// Streaming pre-stream failover. Call from a pipe's early JSON-error branch
// (before any bytes were sent) to switch to the next attempt (prebuilt or
// lazy — the retry callback builds it on body/options access).
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
  setTimeout(() => {
    if (isClientGone(res)) return;
    retry(nxt, ex);
  }, delay);
  return true;
}
