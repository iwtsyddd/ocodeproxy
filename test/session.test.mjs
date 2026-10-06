import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_SESSION_MAX_ENTRIES,
  DEFAULT_SESSION_SWEEP_INTERVAL_MS,
  resolveSessionTtlMs,
  resolveSessionMaxEntries,
  createSessionStore,
} from "../lib/session.mjs";

describe("resolveSessionTtlMs", () => {
  it("returns default for missing or invalid inputs", () => {
    assert.equal(resolveSessionTtlMs(undefined), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs(null), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs(""), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs("invalid"), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs(0), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs(-1000), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs(NaN), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs(Infinity), DEFAULT_SESSION_TTL_MS);
    assert.equal(resolveSessionTtlMs(true), DEFAULT_SESSION_TTL_MS);
  });

  it("accepts valid positive numbers and numeric strings", () => {
    assert.equal(resolveSessionTtlMs(60000), 60000);
    assert.equal(resolveSessionTtlMs("120000"), 120000);
    assert.equal(resolveSessionTtlMs(" 300000 "), 300000);
  });
});

describe("resolveSessionMaxEntries", () => {
  it("returns default for missing or invalid inputs", () => {
    assert.equal(resolveSessionMaxEntries(undefined), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries(null), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries(""), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries("not-a-number"), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries(0), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries(-50), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries(1.5), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries(NaN), DEFAULT_SESSION_MAX_ENTRIES);
    assert.equal(resolveSessionMaxEntries(false), DEFAULT_SESSION_MAX_ENTRIES);
  });

  it("accepts valid positive integers and numeric strings", () => {
    assert.equal(resolveSessionMaxEntries(100), 100);
    assert.equal(resolveSessionMaxEntries("500"), 500);
    assert.equal(resolveSessionMaxEntries(" 250 "), 250);
  });
});

describe("createSessionStore", () => {
  it("initializes safely with missing or non-object options", () => {
    const s1 = createSessionStore();
    assert.equal(s1.size, 0);
    const s2 = createSessionStore(null);
    assert.equal(s2.size, 0);
    const s3 = createSessionStore("invalid");
    assert.equal(s3.size, 0);
  });

  it("reuses session id for the same user within TTL", () => {
    let nowMs = 1000;
    let nextId = 1;
    const store = createSessionStore({
      ttlMs: 5000,
      now: () => nowMs,
      makeId: () => `ses-${nextId++}`,
    });

    const id1 = store.get("userA");
    assert.equal(id1, "ses-1");
    assert.equal(store.size, 1);

    nowMs = 3000;
    const id2 = store.get("userA");
    assert.equal(id2, "ses-1");
    assert.equal(store.size, 1);

    const idB = store.get("userB");
    assert.equal(idB, "ses-2");
    assert.equal(store.size, 2);
  });

  it("rotates session id after TTL expiry", () => {
    let nowMs = 1000;
    let nextId = 1;
    const store = createSessionStore({
      ttlMs: 5000,
      now: () => nowMs,
      makeId: () => `ses-${nextId++}`,
    });

    const id1 = store.get("userA");
    assert.equal(id1, "ses-1");

    // Advance past TTL
    nowMs = 7000;
    const id2 = store.get("userA");
    assert.equal(id2, "ses-2");
    assert.equal(store.size, 1);
  });

  it("enforces absolute expiry from creation even with intermittent hits", () => {
    let nowMs = 1000;
    let nextId = 1;
    const store = createSessionStore({
      ttlMs: 5000,
      now: () => nowMs,
      makeId: () => `ses-${nextId++}`,
    });

    assert.equal(store.get("userA"), "ses-1");

    // Access at t = 4000 (age 3000, within 5000 ttl)
    nowMs = 4000;
    assert.equal(store.get("userA"), "ses-1");

    // Access at t = 6001 (age 5001 from creation at t = 1000)
    // Absolute expiry rotates to a new session id
    nowMs = 6001;
    assert.equal(store.get("userA"), "ses-2");
  });

  it("evicts oldest entries when maxEntries is exceeded (LRU)", () => {
    let nextId = 1;
    const store = createSessionStore({
      maxEntries: 2,
      makeId: () => `ses-${nextId++}`,
    });

    store.get("u1"); // ses-1
    store.get("u2"); // ses-2
    assert.equal(store.size, 2);
    assert.equal(store.has("u1"), true);
    assert.equal(store.has("u2"), true);

    // Adding u3 evicts u1 (oldest)
    store.get("u3"); // ses-3
    assert.equal(store.size, 2);
    assert.equal(store.has("u1"), false);
    assert.equal(store.has("u2"), true);
    assert.equal(store.has("u3"), true);
  });

  it("accessing an existing user refreshes recency and protects it from LRU eviction", () => {
    let nextId = 1;
    const store = createSessionStore({
      maxEntries: 2,
      makeId: () => `ses-${nextId++}`,
    });

    store.get("u1"); // ses-1
    store.get("u2"); // ses-2

    // Access u1 -> refreshes recency, order becomes: u2, u1
    store.get("u1");

    // Adding u3 evicts u2 instead of u1
    store.get("u3");
    assert.equal(store.size, 2);
    assert.equal(store.has("u1"), true);
    assert.equal(store.has("u2"), false);
    assert.equal(store.has("u3"), true);
  });

  it("sweep removes only expired entries", () => {
    let nowMs = 1000;
    let nextId = 1;
    const store = createSessionStore({
      ttlMs: 5000,
      now: () => nowMs,
      makeId: () => `ses-${nextId++}`,
    });

    store.get("u1"); // created at 1000, expires at 6000
    nowMs = 3000;
    store.get("u2"); // created at 3000, expires at 8000

    assert.equal(store.size, 2);

    // Sweep at 5500: nothing expired yet
    nowMs = 5500;
    assert.equal(store.sweep(), 0);
    assert.equal(store.size, 2);

    // Sweep at 6500: u1 expired (>5000 old), u2 active (3500 old)
    nowMs = 6500;
    assert.equal(store.sweep(), 1);
    assert.equal(store.size, 1);
    assert.equal(store.has("u1"), false);
    assert.equal(store.has("u2"), true);

    // Sweep with explicit timestamp
    assert.equal(store.sweep(9000), 1);
    assert.equal(store.size, 0);
  });

  it("does not store anonymous or invalid users and generates fresh ids", () => {
    let nextId = 1;
    const store = createSessionStore({
      makeId: () => `ses-${nextId++}`,
    });

    const badInputs = [null, undefined, "", "   ", 123, {}, [], true, false];
    for (const bad of badInputs) {
      const id = store.get(bad);
      assert.match(id, /^ses-\d+$/);
    }
    assert.equal(store.size, 0);
    assert.equal(store.has(null), false);
    assert.equal(store.peek(""), undefined);
  });

  it("peek and has do not alter LRU order or create entries", () => {
    let nextId = 1;
    const store = createSessionStore({
      maxEntries: 2,
      makeId: () => `ses-${nextId++}`,
    });

    store.get("u1");
    store.get("u2");

    // peek u1 does NOT refresh LRU order
    assert.equal(store.peek("u1"), "ses-1");
    assert.equal(store.has("u1"), true);
    assert.equal(store.peek("unknown"), undefined);
    assert.equal(store.has("unknown"), false);

    // Adding u3 should still evict u1
    store.get("u3");
    assert.equal(store.has("u1"), false);
    assert.equal(store.has("u2"), true);
    assert.equal(store.has("u3"), true);
  });

  it("clear drops all entries", () => {
    const store = createSessionStore();
    store.get("u1");
    store.get("u2");
    assert.equal(store.size, 2);
    store.clear();
    assert.equal(store.size, 0);
    assert.equal(store.has("u1"), false);
  });

  it("exposes default sweep interval constant", () => {
    assert.equal(DEFAULT_SESSION_SWEEP_INTERVAL_MS, 5 * 60 * 1000);
  });
});
