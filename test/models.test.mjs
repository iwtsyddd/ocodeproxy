import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_RESPONSES_MODELS,
  DEFAULT_MAX_CONSECUTIVE_SHRINKS,
  DEFAULT_SHRINK_TTL_MS,
  MODEL_ALIASES,
  DISCONTINUED_MODELS,
  CLAUDE_DISCOVERY_ALIASES,
  resolveModel,
  resolveGatewayModel,
  buildDiscoveryList,
  isClaudeGatewayId,
  isKnownGatewayAlias,
  isProviderRoutedId,
  suggestModelId,
  isModelDeprecated,
  isModelKnown,
  isModelResponses,
  partitionDiscovered,
  shouldKeepCurrent,
  getFallbackModels,
  candidateModels,
} from "../lib/models.mjs";

describe("resolveModel", () => {
  it("resolves known aliases", () => {
    assert.equal(resolveModel("muse-spark-1.3-free"), "muse-spark-1.3-contributor-free");
    assert.equal(resolveModel("mimo-v2.6-flash"), "mimo-v2.6-flash-free");
  });
  it("passes unknown models through and honors custom aliases", () => {
    assert.equal(resolveModel("big-pickle"), "big-pickle");
    assert.equal(resolveModel("x", { x: "y" }), "y");
  });
});

describe("isModelDeprecated", () => {
  it("flags discontinued ids directly", () => {
    assert.equal(isModelDeprecated("jev-1.13-free"), true);
    assert.equal(isModelDeprecated("deepseek-v4-flash"), true);
  });
  it("flags aliases that resolve to discontinued ids", () => {
    assert.equal(isModelDeprecated("old", new Set(["new"]), { old: "new" }), true);
    assert.equal(isModelDeprecated("big-pickle"), false);
  });
});

describe("isModelKnown / isModelResponses", () => {
  const all = [...DEFAULT_CHAT_MODELS, ...DEFAULT_RESPONSES_MODELS];
  const set = new Set(DEFAULT_RESPONSES_MODELS);
  it("matches direct and aliased ids", () => {
    assert.equal(isModelKnown("big-pickle", all), true);
    assert.equal(isModelKnown("muse-spark-1.3-free", all), true);
    assert.equal(isModelKnown("nope", all), false);
    assert.equal(isModelKnown("nope", []), false);
  });
  it("detects responses models via alias", () => {
    assert.equal(isModelResponses("muse-spark-1.3-contributor-free", set), true);
    assert.equal(isModelResponses("muse-spark-1.3-free", set), true);
    assert.equal(isModelResponses("big-pickle", set), false);
  });
});

describe("partitionDiscovered", () => {
  it("keeps free and big-pickle models, splits by prefix", () => {
    const out = partitionDiscovered([
      "muse-spark-x-free", "plain-free", "big-pickle", "paid-pro", null, "",
      "jev-1.13-free",
    ]);
    assert.deepEqual(out, { chat: ["plain-free", "big-pickle"], responses: ["muse-spark-x-free"] });
  });
  it("returns empty partitions for empty input", () => {
    assert.deepEqual(partitionDiscovered([]), { chat: [], responses: [] });
    assert.deepEqual(partitionDiscovered(null), { chat: [], responses: [] });
  });
  it("keeps suffixless free models via catalog metadata", () => {
    const meta = new Map([["grok-code", { id: "grok-code", free: true }]]);
    const out = partitionDiscovered(["grok-code", "paid-pro"], DISCONTINUED_MODELS, meta);
    assert.deepEqual(out, { chat: ["grok-code"], responses: [] });
  });
  it("metadata never revives discontinued ids", () => {
    const meta = new Map([["jev-1.13-free", { id: "jev-1.13-free", free: true }]]);
    const out = partitionDiscovered(["jev-1.13-free"], DISCONTINUED_MODELS, meta);
    assert.deepEqual(out, { chat: [], responses: [] });
  });
  it("metadata never drops name-matched ids", () => {
    const out = partitionDiscovered(["plain-free"], DISCONTINUED_MODELS, new Map());
    assert.deepEqual(out, { chat: ["plain-free"], responses: [] });
  });
});

describe("shouldKeepCurrent", () => {
  it("keeps the list when upstream shrinks", () => {
    const res = shouldKeepCurrent(
      { chat: ["a", "b"], responses: ["c"] },
      { chat: ["a"], responses: [] }
    );
    assert.equal(res.keep, true);
  });
  it("keeps the list when a non-empty category disappears", () => {
    assert.equal(shouldKeepCurrent({ chat: ["a"], responses: ["c"] }, { chat: ["a", "b"], responses: [] }).keep, true);
    assert.equal(shouldKeepCurrent({ chat: ["a"], responses: ["c"] }, { chat: [], responses: ["c", "d"] }).keep, true);
  });
  it("replaces on growth and from an empty list", () => {
    assert.deepEqual(shouldKeepCurrent({ chat: ["a"], responses: [] }, { chat: ["a", "b"], responses: ["c"] }), { keep: false, reason: "ok" });
    assert.deepEqual(shouldKeepCurrent({ chat: [], responses: [] }, { chat: [], responses: [] }), { keep: false, reason: "ok" });
  });
  it("forces replacement after reaching default max consecutive shrinks", () => {
    const state = { consecutive: 0, firstShrinkAt: 0 };
    const cur = { chat: ["a", "b", "c"], responses: ["r1"] };
    const disc = { chat: ["a"], responses: ["r1"] };

    const first = shouldKeepCurrent(cur, disc, state);
    assert.equal(first.keep, true);
    assert.equal(first.reason, "shrink");
    assert.equal(state.consecutive, 1);
    assert.ok(state.firstShrinkAt > 0);

    const second = shouldKeepCurrent(cur, disc, state);
    assert.equal(second.keep, true);
    assert.equal(second.reason, "shrink");
    assert.equal(state.consecutive, 2);

    const third = shouldKeepCurrent(cur, disc, state);
    assert.equal(third.keep, false);
    assert.equal(third.forced, true);
    assert.equal(third.reason, "force-replace-consecutive");
    assert.equal(state.consecutive, 0);
    assert.equal(state.firstShrinkAt, 0);
  });
  it("honors custom maxConsecutive threshold", () => {
    const state = { consecutive: 0, firstShrinkAt: 0, maxConsecutive: 2 };
    const cur = { chat: ["a", "b"], responses: [] };
    const disc = { chat: ["a"], responses: [] };

    const first = shouldKeepCurrent(cur, disc, state);
    assert.equal(first.keep, true);
    assert.equal(state.consecutive, 1);

    const second = shouldKeepCurrent(cur, disc, state);
    assert.equal(second.keep, false);
    assert.equal(second.forced, true);
    assert.equal(second.reason, "force-replace-consecutive");
    assert.equal(state.consecutive, 0);
  });
  it("resets consecutive counter and firstShrinkAt on catalog recovery or growth", () => {
    const state = { consecutive: 2, firstShrinkAt: 1000 };
    const cur = { chat: ["a", "b"], responses: [] };
    const recovered = { chat: ["a", "b", "c"], responses: ["r1"] };

    const res = shouldKeepCurrent(cur, recovered, state);
    assert.deepEqual(res, { keep: false, reason: "ok" });
    assert.equal(state.consecutive, 0);
    assert.equal(state.firstShrinkAt, 0);
  });
  it("forces replacement when shrink duration exceeds ttlMs", () => {
    const t0 = 1_000_000;
    const state = { consecutive: 0, firstShrinkAt: 0, maxConsecutive: 10, ttlMs: 60_000, now: t0 };
    const cur = { chat: ["a", "b", "c"], responses: [] };
    const disc = { chat: ["a"], responses: [] };

    const first = shouldKeepCurrent(cur, disc, state);
    assert.equal(first.keep, true);
    assert.equal(state.consecutive, 1);
    assert.equal(state.firstShrinkAt, t0);

    // Call again before TTL expires
    state.now = t0 + 30_000;
    const second = shouldKeepCurrent(cur, disc, state);
    assert.equal(second.keep, true);
    assert.equal(state.consecutive, 2);

    // Call after TTL expires
    state.now = t0 + 60_001;
    const third = shouldKeepCurrent(cur, disc, state);
    assert.equal(third.keep, false);
    assert.equal(third.forced, true);
    assert.equal(third.reason, "force-replace-ttl");
    assert.equal(state.consecutive, 0);
    assert.equal(state.firstShrinkAt, 0);
  });
  it("forces replacement when an entire category permanently disappears", () => {
    const state = { consecutive: 0, firstShrinkAt: 0, maxConsecutive: 3 };
    const cur = { chat: ["a"], responses: ["r1", "r2"] };
    // Total is higher, but responses category vanished
    const disc = { chat: ["a", "b", "c", "d"], responses: [] };

    const first = shouldKeepCurrent(cur, disc, state);
    assert.equal(first.keep, true);
    assert.equal(first.reason, "empty-responses");

    shouldKeepCurrent(cur, disc, state);
    const third = shouldKeepCurrent(cur, disc, state);
    assert.equal(third.keep, false);
    assert.equal(third.forced, true);
    assert.equal(third.reason, "force-replace-consecutive");
  });
  it("protects against empty catalog unless allowEmpty is explicitly enabled", () => {
    const state = { consecutive: 0, firstShrinkAt: 0, maxConsecutive: 1 };
    const cur = { chat: ["a", "b"], responses: ["r1"] };
    const emptyDisc = { chat: [], responses: [] };

    // Default allowEmpty = false prevents dropping all models even if consecutive threshold reached
    const res1 = shouldKeepCurrent(cur, emptyDisc, state);
    assert.equal(res1.keep, true);
    assert.equal(res1.reason, "shrink");

    const res2 = shouldKeepCurrent(cur, emptyDisc, state);
    assert.equal(res2.keep, true);

    // With allowEmpty = true, force-replace is permitted
    state.allowEmpty = true;
    state.consecutive = 1;
    const resForced = shouldKeepCurrent(cur, emptyDisc, state);
    assert.equal(resForced.keep, false);
    assert.equal(resForced.forced, true);
    assert.equal(resForced.reason, "force-replace-consecutive");
  });
  it("handles null, undefined, empty, and frozen options defensively", () => {
    assert.deepEqual(shouldKeepCurrent(null, null), { keep: false, reason: "ok" });
    assert.deepEqual(shouldKeepCurrent(undefined, undefined), { keep: false, reason: "ok" });
    assert.deepEqual(shouldKeepCurrent({}, {}), { keep: false, reason: "ok" });

    const frozen = Object.freeze({ maxConsecutive: 5 });
    const res = shouldKeepCurrent({ chat: ["a"], responses: [] }, { chat: [], responses: [] }, frozen);
    assert.equal(res.keep, true);
    assert.equal(DEFAULT_MAX_CONSECUTIVE_SHRINKS, 3);
    assert.equal(DEFAULT_SHRINK_TTL_MS, 3600000);
  });
});

describe("getFallbackModels", () => {
  const chat = ["a-free", "b-free", "big-pickle"];
  const resp = ["muse-spark-1.3-contributor-free", "muse-spark-1.2-contributor-free"];
  it("returns same-family models excluding the target", () => {
    assert.deepEqual(getFallbackModels("a-free", chat, resp), ["b-free", "big-pickle"]);
    assert.deepEqual(
      getFallbackModels("muse-spark-1.3-contributor-free", chat, resp),
      ["muse-spark-1.2-contributor-free"]
    );
  });
  it("resolves aliases before filtering", () => {
    assert.deepEqual(
      getFallbackModels("muse-spark-1.3-free", chat, resp),
      ["muse-spark-1.2-contributor-free"]
    );
  });
  it("returns empty when the family has one model", () => {
    assert.deepEqual(getFallbackModels("solo", ["solo"], []), []);
  });
});

describe("model catalog sanity", () => {
  it("ships non-empty defaults without discontinued entries", () => {
    assert.ok(DEFAULT_CHAT_MODELS.length > 0 && DEFAULT_RESPONSES_MODELS.length > 0);
    for (const id of [...DEFAULT_CHAT_MODELS, ...DEFAULT_RESPONSES_MODELS]) {
      assert.equal(DISCONTINUED_MODELS.has(id), false);
    }
    assert.ok(Object.keys(MODEL_ALIASES).length > 0);
  });
});

describe("isClaudeGatewayId", () => {
  it("matches claude/anthropic ids case-insensitively", () => {
    assert.equal(isClaudeGatewayId("claude-sonnet-4-5"), true);
    assert.equal(isClaudeGatewayId("Claude-Opus-4-8"), true);
    assert.equal(isClaudeGatewayId("bedrock/anthropic.claude-sonnet-4-5"), true);
    assert.equal(isClaudeGatewayId("vertex_ai/claude-sonnet-4-6"), true);
    assert.equal(isClaudeGatewayId("big-pickle"), false);
    assert.equal(isClaudeGatewayId("mimo-v2.6-flash-free"), false);
    assert.equal(isClaudeGatewayId(null), false);
    assert.equal(isClaudeGatewayId(""), false);
  });
});

describe("resolveGatewayModel", () => {
  const all = ["big-pickle", "mimo-v2.6-flash-free", "muse-spark-1.3-contributor-free"];
  it("resolves known ids and aliases normally", () => {
    assert.equal(resolveGatewayModel("big-pickle", all, "big-pickle"), "big-pickle");
    assert.equal(resolveGatewayModel("muse-spark-1.3-free", all, "big-pickle"), "muse-spark-1.3-contributor-free");
  });
  it("maps exact gateway aliases to the fallback model", () => {
    assert.equal(resolveGatewayModel("claude-sonnet-4-5", all, "big-pickle"), "big-pickle");
    assert.equal(resolveGatewayModel("claude-opus-4-8", all, "mimo-v2.6-flash-free"), "mimo-v2.6-flash-free");
  });
  it("maps provider-routed claude ids to fallback", () => {
    assert.equal(resolveGatewayModel("bedrock/anthropic.claude-sonnet-4-5", all, "big-pickle"), "big-pickle");
    assert.equal(resolveGatewayModel("vertex_ai/claude-sonnet-4-6", all, "big-pickle"), "big-pickle");
  });
  it("leaves bare claude typos unresolved instead of silently mapping them", () => {
    assert.equal(resolveGatewayModel("claude-sonnet-4-55", all, "big-pickle"), "claude-sonnet-4-55");
    assert.equal(resolveGatewayModel("claude-sonet-4-5", all, "big-pickle"), "claude-sonet-4-5");
    assert.equal(resolveGatewayModel("my-gateway-claude-sonnet", all, "big-pickle"), "my-gateway-claude-sonnet");
    assert.equal(resolveGatewayModel("anthropic-foo", all, "big-pickle"), "anthropic-foo");
    assert.equal(resolveGatewayModel("claude-sonnet-4-5", all, ""), "claude-sonnet-4-5");
  });
  it("passes unknown non-claude ids through unresolved", () => {
    assert.equal(resolveGatewayModel("gpt-99", all, "big-pickle"), "gpt-99");
    assert.equal(resolveGatewayModel("gpt-99", [], "big-pickle"), "gpt-99");
  });
});

describe("isKnownGatewayAlias / isProviderRoutedId", () => {
  it("matches exact discovery aliases only", () => {
    assert.equal(isKnownGatewayAlias("claude-sonnet-4-5"), true);
    assert.equal(isKnownGatewayAlias("claude-sonnet-4-55"), false);
    assert.equal(isKnownGatewayAlias("Claude-Sonnet-4-5"), false);
    assert.equal(isKnownGatewayAlias("big-pickle"), false);
    assert.equal(isKnownGatewayAlias(null), false);
    assert.equal(isKnownGatewayAlias(""), false);
  });
  it("detects provider routing by separator", () => {
    assert.equal(isProviderRoutedId("bedrock/anthropic.claude-sonnet-4-5"), true);
    assert.equal(isProviderRoutedId("vertex_ai/claude-sonnet-4-6"), true);
    assert.equal(isProviderRoutedId("claude-sonnet-4-5"), false);
    assert.equal(isProviderRoutedId(null), false);
    assert.equal(isProviderRoutedId(""), false);
  });
});

describe("suggestModelId", () => {
  const pool = ["big-pickle", "claude-sonnet-4-5", "mimo-v2.6-flash-free"];
  it("suggests the closest id for typos", () => {
    assert.equal(suggestModelId("claude-sonnet-4-55", pool), "claude-sonnet-4-5");
    assert.equal(suggestModelId("claude-sonet-4-5", pool), "claude-sonnet-4-5");
    assert.equal(suggestModelId("big-pickel", pool), "big-pickle");
  });
  it("returns undefined when nothing is close or input is bad", () => {
    assert.equal(suggestModelId("gpt-99", pool), undefined);
    assert.equal(suggestModelId("", pool), undefined);
    assert.equal(suggestModelId(null, pool), undefined);
    assert.equal(suggestModelId("big-pickle", []), undefined);
    assert.equal(suggestModelId("big-pickle", null), undefined);
  });
});

describe("buildDiscoveryList", () => {
  it("keeps real ids and appends claude aliases deduped", () => {
    const list = buildDiscoveryList(["big-pickle"]);
    assert.ok(list.includes("big-pickle"));
    for (const alias of CLAUDE_DISCOVERY_ALIASES) {
      assert.ok(list.includes(alias));
      assert.equal(list.filter((id) => id === alias).length, 1);
    }
  });
  it("does not duplicate aliases already present", () => {
    const list = buildDiscoveryList(["big-pickle", "claude-sonnet-4-5"]);
    assert.equal(list.filter((id) => id === "claude-sonnet-4-5").length, 1);
  });
  it("passes the Claude Code discovery filter", () => {
    const list = buildDiscoveryList(["big-pickle", "mimo-v2.6-flash-free"]);
    const kept = list.filter(isClaudeGatewayId);
    assert.ok(kept.length >= CLAUDE_DISCOVERY_ALIASES.length);
  });
});

describe("candidateModels", () => {
  const chat = ["m1", "m2", "m3"];
  const resp = ["muse-spark-a", "muse-spark-b"];
  it("returns target plus fallbacks capped at maxAttempts", () => {
    assert.deepEqual(candidateModels("m1", chat, resp, 3), ["m1", "m2", "m3"]);
    assert.deepEqual(candidateModels("m1", chat, resp, 2), ["m1", "m2"]);
  });
  it("honors maxAttempts=1 with exactly one attempt (no same-model retry)", () => {
    assert.deepEqual(candidateModels("m1", chat, resp, 1), ["m1"]);
  });
  it("never repeats a model in a single-model family", () => {
    assert.deepEqual(candidateModels("solo", ["solo"], [], 3), ["solo"]);
    assert.deepEqual(candidateModels("solo", ["solo"], [], 1), ["solo"]);
  });
  it("dedupes repeated ids and skips blanks", () => {
    assert.deepEqual(candidateModels("m1", ["m1", "m1", "m2", "m2"], resp, 10), ["m1", "m2"]);
  });
  it("handles negatives without throwing", () => {
    assert.deepEqual(candidateModels(null, chat, resp, 3), []);
    assert.deepEqual(candidateModels("", chat, resp, 3), []);
    assert.deepEqual(candidateModels("m1", null, null, 0), ["m1"]);
  });
});
