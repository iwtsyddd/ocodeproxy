import { StringDecoder } from "node:string_decoder";
import { createUnifiedSseAggregator } from "./convert.mjs";
import { BufferLimitError } from "./sse.mjs";

export { BufferLimitError };

export const DEFAULT_BUFFERED_SSE_MAX_BYTES = 20 * 1024 * 1024;
export const MIN_BUFFERED_SSE_MAX_BYTES = 1 * 1024 * 1024;
export const MAX_BUFFERED_SSE_MAX_BYTES = 100 * 1024 * 1024;
export const BUFFERED_HEAD_SAMPLE_MAX_CHARS = 65536;

export const DEFAULT_AUX_FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const MIN_AUX_FETCH_MAX_BYTES = 1024;
export const MAX_AUX_FETCH_MAX_BYTES = 50 * 1024 * 1024;

export function resolveBufferedSseMaxBytes(raw) {
  if (raw == null || String(raw).trim() === "") return DEFAULT_BUFFERED_SSE_MAX_BYTES;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) return DEFAULT_BUFFERED_SSE_MAX_BYTES;
  return Math.min(Math.max(n, MIN_BUFFERED_SSE_MAX_BYTES), MAX_BUFFERED_SSE_MAX_BYTES);
}

export function resolveAuxFetchMaxBytes(raw) {
  if (raw == null || String(raw).trim() === "") return DEFAULT_AUX_FETCH_MAX_BYTES;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n)) return DEFAULT_AUX_FETCH_MAX_BYTES;
  return Math.min(Math.max(n, MIN_AUX_FETCH_MAX_BYTES), MAX_AUX_FETCH_MAX_BYTES);
}

// Incremental SSE collector for buffered (non-stream) responses. Decodes
// chunks with StringDecoder (split multibyte safe), feeds complete lines to
// a unified aggregator, and enforces a byte cap. Never stores the full raw
// payload: only a small leftover line plus the first 64k chars for JSON
// error detection are retained alongside aggregated content.
export function createBufferedSseCollector(maxBytes, requestedModel = "") {
  const limit = resolveBufferedSseMaxBytes(maxBytes);
  const agg = createUnifiedSseAggregator(requestedModel);
  const decoder = new StringDecoder("utf8");
  let totalBytes = 0;
  let head = "";
  function push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    totalBytes += bytes;
    if (totalBytes > limit) {
      throw new BufferLimitError(totalBytes, limit);
    }
    const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (text) {
      if (head.length < BUFFERED_HEAD_SAMPLE_MAX_CHARS) {
        head += text.slice(0, BUFFERED_HEAD_SAMPLE_MAX_CHARS - head.length);
      }
      agg.pushText(text);
    }
  }
  function finish() {
    const tail = decoder.end();
    if (tail) {
      const bytes = Buffer.byteLength(tail);
      totalBytes += bytes;
      if (totalBytes > limit) {
        throw new BufferLimitError(totalBytes, limit);
      }
      if (head.length < BUFFERED_HEAD_SAMPLE_MAX_CHARS) {
        head += tail.slice(0, BUFFERED_HEAD_SAMPLE_MAX_CHARS - head.length);
      }
      agg.pushText(tail);
    }
    return {
      completion: agg.result(),
      totalBytes,
      sawData: agg.hasData(),
      head,
      maxBytes: limit,
    };
  }
  return { push, finish, getTotalBytes: () => totalBytes, getLimit: () => limit };
}

// Bounded JSON collector for small upstream JSON bodies (models, errors).
// Uses decoded string parts joined once at the end: a single copy plus the
// parts array, instead of Buffer list + concat Buffer + string triple.
export function createBufferedJsonCollector(maxBytes) {
  const limit = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
    ? maxBytes
    : resolveBufferedSseMaxBytes(maxBytes);
  const decoder = new StringDecoder("utf8");
  const parts = [];
  let totalBytes = 0;
  function push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    totalBytes += bytes;
    if (totalBytes > limit) {
      throw new BufferLimitError(totalBytes, limit);
    }
    const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (text) parts.push(text);
  }
  function finish() {
    const tail = decoder.end();
    if (tail) {
      totalBytes += Buffer.byteLength(tail);
      if (totalBytes > limit) {
        throw new BufferLimitError(totalBytes, limit);
      }
      parts.push(tail);
    }
    const text = parts.join("");
    return { text, totalBytes, maxBytes: limit };
  }
  return { push, finish, getTotalBytes: () => totalBytes, getLimit: () => limit };
}

// Collects an HTTP/HTTPS response body up to maxBytes. Destroys the response
// (and optional request) immediately if the limit is exceeded, preventing
// unbounded memory accumulation and double-allocation on invalid payloads.
export function collectBoundedResponse(res, req, maxBytes = DEFAULT_AUX_FETCH_MAX_BYTES) {
  return new Promise((resolve) => {
    if (!res || typeof res.on !== "function") {
      return resolve({ ok: false, error: new Error("Invalid response stream"), text: null, limitExceeded: false });
    }
    const limit = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : resolveAuxFetchMaxBytes(maxBytes);
    const collector = createBufferedJsonCollector(limit);
    let done = false;

    function finishOnce(result) {
      if (done) return;
      done = true;
      resolve(result);
    }

    res.on("data", (chunk) => {
      if (done) return;
      try {
        collector.push(chunk);
      } catch (e) {
        if (e instanceof BufferLimitError) {
          try { if (typeof res.destroy === "function") res.destroy(); } catch {}
          try { if (req && typeof req.destroy === "function") req.destroy(); } catch {}
          finishOnce({ ok: false, error: e, text: null, limitExceeded: true });
        } else {
          try { if (typeof res.destroy === "function") res.destroy(); } catch {}
          try { if (req && typeof req.destroy === "function") req.destroy(); } catch {}
          finishOnce({ ok: false, error: e, text: null, limitExceeded: false });
        }
      }
    });

    res.on("end", () => {
      if (done) return;
      try {
        const { text, totalBytes } = collector.finish();
        finishOnce({ ok: true, text, totalBytes, limitExceeded: false });
      } catch (e) {
        try { if (typeof res.destroy === "function") res.destroy(); } catch {}
        try { if (req && typeof req.destroy === "function") req.destroy(); } catch {}
        finishOnce({
          ok: false,
          error: e,
          text: null,
          limitExceeded: e instanceof BufferLimitError,
        });
      }
    });

    res.on("error", (err) => {
      finishOnce({ ok: false, error: err, text: null, limitExceeded: false });
    });
  });
}
