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
  } else if (finalStatus === 403) {
    type = "permission_error";
    if (code === "upstream_error") code = "permission_denied";
  } else if (finalStatus === 404) {
    type = "not_found_error";
    if (code === "upstream_error") code = "not_found";
  } else if (finalStatus >= 500) {
    type = "api_error";
    if (code === "upstream_error") code = "internal_server_error";
  }

  if (format === "anthropic") {
    return { status: finalStatus, body: { type: "error", error: { type, message: rawMsg } } };
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

export function detectUpstreamError(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { needMore: true };
  if (trimmed.startsWith("data:") || trimmed.includes("\ndata:") || trimmed.includes("\r\ndata:")) {
    return { needMore: false, isStream: true };
  }
  if (!trimmed.startsWith("{")) return { needMore: false, isStream: true };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && (parsed.error || parsed.type === "error" || /FreeTierError|FreeUsageLimitError|rate_limit/i.test(trimmed))) {
      return { needMore: false, isStream: false, parsed };
    }
    return { needMore: false, isStream: true };
  } catch {
    if (trimmed.length < 65536) return { needMore: true };
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
