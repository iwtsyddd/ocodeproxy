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
  asyncHandler,
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
  it("handles whitespace, null and non-string inputs", () => {
    assert.deepEqual(detectUpstreamError(null).needMore, true);
    assert.deepEqual(detectUpstreamError(undefined).needMore, true);
    assert.deepEqual(detectUpstreamError("   \n\t  ").needMore, true);
    assert.deepEqual(detectUpstreamError(123).isStream, true);
    assert.deepEqual(detectUpstreamError(Buffer.from("")).needMore, true);
    const bufErr = detectUpstreamError(Buffer.from('{"error":{"message":"x"}}'));
    assert.equal(bufErr.isStream, false);
    assert.equal(bufErr.parsed.error.message, "x");
  });
  it("ignores surrounding whitespace for errors", () => {
    const err = detectUpstreamError('  {"error":{"message":"x"}}  \n');
    assert.equal(err.isStream, false);
    assert.equal(err.parsed.error.message, "x");
    assert.deepEqual(detectUpstreamError("  data: {}").isStream, true);
  });
  it("prefers explicit error shapes over derived rate-limit match", () => {
    const explicit = detectUpstreamError('{"error":{"message":"boom"}}');
    assert.equal(explicit.isStream, false);
    const byType = detectUpstreamError('{"type":"error","message":"bad"}');
    assert.equal(byType.isStream, false);
    const byRegex = detectUpstreamError('{"message":"rate_limit hit"}');
    assert.equal(byRegex.isStream, false);
    assert.equal(byRegex.parsed.message, "rate_limit hit");
    assert.deepEqual(detectUpstreamError('{"ok":true}').isStream, true);
  });
  it("prefers SSE marker over JSON-looking prefix", () => {
    assert.deepEqual(detectUpstreamError('{ "a":1 }\nzzz\ndata: foo').isStream, true);
    assert.deepEqual(detectUpstreamError(": ping\n\ndata: {}").isStream, true);
  });
  it("waits for closing brace instead of parsing incomplete JSON", () => {
    assert.deepEqual(detectUpstreamError('{"error":"' + "x".repeat(9000)).needMore, true);
    const bigErr = '{"error":{"message":"' + "y".repeat(10000) + '"}}';
    const done = detectUpstreamError(bigErr);
    assert.equal(done.isStream, false);
    assert.match(done.parsed.error.message, /^y+$/);
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

describe("asyncHandler", () => {
  it("rejects non-function input with TypeError", () => {
    assert.throws(() => asyncHandler(null), TypeError);
    assert.throws(() => asyncHandler(undefined), TypeError);
    assert.throws(() => asyncHandler(123), TypeError);
  });

  it("passes async rejection to next(err)", async () => {
    let captured = null;
    const next = (err) => { captured = err; };
    const handler = asyncHandler(async () => {
      throw new Error("async explosion");
    });
    handler({}, {}, next);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(captured instanceof Error);
    assert.equal(captured.message, "async explosion");
  });

  it("passes sync throw to next(err)", () => {
    let captured = null;
    const next = (err) => { captured = err; };
    const handler = asyncHandler(() => {
      throw new Error("sync explosion");
    });
    handler({}, {}, next);
    assert.ok(captured instanceof Error);
    assert.equal(captured.message, "sync explosion");
  });

  it("does not call next when async route completes normally", async () => {
    let called = false;
    const next = () => { called = true; };
    const handler = asyncHandler(async (_req, res) => {
      res.status = 200;
    });
    const fakeRes = {};
    handler({}, fakeRes, next);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(called, false);
    assert.equal(fakeRes.status, 200);
  });
});

