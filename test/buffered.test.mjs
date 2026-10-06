import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createChatSseAggregator,
  createResponsesSseAggregator,
  createUnifiedSseAggregator,
  aggregateSseToCompletion,
  aggregateResponsesSseToOpenAI,
} from "../lib/convert.mjs";
import {
  DEFAULT_BUFFERED_SSE_MAX_BYTES,
  MIN_BUFFERED_SSE_MAX_BYTES,
  MAX_BUFFERED_SSE_MAX_BYTES,
  DEFAULT_AUX_FETCH_MAX_BYTES,
  MIN_AUX_FETCH_MAX_BYTES,
  MAX_AUX_FETCH_MAX_BYTES,
  resolveBufferedSseMaxBytes,
  resolveAuxFetchMaxBytes,
  createBufferedSseCollector,
  createBufferedJsonCollector,
  collectBoundedResponse,
  BufferLimitError,
} from "../lib/buffered.mjs";
import { collectWithFallback } from "../lib/fallback.mjs";

const chatSse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\ndata: [DONE]\n";
const respSse = (evs) => evs.map((e) => `data: ${JSON.stringify(e)}`).join("\n");

describe("resolveBufferedSseMaxBytes", () => {
  it("returns the default for missing or invalid input", () => {
    assert.equal(resolveBufferedSseMaxBytes(undefined), DEFAULT_BUFFERED_SSE_MAX_BYTES);
    assert.equal(resolveBufferedSseMaxBytes(""), DEFAULT_BUFFERED_SSE_MAX_BYTES);
    assert.equal(resolveBufferedSseMaxBytes("nope"), DEFAULT_BUFFERED_SSE_MAX_BYTES);
    assert.equal(resolveBufferedSseMaxBytes(1.5), DEFAULT_BUFFERED_SSE_MAX_BYTES);
    assert.equal(resolveBufferedSseMaxBytes(null), DEFAULT_BUFFERED_SSE_MAX_BYTES);
  });
  it("clamps explicit values into the allowed range", () => {
    assert.equal(resolveBufferedSseMaxBytes(1), MIN_BUFFERED_SSE_MAX_BYTES);
    assert.equal(resolveBufferedSseMaxBytes(10 ** 12), MAX_BUFFERED_SSE_MAX_BYTES);
    assert.equal(resolveBufferedSseMaxBytes(5 * 1024 * 1024), 5 * 1024 * 1024);
  });
  it("handles negatives without throwing", () => {
    assert.equal(resolveBufferedSseMaxBytes(-5), MIN_BUFFERED_SSE_MAX_BYTES);
  });
});

describe("createChatSseAggregator", () => {
  it("matches the one-shot helper on split input", () => {
    const raw = chatSse([
      { id: "chatcmpl-1", created: 7, model: "m", choices: [{ delta: { content: "he" } }] },
      { choices: [{ delta: { content: "llo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
    ]);
    const expected = aggregateSseToCompletion(raw, "m");
    const agg = createChatSseAggregator("m");
    for (let i = 0; i < raw.length; i += 7) agg.pushText(raw.slice(i, i + 7));
    const out = agg.result();
    assert.deepEqual(out, expected);
  });
  it("ignores garbage, handles negatives and filters decoys", () => {
    const agg = createChatSseAggregator("m");
    agg.pushText("garbage\ndata: not-json\n");
    agg.pushText(null);
    agg.pushText("");
    agg.pushJson(null);
    agg.pushJson(42);
    const out = agg.result();
    assert.equal(out.choices[0].message.content, null);
    assert.equal(out.choices[0].finish_reason, "stop");
    const agg2 = createChatSseAggregator("m");
    agg2.pushText(chatSse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "bash", arguments: "{}" } }] } }] }]));
    assert.equal(agg2.result().choices[0].message.tool_calls, undefined);
  });
  it("handles a final line without trailing newline", () => {
    const agg = createChatSseAggregator("m");
    agg.pushText(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`);
    assert.equal(agg.result().choices[0].message.content, "hi");
  });
  it("accumulates thousands of small delta chunks efficiently", () => {
    const agg = createChatSseAggregator("m");
    const count = 2000;
    for (let i = 0; i < count; i++) {
      agg.pushJson({
        choices: [{
          delta: {
            content: "a",
            reasoning_content: "r",
            tool_calls: [{ index: 0, id: "c1", function: { name: i === 0 ? "exec" : "", arguments: "1" } }],
          },
        }],
      });
    }
    const res = agg.result();
    assert.equal(res.choices[0].message.content, "a".repeat(count));
    assert.equal(res.choices[0].message.reasoning_content, "r".repeat(count));
    assert.equal(res.choices[0].message.tool_calls[0].function.arguments, "1".repeat(count));
  });
});

describe("createResponsesSseAggregator", () => {
  it("matches the one-shot helper on split input", () => {
    const raw = respSse([
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "c1", name: "read" } },
      { type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"a":1}' },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]);
    const expected = aggregateResponsesSseToOpenAI(raw, "m");
    const agg = createResponsesSseAggregator("m");
    for (let i = 0; i < raw.length; i += 5) agg.pushText(raw.slice(i, i + 5));
    const out = agg.result();
    assert.match(out.id, /^chatcmpl_/);
    assert.match(expected.id, /^chatcmpl_/);
    const { id: _a, created: _b, ...restOut } = out;
    const { id: _c, created: _d, ...restExp } = expected;
    assert.deepEqual(restOut, restExp);
  });
  it("handles negatives without throwing", () => {
    const agg = createResponsesSseAggregator("m");
    agg.pushText("");
    agg.pushJson(null);
    agg.pushJson({});
    assert.equal(agg.result().choices[0].message.content, null);
    assert.equal(agg.hasData(), false);
  });
  it("accumulates thousands of delta events efficiently", () => {
    const agg = createResponsesSseAggregator("m");
    const count = 2000;
    agg.pushJson({ type: "response.output_item.added", item: { type: "function_call", id: "i1", name: "exec" } });
    for (let i = 0; i < count; i++) {
      agg.pushJson({ type: "response.output_text.delta", delta: "t" });
      agg.pushJson({ type: "response.reasoning_text.delta", delta: "q" });
      agg.pushJson({ type: "response.refusal.delta", delta: "x" });
      agg.pushJson({ type: "response.function_call_arguments.delta", item_id: "i1", delta: "k" });
    }
    const res = agg.result();
    assert.equal(res.choices[0].message.content, "t".repeat(count));
    assert.equal(res.choices[0].message.reasoning_content, "q".repeat(count));
    assert.equal(res.choices[0].message.refusal, "x".repeat(count));
    assert.equal(res.choices[0].message.tool_calls[0].function.arguments, "k".repeat(count));
  });
});

describe("createUnifiedSseAggregator", () => {
  it("produces chat parity for chat streams", () => {
    const raw = chatSse([
      { id: "c1", created: 9, model: "up", choices: [{ delta: { content: "a", reasoning_content: "r" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } },
    ]);
    const agg = createUnifiedSseAggregator("fallback");
    agg.pushText(raw);
    assert.deepEqual(agg.result(), aggregateSseToCompletion(raw, "fallback"));
  });
  it("produces responses parity for responses streams", () => {
    const raw = respSse([
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.refusal.delta", delta: "no" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]);
    const agg = createUnifiedSseAggregator("m");
    agg.pushText(raw);
    const out = agg.result();
    const expected = aggregateResponsesSseToOpenAI(raw, "m");
    const { id: _a, created: _b, ...restOut } = out;
    const { id: _c, created: _d, ...restExp } = expected;
    assert.deepEqual(restOut, restExp);
  });
  it("prefers explicit chat state over derived responses state", () => {
    const agg = createUnifiedSseAggregator("m");
    agg.pushJson({ id: "chat-1", model: "up", choices: [{ delta: { content: "c" } }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    agg.pushJson({ type: "response.output_text.delta", delta: "r" });
    agg.pushJson({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 99, total_tokens: 100 } } });
    const out = agg.result();
    assert.equal(out.id, "chat-1");
    assert.equal(out.model, "up");
    assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
    assert.equal(out.choices[0].message.content, "cr");
  });
  it("reports empty completion for non-SSE input", () => {
    const agg = createUnifiedSseAggregator("m");
    agg.pushText("hello\nnot sse\n");
    assert.equal(agg.hasData(), false);
    assert.equal(agg.result().choices[0].message.content, null);
  });
});

describe("createBufferedSseCollector", () => {
  it("streams chunks incrementally without storing raw", () => {
    const raw = chatSse([
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ]);
    const col = createBufferedSseCollector(DEFAULT_BUFFERED_SSE_MAX_BYTES, "m");
    const buf = Buffer.from(raw, "utf8");
    for (let i = 0; i < buf.length; i += 3) col.push(buf.subarray(i, i + 3));
    const done = col.finish();
    assert.equal(done.sawData, true);
    assert.equal(done.completion.choices[0].message.content, "hello world");
    assert.ok(done.totalBytes > 0);
    assert.ok(!("raw" in done));
  });
  it("decodes split multibyte characters across Buffer boundaries", () => {
    const emoji = "hi 👍 bye";
    const raw = chatSse([{ choices: [{ delta: { content: emoji } }] }]);
    const buf = Buffer.from(raw, "utf8");
    const col = createBufferedSseCollector(DEFAULT_BUFFERED_SSE_MAX_BYTES, "m");
    col.push(buf.subarray(0, buf.length - 2));
    col.push(buf.subarray(buf.length - 2));
    assert.equal(col.finish().completion.choices[0].message.content, emoji);
  });
  it("enforces maxBuffer with a 413-coded error", () => {
    const col = createBufferedSseCollector(MIN_BUFFERED_SSE_MAX_BYTES, "m");
    const big = Buffer.alloc(MIN_BUFFERED_SSE_MAX_BYTES + 1, "a");
    let err = null;
    try {
      col.push(big);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof BufferLimitError);
    assert.equal(err.code, "buffer_limit_exceeded");
    assert.equal(err.status, 413);
  });
  it("keeps only a head sample for JSON error detection", () => {
    const col = createBufferedSseCollector(DEFAULT_BUFFERED_SSE_MAX_BYTES, "m");
    col.push('{"error":{"message":"nope"}}');
    const done = col.finish();
    assert.equal(done.sawData, false);
    assert.match(done.head, /nope/);
  });
  it("handles empty and invalid chunks without throwing", () => {
    const col = createBufferedSseCollector(DEFAULT_BUFFERED_SSE_MAX_BYTES, "m");
    col.push("");
    col.push(Buffer.from(""));
    const done = col.finish();
    assert.equal(done.sawData, false);
    assert.equal(done.completion.choices[0].finish_reason, "stop");
  });
});

describe("createBufferedJsonCollector", () => {
  it("joins decoded parts once and parses downstream", () => {
    const col = createBufferedJsonCollector(DEFAULT_BUFFERED_SSE_MAX_BYTES);
    col.push(Buffer.from('{"a":'));
    col.push(Buffer.from('1}'));
    const { text } = col.finish();
    assert.deepEqual(JSON.parse(text), { a: 1 });
  });
  it("enforces the byte cap", () => {
    const col = createBufferedJsonCollector(MIN_BUFFERED_SSE_MAX_BYTES);
    assert.throws(() => col.push(Buffer.alloc(MIN_BUFFERED_SSE_MAX_BYTES + 1, "x")), (e) => e instanceof BufferLimitError);
  });
  it("handles negatives without throwing", () => {
    const col = createBufferedJsonCollector(DEFAULT_BUFFERED_SSE_MAX_BYTES);
    col.push("");
    assert.equal(col.finish().text, "");
  });
});

describe("collectWithFallback model forwarding", () => {
  it("passes the attempt model to the collector", async () => {
    const seen = [];
    const out = await collectWithFallback(
      [{ body: "b1", options: {}, model: "m1" }],
      async (options, body, model) => {
        seen.push(model);
        return { status: 200, completion: { model }, headers: {} };
      },
      { fallbackDelayMs: 0 }
    );
    assert.deepEqual(seen, ["m1"]);
    assert.equal(out.model, "m1");
  });
  it("tolerates collectors that ignore the model argument", async () => {
    const out = await collectWithFallback(
      [{ body: "b1", options: {}, model: "m1" }],
      async () => ({ status: 200, headers: {} }),
      { fallbackDelayMs: 0 }
    );
    assert.equal(out.model, "m1");
  });
});

describe("resolveAuxFetchMaxBytes", () => {
  it("returns the default for missing or invalid input", () => {
    assert.equal(resolveAuxFetchMaxBytes(undefined), DEFAULT_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes(null), DEFAULT_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes(""), DEFAULT_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes("not-an-int"), DEFAULT_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes(1.5), DEFAULT_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes(NaN), DEFAULT_AUX_FETCH_MAX_BYTES);
  });
  it("clamps explicit values into allowed bounds", () => {
    assert.equal(resolveAuxFetchMaxBytes(0), MIN_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes(-100), MIN_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes(10 ** 9), MAX_AUX_FETCH_MAX_BYTES);
    assert.equal(resolveAuxFetchMaxBytes(5 * 1024 * 1024), 5 * 1024 * 1024);
  });
  it("parses valid numeric strings", () => {
    assert.equal(resolveAuxFetchMaxBytes("5242880"), 5242880);
    assert.equal(resolveAuxFetchMaxBytes(" 2097152 "), 2097152);
  });
});

describe("collectBoundedResponse", () => {
  function createMockStream() {
    const emitter = new EventEmitter();
    let destroyed = false;
    emitter.destroy = () => {
      destroyed = true;
      emitter.destroyed = true;
    };
    Object.defineProperty(emitter, "isDestroyed", { get: () => destroyed });
    return emitter;
  }

  it("collects complete response within the byte limit", async () => {
    const res = createMockStream();
    const req = createMockStream();
    const promise = collectBoundedResponse(res, req, 1024);

    res.emit("data", Buffer.from('{"hello":'));
    res.emit("data", Buffer.from('"world"}'));
    res.emit("end");

    const out = await promise;
    assert.equal(out.ok, true);
    assert.equal(out.text, '{"hello":"world"}');
    assert.equal(out.limitExceeded, false);
    assert.equal(res.isDestroyed, false);
    assert.equal(req.isDestroyed, false);
  });

  it("destroys res and req when response exceeds byte cap", async () => {
    const res = createMockStream();
    const req = createMockStream();
    const promise = collectBoundedResponse(res, req, 100);

    res.emit("data", Buffer.alloc(60, "a"));
    res.emit("data", Buffer.alloc(50, "b"));

    const out = await promise;
    assert.equal(out.ok, false);
    assert.equal(out.limitExceeded, true);
    assert.equal(out.text, null);
    assert.equal(out.error instanceof BufferLimitError, true);
    assert.equal(res.isDestroyed, true);
    assert.equal(req.isDestroyed, true);
  });

  it("handles cap exceeded safely when req is missing or null", async () => {
    const res = createMockStream();
    const promise = collectBoundedResponse(res, null, 50);

    res.emit("data", Buffer.alloc(60, "x"));
    const out = await promise;
    assert.equal(out.ok, false);
    assert.equal(out.limitExceeded, true);
    assert.equal(res.isDestroyed, true);
  });

  it("handles stream error event gracefully", async () => {
    const res = createMockStream();
    const promise = collectBoundedResponse(res, null, 1024);

    res.emit("error", new Error("Socket disconnected"));
    const out = await promise;
    assert.equal(out.ok, false);
    assert.equal(out.limitExceeded, false);
    assert.equal(out.error.message, "Socket disconnected");
  });

  it("handles missing or invalid response streams", async () => {
    const out1 = await collectBoundedResponse(null);
    assert.equal(out1.ok, false);
    const out2 = await collectBoundedResponse({});
    assert.equal(out2.ok, false);
  });
});
