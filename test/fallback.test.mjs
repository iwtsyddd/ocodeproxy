import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectWithFallback, tryStreamFallback, isClientGone, abortClientStream, lazyAttempt } from "../lib/fallback.mjs";

describe("collectWithFallback", () => {
  const ok = (model) => ({ status: 200, raw: `data: ${model}`, headers: {} });
  it("returns the first success tagged with its model", async () => {
    const out = await collectWithFallback(
      [{ body: "b1", options: {}, model: "m1" }],
      async () => ok("m1"),
      { fallbackDelayMs: 0 }
    );
    assert.equal(out.model, "m1");
    assert.equal(out.raw, "data: m1");
  });
  it("falls over to the next model on retryable errors", async () => {
    const calls = [];
    const out = await collectWithFallback(
      [
        { body: "b1", options: {}, model: "m1" },
        { body: "b2", options: {}, model: "m2" },
      ],
      async (_o, b) => {
        calls.push(b);
        return b === "b1" ? { status: 429, error: { message: "slow" }, headers: {} } : ok("m2");
      },
      { fallbackDelayMs: 0 }
    );
    assert.deepEqual(calls, ["b1", "b2"]);
    assert.equal(out.model, "m2");
  });
  it("does not fall over on non-retryable errors", async () => {
    const calls = [];
    const out = await collectWithFallback(
      [
        { body: "b1", options: {}, model: "m1" },
        { body: "b2", options: {}, model: "m2" },
      ],
      async (_o, b) => {
        calls.push(b);
        return { status: 400, error: { message: "bad" }, headers: {} };
      },
      { fallbackDelayMs: 0 }
    );
    assert.deepEqual(calls, ["b1"]);
    assert.equal(out.model, "m1");
    assert.equal(out.status, 400);
  });
  it("falls over on network throws and rethrows the last one", async () => {
    let out;
    try {
      await collectWithFallback(
        [
          { body: "b1", options: {}, model: "m1" },
          { body: "b2", options: {}, model: "m2" },
        ],
        async () => { throw new Error("down"); },
        { fallbackDelayMs: 0 }
      );
    } catch (e) {
      out = e;
    }
    assert.equal(out?.message, "down");
  });
  it("never retries mid-stream failures", async () => {
    const calls = [];
    try {
      await collectWithFallback(
        [
          { body: "b1", options: {}, model: "m1" },
          { body: "b2", options: {}, model: "m2" },
        ],
        async (_o, b) => {
          calls.push(b);
          const err = new Error("cut");
          err.upstreamStarted = true;
          throw err;
        },
        { fallbackDelayMs: 0 }
      );
    } catch {}
    assert.deepEqual(calls, ["b1"]);
  });
  it("requires at least one attempt", async () => {
    await assert.rejects(collectWithFallback([], async () => ({}), { fallbackDelayMs: 0 }));
  });
});

describe("tryStreamFallback", () => {
  it("schedules the next attempt and returns true", async () => {
    const seen = [];
    const res = { headersSent: false, writableEnded: false };
    const ok = tryStreamFallback(
      { attempts: [{ model: "m1" }, { model: "m2" }], attemptIndex: 0 },
      res,
      (nxt, ex) => seen.push([nxt.model, ex.attemptIndex]),
      { fallbackDelayMs: 0 }
    );
    assert.equal(ok, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [["m2", 1]]);
  });
  it("returns false when exhausted or response already started", () => {
    const res = { headersSent: false, writableEnded: false };
    assert.equal(
      tryStreamFallback({ attempts: [{ model: "m1" }], attemptIndex: 0 }, res, () => {}, { fallbackDelayMs: 0 }),
      false
    );
    assert.equal(
      tryStreamFallback(
        { attempts: [{ model: "m1" }, { model: "m2" }], attemptIndex: 0 },
        { headersSent: true, writableEnded: false },
        () => {},
        { fallbackDelayMs: 0 }
      ),
      false
    );
  });
  it("does not fire a scheduled retry after the client disconnects", async () => {
    const seen = [];
    const res = { headersSent: false, writableEnded: false };
    const ok = tryStreamFallback(
      { attempts: [{ model: "m1" }, { model: "m2" }], attemptIndex: 0 },
      res,
      (nxt) => seen.push(nxt.model),
      { fallbackDelayMs: 5 }
    );
    assert.equal(ok, true);
    res.destroyed = true;
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(seen, []);
  });
  it("still fires when the client stays connected", async () => {
    const seen = [];
    const res = { headersSent: false, writableEnded: false };
    tryStreamFallback(
      { attempts: [{ model: "m1" }, { model: "m2" }], attemptIndex: 0 },
      res,
      (nxt) => seen.push(nxt.model),
      { fallbackDelayMs: 5 }
    );
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(seen, ["m2"]);
  });
});

describe("lazyAttempt", () => {
  it("defers build until body/options access and caches the result", () => {
    let calls = 0;
    const a = lazyAttempt("m1", () => {
      calls++;
      return { body: "b1", options: { host: "h" } };
    });
    assert.equal(a.model, "m1");
    assert.equal(calls, 0);
    assert.equal(a.body, "b1");
    assert.equal(calls, 1);
    assert.deepEqual(a.options, { host: "h" });
    assert.equal(a.body, "b1");
    assert.equal(calls, 1);
  });
  it("rejects missing or invalid build functions", () => {
    assert.throws(() => lazyAttempt("m1", null), TypeError);
    assert.throws(() => lazyAttempt("m1", "b1"), TypeError);
    assert.throws(() => lazyAttempt("m1"), TypeError);
  });
  it("builds only visited attempts in collectWithFallback", async () => {
    const built = [];
    const attempts = ["m1", "m2", "m3"].map((m) =>
      lazyAttempt(m, () => {
        built.push(m);
        return { body: `b-${m}`, options: {} };
      })
    );
    assert.deepEqual(built, []);
    const out = await collectWithFallback(
      attempts,
      async (_o, b) => ({ status: 200, raw: b, headers: {} }),
      { fallbackDelayMs: 0 }
    );
    assert.equal(out.model, "m1");
    assert.deepEqual(built, ["m1"]);
  });
  it("builds the next attempt only on fallback", async () => {
    const built = [];
    const attempts = ["m1", "m2"].map((m) =>
      lazyAttempt(m, () => {
        built.push(m);
        return { body: `b-${m}`, options: {} };
      })
    );
    const out = await collectWithFallback(
      attempts,
      async (_o, b) => (b === "b-m1" ? { status: 429, error: { message: "slow" }, headers: {} } : { status: 200, raw: b, headers: {} }),
      { fallbackDelayMs: 0 }
    );
    assert.equal(out.model, "m2");
    assert.deepEqual(built, ["m1", "m2"]);
  });
  it("defers the next build until a stream retry fires", async () => {
    let secondBuilt = false;
    const first = lazyAttempt("m1", () => ({ body: "b1", options: {} }));
    const second = lazyAttempt("m2", () => {
      secondBuilt = true;
      return { body: "b2", options: {} };
    });
    const seen = [];
    const res = { headersSent: false, writableEnded: false };
    const ok = tryStreamFallback(
      { attempts: [first, second], attemptIndex: 0 },
      res,
      (nxt) => seen.push([nxt.model, nxt.body]),
      { fallbackDelayMs: 0 }
    );
    assert.equal(ok, true);
    assert.equal(secondBuilt, false);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [["m2", "b2"]]);
    assert.equal(secondBuilt, true);
  });
});

describe("isClientGone", () => {
  it("detects ended, destroyed and closed responses", () => {
    assert.equal(isClientGone({ writableEnded: true }), true);
    assert.equal(isClientGone({ destroyed: true }), true);
    assert.equal(isClientGone({ closed: true }), true);
    assert.equal(isClientGone({ writableEnded: false, destroyed: false }), false);
  });
  it("treats missing responses as gone", () => {
    assert.equal(isClientGone(null), true);
    assert.equal(isClientGone(undefined), true);
    assert.equal(isClientGone(42), true);
  });
});

describe("abortClientStream", () => {
  it("destroys a live response without ending it normally", () => {
    let destroyed = false;
    const res = {
      writableEnded: false,
      destroyed: false,
      destroy() { destroyed = true; },
      end() { throw new Error("must not end normally"); },
    };
    abortClientStream(res);
    assert.equal(destroyed, true);
  });
  it("leaves ended, destroyed and missing responses alone", () => {
    let calls = 0;
    abortClientStream({ writableEnded: true, destroy() { calls++; } });
    abortClientStream({ writableEnded: false, destroyed: true, destroy() { calls++; } });
    abortClientStream(null);
    abortClientStream(undefined);
    assert.equal(calls, 0);
  });
});
