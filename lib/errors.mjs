import { ocId } from "./ids.mjs";

export function responsesErrorStatus(data, fallbackStatus) {
  const msg = data?.error?.message || data?.message || "";
  if (data?.error?.code === "rate_limit_exceeded" || data?.error?.type === "rate_limit_error" || /rate_limit|Rate limit/i.test(msg)) {
    return 429;
  }
  const fb = Number(fallbackStatus);
  if (Number.isInteger(fb) && fb >= 400 && fb <= 599) return fb;
  return 502;
}

export function mapZenError(status, errData, format = "openai") {
  let rawMsg = errData?.error?.message || errData?.message || "Upstream error";
  let finalStatus = Number(status) || 502;
  if (finalStatus < 400) finalStatus = 502;
  let code = errData?.error?.code || (finalStatus === 429 ? "rate_limit_exceeded" : "upstream_error");
  let type = errData?.error?.type || "upstream_error";

  if (finalStatus === 429 || /rate_limit|FreeUsageLimitError/i.test(rawMsg)) {
    finalStatus = 429;
    type = "rate_limit_error";
    code = "rate_limit_exceeded";
    rawMsg = `${rawMsg} (free model rate limit)`;
  } else if (finalStatus === 400) {
    type = "invalid_request_error";
    if (code === "upstream_error") code = "invalid_request_error";
  } else if (finalStatus === 401) {
    type = "authentication_error";
    if (code === "upstream_error") code = "invalid_api_key";
  } else if (finalStatus === 402) {
    type = "billing_error";
    if (code === "upstream_error") code = "billing_error";
  } else if (finalStatus === 403) {
    type = "permission_error";
    if (code === "upstream_error") code = "permission_denied";
  } else if (finalStatus === 404) {
    type = "not_found_error";
    if (code === "upstream_error") code = "not_found";
  } else if (finalStatus === 409) {
    type = "conflict_error";
    if (code === "upstream_error") code = "conflict";
  } else if (finalStatus === 413) {
    type = "request_too_large";
    if (code === "upstream_error") code = "request_too_large";
  } else if (finalStatus === 504) {
    type = "timeout_error";
    if (code === "upstream_error") code = "timeout";
  } else if (finalStatus === 529) {
    type = "overloaded_error";
    if (code === "upstream_error") code = "overloaded";
  } else if (finalStatus >= 500) {
    type = "api_error";
    if (code === "upstream_error") code = "internal_server_error";
  }

  if (format === "anthropic") {
    return { status: finalStatus, body: { type: "error", error: { type, message: rawMsg }, request_id: ocId("req") } };
  }
  return { status: finalStatus, body: { error: { message: rawMsg, type, code } } };
}

export function publicNetworkMessage(err) {
  const msg = err?.message || String(err || "");
  if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) return "Upstream timeout";
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|EAI_AGAIN|socket hang up|ECONNABORTED|network/i.test(msg)) {
    return "Upstream connection failed";
  }
  return "Upstream request failed";
}

export const DETECT_SCAN_CHARS = 8192;
export const DETECT_MAX_JSON_CHARS = 65536;
const DETECT_TAIL_SCAN_CHARS = 1024;
const RATE_LIMIT_RE = /rate_limit|FreeUsageLimitError|FreeTierError/i;

function isWsChar(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c <= " " || /\s/.test(c);
}

export function detectUpstreamError(raw) {
  let s;
  if (typeof raw === "string") {
    s = raw;
  } else if (raw == null) {
    return { needMore: true };
  } else if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) return { needMore: true };
    s = raw.toString("utf8", 0, Math.min(raw.length, DETECT_MAX_JSON_CHARS));
  } else {
    s = String(raw);
  }
  const len = s.length;
  if (!len) return { needMore: true };
  // find first non-whitespace without copying (prefix-bounded, then full scan only for all-ws prefix)
  let start = -1;
  const scanEnd = len < DETECT_SCAN_CHARS ? len : DETECT_SCAN_CHARS;
  for (let i = 0; i < scanEnd; i++) {
    if (!isWsChar(s[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    if (len > DETECT_SCAN_CHARS) {
      for (let i = DETECT_SCAN_CHARS; i < len; i++) {
        if (!isWsChar(s[i])) {
          start = i;
          break;
        }
      }
    }
    if (start === -1) return { needMore: true };
  }
  if (s[start] !== "{") return { needMore: false, isStream: true };
  // JSON-looking prefix: only scan first N chars for an SSE marker
  const prefixEnd = len < start + DETECT_SCAN_CHARS ? len : start + DETECT_SCAN_CHARS;
  const prefix = s.slice(start, prefixEnd);
  if (prefix.includes("\ndata:")) return { needMore: false, isStream: true };
  // skip JSON.parse until the tail looks complete (ends with })
  let end = len - 1;
  let tailScanned = 0;
  while (end > start && tailScanned < DETECT_TAIL_SCAN_CHARS) {
    if (!isWsChar(s[end])) break;
    end--;
    tailScanned++;
  }
  if (tailScanned >= DETECT_TAIL_SCAN_CHARS) {
    if (len < DETECT_MAX_JSON_CHARS) return { needMore: true };
    return { needMore: false, isStream: true };
  }
  if (s[end] !== "}") {
    if (len < DETECT_MAX_JSON_CHARS) return { needMore: true };
    return { needMore: false, isStream: true };
  }
  try {
    const parsed = JSON.parse(s);
    if (parsed && (parsed.error || parsed.type === "error" || RATE_LIMIT_RE.test(s))) {
      return { needMore: false, isStream: false, parsed };
    }
    return { needMore: false, isStream: true };
  } catch {
    if (len < DETECT_MAX_JSON_CHARS) return { needMore: true };
    return { needMore: false, isStream: true };
  }
}

export function retryAfterMs(headers, fallbackMs) {
  const raw = Array.isArray(headers?.["retry-after"]) ? headers["retry-after"][0] : headers?.["retry-after"];
  if (raw == null) return fallbackMs;
  const secs = Number(String(raw).trim());
  if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), 15000);
  const at = Date.parse(String(raw));
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 15000);
  return fallbackMs;
}

export function isRetryableUpstreamStatus(status) {
  const s = Number(status);
  return s === 429 || (s >= 500 && s <= 599);
}

// Gateway retry/ratelimit headers for Claude Code compat.
// Forwards upstream `retry-after` (normalized to integer seconds),
// `x-should-retry`, and `anthropic-ratelimit-unified-*` (header names
// matched case-insensitively). Synthesizes `retry-after` (default 5s)
// and `x-should-retry` from the status when the upstream gave none.
// Only error statuses get synthesized values; success responses only
// carry through upstream ratelimit headers.
export function gatewayRetryHeaders(upstreamHeaders, status) {
  const out = {};
  const src = {};
  if (upstreamHeaders && typeof upstreamHeaders === "object") {
    for (const [k, v] of Object.entries(upstreamHeaders)) {
      src[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
  }
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("anthropic-ratelimit-unified-") && v != null && String(v) !== "") {
      out[k] = String(v);
    }
  }
  if (src["x-should-retry"] != null && String(src["x-should-retry"]) !== "") {
    out["x-should-retry"] = String(src["x-should-retry"]);
  }
  const s = Number(status);
  const isError = Number.isInteger(s) && s >= 400;
  if (src["retry-after"] != null && String(src["retry-after"]) !== "") {
    const ms = retryAfterMs(src, 5000);
    out["retry-after"] = String(Math.min(Math.max(Math.ceil(ms / 1000), 1), 60));
  } else if (s === 429) {
    out["retry-after"] = "5";
  }
  if (isError && out["x-should-retry"] === undefined) {
    out["x-should-retry"] = isRetryableUpstreamStatus(s) ? "true" : "false";
  }
  return out;
}

// Express async route wrapper ensuring unhandled promise rejections
// are forwarded to next(err) instead of triggering unhandledRejection process crashes.
export function asyncHandler(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("asyncHandler expects a function");
  }
  return function asyncRouteHandler(req, res, next) {
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.catch === "function") {
        ret.catch(next);
      }
    } catch (err) {
      if (typeof next === "function") {
        next(err);
      }
    }
  };
}

