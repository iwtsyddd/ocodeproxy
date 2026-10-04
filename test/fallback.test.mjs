import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectWithFallback, tryStreamFallback } from "../lib/fallback.mjs";

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
});
