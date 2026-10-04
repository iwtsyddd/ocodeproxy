import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_RESPONSES_MODELS,
  MODEL_ALIASES,
  DISCONTINUED_MODELS,
  CLAUDE_DISCOVERY_ALIASES,
  resolveModel,
  resolveGatewayModel,
  buildDiscoveryList,
  isClaudeGatewayId,
  isModelDeprecated,
  isModelKnown,
  isModelResponses,
  partitionDiscovered,
  shouldKeepCurrent,
  getFallbackModels,
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
  it("maps unknown claude ids to the fallback model", () => {
    assert.equal(resolveGatewayModel("claude-sonnet-4-5", all, "big-pickle"), "big-pickle");
    assert.equal(resolveGatewayModel("claude-opus-4-8", all, "mimo-v2.6-flash-free"), "mimo-v2.6-flash-free");
  });
  it("maps provider-prefixed and gateway-alias ids to fallback", () => {
    assert.equal(resolveGatewayModel("bedrock/anthropic.claude-sonnet-4-5", all, "big-pickle"), "big-pickle");
    assert.equal(resolveGatewayModel("vertex_ai/claude-sonnet-4-6", all, "big-pickle"), "big-pickle");
    assert.equal(resolveGatewayModel("my-gateway-claude-sonnet", all, "big-pickle"), "big-pickle");
  });
  it("passes unknown non-claude ids through unresolved", () => {
    assert.equal(resolveGatewayModel("gpt-99", all, "big-pickle"), "gpt-99");
    assert.equal(resolveGatewayModel("gpt-99", [], "big-pickle"), "gpt-99");
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
