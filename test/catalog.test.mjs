import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isFreeByCost,
  extractModelMeta,
  parseModelsDevCatalog,
  serializeMetaMap,
  deserializeMetaMap,
  metaForId,
  isResponsesByNpm,
} from "../lib/catalog.mjs";

const PAYLOAD = {
  opencode: {
    models: {
      "big-pickle": {
        name: "Big Pickle",
        description: "Reasoning model",
        family: "big-pickle",
        tool_call: true,
        reasoning: true,
        attachment: false,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 200000, input: 160000, output: 32000 },
        cost: { input: 0, output: 0, cache_read: 0 },
      },
      // no -free suffix: name-based filter would drop it, cost must keep it
      "grok-code": {
        name: "Grok Code",
        limit: { context: 131072, output: 8192 },
        cost: { input: 0, output: 0 },
        provider: { npm: "@ai-sdk/openai-compatible" },
      },
      "paid-pro": {
        name: "Paid",
        limit: { context: 1000, output: 100 },
        cost: { input: 1.5, output: 2 },
      },
      // absent cost means unknown, never free
      "mystery-free": { name: "Mystery", limit: { context: 1000, output: 100 } },
      "broken-entry": null,
    },
  },
};

describe("isFreeByCost", () => {
  it("requires explicit all-zero input+output prices", () => {
    assert.equal(isFreeByCost({ cost: { input: 0, output: 0 } }), true);
    assert.equal(isFreeByCost({ cost: { input: 0, output: 0, cache_read: 0 } }), true);
    assert.equal(isFreeByCost({ cost: { input: 0, output: 0.5 } }), false);
    assert.equal(isFreeByCost({}), false);
    assert.equal(isFreeByCost({ cost: null }), false);
    assert.equal(isFreeByCost(null), false);
  });
});

describe("parseModelsDevCatalog", () => {
  it("keeps only free-by-cost models including suffixless ids", () => {
    const map = parseModelsDevCatalog(PAYLOAD);
    assert.ok(map.has("big-pickle"));
    assert.ok(map.has("grok-code"));
    assert.ok(!map.has("paid-pro"));
    assert.ok(!map.has("mystery-free"));
    assert.ok(!map.has("broken-entry"));
  });
  it("extracts limits and capabilities", () => {
    const map = parseModelsDevCatalog(PAYLOAD);
    assert.equal(map.get("big-pickle").contextWindow, 200000);
    assert.equal(map.get("big-pickle").maxOutputTokens, 32000);
    assert.equal(map.get("big-pickle").description, "Reasoning model");
    assert.equal(map.get("big-pickle").toolCall, true);
    assert.deepEqual(map.get("big-pickle").inputModalities, ["text"]);
  });
  it("returns an empty map for malformed payloads", () => {
    assert.equal(parseModelsDevCatalog(null).size, 0);
    assert.equal(parseModelsDevCatalog({}).size, 0);
    assert.equal(parseModelsDevCatalog({ opencode: null }).size, 0);
    assert.equal(parseModelsDevCatalog({ opencode: { models: [] } }).size, 0);
  });
});

describe("extractModelMeta", () => {
  it("treats status as informational, not filtering", () => {
    const meta = extractModelMeta("mimo-v2.5-free", {
      limit: { context: 200000, output: 32000 },
      status: "deprecated",
      cost: { input: 0, output: 0 },
    });
    assert.equal(meta.status, "deprecated");
    assert.equal(meta.contextWindow, 200000);
  });
  it("rejects bad input without throwing", () => {
    assert.equal(extractModelMeta("", {}), null);
    assert.equal(extractModelMeta("x", null), null);
    assert.equal(extractModelMeta("x", []), null);
  });
});

describe("serialize/deserializeMetaMap", () => {
  it("round-trips the map through the disk-cache shape", () => {
    const map = parseModelsDevCatalog(PAYLOAD);
    const restored = deserializeMetaMap(serializeMetaMap(map));
    assert.equal(restored.size, map.size);
    assert.equal(restored.get("big-pickle").contextWindow, 200000);
  });
  it("restores nothing from malformed caches", () => {
    assert.equal(deserializeMetaMap(null).size, 0);
    assert.equal(deserializeMetaMap({ meta: [] }).size, 0);
  });
});

describe("metaForId", () => {
  it("serves direct hits and alias fallback, undefined otherwise", () => {
    const map = parseModelsDevCatalog(PAYLOAD);
    assert.equal(metaForId("big-pickle", map, "grok-code").contextWindow, 200000);
    const alias = metaForId("claude-sonnet-4-5", map, "big-pickle");
    assert.equal(alias.contextWindow, 200000);
    assert.equal(alias.aliasFor, "big-pickle");
    assert.equal(alias.id, "claude-sonnet-4-5");
    assert.equal(metaForId("unknown", map, "also-unknown"), undefined);
    assert.equal(metaForId("unknown", null, null), undefined);
  });
});

describe("isResponsesByNpm", () => {
  it("signals Responses only for @ai-sdk/openai", () => {
    assert.equal(isResponsesByNpm({ providerNpm: "@ai-sdk/openai" }), true);
    assert.equal(isResponsesByNpm({ providerNpm: "@ai-sdk/openai-compatible" }), false);
    assert.equal(isResponsesByNpm({}), undefined);
    assert.equal(isResponsesByNpm(null), undefined);
  });
});
