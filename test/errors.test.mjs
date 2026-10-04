import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  responsesErrorStatus,
  mapZenError,
  publicNetworkMessage,
  detectUpstreamError,
  retryAfterMs,
  isRetryableUpstreamStatus,
  gatewayRetryHeaders,
} from "../lib/errors.mjs";

describe("responsesErrorStatus", () => {
  it("detects rate limits by code, type or message", () => {
    assert.equal(responsesErrorStatus({ error: { code: "rate_limit_exceeded" } }, 500), 429);
    assert.equal(responsesErrorStatus({ error: { type: "rate_limit_error" } }, 500), 429);
    assert.equal(responsesErrorStatus({ error: { message: "Rate limit hit" } }, 500), 429);
  });
  it("honors valid fallbacks and defaults to 502", () => {
    assert.equal(responsesErrorStatus({ error: { message: "boom" } }, 503), 503);
    assert.equal(responsesErrorStatus({ error: { message: "boom" } }, 200), 502);
    assert.equal(responsesErrorStatus(null, null), 502);
  });
});

describe("mapZenError", () => {
  it("upgrades rate limits with a free-tier suffix", () => {
    const out = mapZenError(400, { error: { message: "FreeUsageLimitError" } }, "openai");
    assert.equal(out.status, 429);
    assert.equal(out.body.error.type, "rate_limit_error");
    assert.match(out.body.error.message, /free model rate limit/);
  });
  it("maps status codes to typed errors", () => {
    assert.equal(mapZenError(400, { message: "bad" }, "openai").body.error.type, "invalid_request_error");
    assert.equal(mapZenError(401, { message: "no" }, "openai").body.error.code, "invalid_api_key");
    assert.equal(mapZenError(403, { message: "no" }, "openai").body.error.type, "permission_error");
    assert.equal(mapZenError(404, { message: "no" }, "openai").body.error.type, "not_found_error");
    assert.equal(mapZenError(500, { message: "no" }, "openai").body.error.type, "api_error");
  });
  it("keeps explicit upstream codes and normalizes low statuses", () => {
    const out = mapZenError(403, { error: { code: "custom", type: "t", message: "m" } }, "openai");
    assert.equal(out.body.error.code, "custom");
    assert.equal(mapZenError(200, { message: "weird" }, "openai").status, 502);
  });
  it("builds the anthropic error shape", () => {
    const out = mapZenError(429, { error: { message: "slow" } }, "anthropic");
    assert.equal(out.status, 429);
    assert.equal(out.body.type, "error");
    assert.equal(out.body.error.type, "rate_limit_error");
  });
});

describe("publicNetworkMessage", () => {
  it("classifies timeouts, connection failures and generic errors", () => {
    assert.equal(publicNetworkMessage(new Error("ETIMEDOUT")), "Upstream timeout");
    assert.equal(publicNetworkMessage(new Error("socket hang up")), "Upstream connection failed");
    assert.equal(publicNetworkMessage(new Error("ECONNRESET")), "Upstream connection failed");
    assert.equal(publicNetworkMessage(new Error("weird")), "Upstream request failed");
    assert.equal(publicNetworkMessage(null), "Upstream request failed");
  });
});

describe("detectUpstreamError", () => {
  it("detects streams, errors and incomplete payloads", () => {
    assert.deepEqual(detectUpstreamError(""), { needMore: true });
    assert.deepEqual(detectUpstreamError("data: {}").isStream, true);
    const err = detectUpstreamError('{"error":{"message":"x"}}');
    assert.equal(err.isStream, false);
    assert.equal(err.parsed.error.message, "x");
    assert.deepEqual(detectUpstreamError('{"ok":true}').isStream, true);
    assert.deepEqual(detectUpstreamError('{"partial":').needMore, true);
    assert.deepEqual(detectUpstreamError("<html>" + "x".repeat(70000)).isStream, true);
  });
});

describe("retryAfterMs", () => {
  it("parses seconds, arrays and falls back with a 15s clamp", () => {
    assert.equal(retryAfterMs({ "retry-after": "2" }, 500), 2000);
    assert.equal(retryAfterMs({ "retry-after": ["1"] }, 500), 1000);
    assert.equal(retryAfterMs({}, 500), 500);
    assert.equal(retryAfterMs({ "retry-after": "999" }, 500), 15000);
    assert.equal(retryAfterMs({ "retry-after": "bogus" }, 500), 500);
  });
});

describe("isRetryableUpstreamStatus", () => {
  it("flags 429 and 5xx only", () => {
    assert.equal(isRetryableUpstreamStatus(429), true);
    assert.equal(isRetryableUpstreamStatus(500), true);
    assert.equal(isRetryableUpstreamStatus(503), true);
    assert.equal(isRetryableUpstreamStatus(400), false);
    assert.equal(isRetryableUpstreamStatus(401), false);
    assert.equal(isRetryableUpstreamStatus(404), false);
    assert.equal(isRetryableUpstreamStatus(200), false);
    assert.equal(isRetryableUpstreamStatus(undefined), false);
  });
});

describe("gatewayRetryHeaders", () => {
  it("synthesizes retry hints on errors", () => {
    assert.deepEqual(gatewayRetryHeaders(undefined, 429), { "retry-after": "5", "x-should-retry": "true" });
    assert.deepEqual(gatewayRetryHeaders(undefined, 502), { "x-should-retry": "true" });
    assert.deepEqual(gatewayRetryHeaders(undefined, 400), { "x-should-retry": "false" });
    assert.deepEqual(gatewayRetryHeaders(undefined, 200), {});
  });
  it("forwards upstream values case-insensitively", () => {
    const out = gatewayRetryHeaders(
      { "Retry-After": "2", "X-Should-Retry": "false", "Anthropic-Ratelimit-Unified-Limit": "100" },
      429
    );
    assert.equal(out["retry-after"], "2");
    assert.equal(out["x-should-retry"], "false");
    assert.equal(out["anthropic-ratelimit-unified-limit"], "100");
  });
});
