import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  firstSentence,
  slimToolDescriptions,
  TOOL_SLIM_MIN_CHARS,
} from "../lib/zendiet/tools.mjs";

import { optimizeContext } from "../lib/zendiet.mjs";

const longDesc = `${"A".repeat(50)}. Second sentence with details. Third sentence with even more details ${"x".repeat(400)}`;

describe("ZenDiet Tool Description Slimming", () => {
  it("cuts to the first sentence", () => {
    assert.equal(firstSentence("Read a file. Then more details here."), "Read a file.");
    assert.equal(firstSentence("Run it! Extra noise follows."), "Run it!");
    assert.equal(firstSentence("Short"), "Short");
    assert.equal(firstSentence(null), null);
    assert.equal(firstSentence(""), "");
  });

  it("hard-caps text without sentence boundary", () => {
    const blob = "z".repeat(500);
    const cut = firstSentence(blob);
    assert.ok(cut.length < blob.length);
    assert.ok(cut.endsWith("…"));
  });

  it("slims OpenAI-shape tools and preserves name, params and extras", () => {
    const tools = [{
      type: "function",
      function: { name: "read", description: longDesc, parameters: { type: "object" } },
      cache_control: { type: "ephemeral" },
    }];
    const res = slimToolDescriptions(tools);
    assert.equal(res.changed, true);
    assert.equal(res.slimmedCount, 1);
    assert.ok(res.savedChars > 0);
    assert.equal(res.tools[0].function.name, "read");
    assert.deepEqual(res.tools[0].function.parameters, { type: "object" });
    assert.deepEqual(res.tools[0].cache_control, { type: "ephemeral" });
    assert.ok(res.tools[0].function.description.length < longDesc.length);
    assert.ok(!res.tools[0].function.description.includes("Second sentence"));
  });

  it("slims Anthropic and Responses-flat shapes", () => {
    const tools = [
      { name: "grep", description: longDesc, input_schema: { type: "object" } },
      { type: "function", name: "bash", description: longDesc, parameters: { type: "object" } },
    ];
    const res = slimToolDescriptions(tools);
    assert.equal(res.changed, true);
    assert.equal(res.slimmedCount, 2);
    assert.equal(res.tools[0].name, "grep");
    assert.deepEqual(res.tools[0].input_schema, { type: "object" });
    assert.equal(res.tools[1].name, "bash");
  });

  it("leaves short descriptions untouched", () => {
    const tools = [{ type: "function", function: { name: "ls", description: "List files.", parameters: {} } }];
    const res = slimToolDescriptions(tools);
    assert.equal(res.changed, false);
    assert.equal(res.slimmedCount, 0);
    assert.deepEqual(res.tools, tools);
  });

  it("handles negatives without throwing", () => {
    for (const bad of [null, undefined, "tools", [{}, null, 42]]) {
      const res = slimToolDescriptions(bad);
      assert.equal(res.changed, false);
      assert.equal(res.savedTokens, 0);
    }
    const noDesc = [{ type: "function", function: { name: "x", parameters: {} } }];
    assert.equal(slimToolDescriptions(noDesc).changed, false);
    const numDesc = [{ name: "x", description: 42 }];
    assert.equal(slimToolDescriptions(numDesc).changed, false);
  });

  it("is off by default in optimizeContext and leaves tools alone", () => {
    const tools = [{ type: "function", function: { name: "read", description: longDesc, parameters: {} } }];
    const req = { messages: [{ role: "user", content: "hi" }], tools };
    for (const opts of [{}, { mode: "balanced" }, { mode: "aggressive" }, { toolSlim: false }]) {
      const res = optimizeContext(structuredClone(req), { ...opts, contextWindow: 128_000 });
      assert.equal(res.changed, false);
      assert.deepEqual(res.request.tools, tools);
      assert.ok(!res.decisions.some((d) => d.includes("toolslim:")));
    }
  });

  it("slims tools when toolSlim is enabled and counts savings", () => {
    const tools = [
      { type: "function", function: { name: "read", description: longDesc, parameters: { type: "object" } } },
      { type: "function", function: { name: "bash", description: longDesc, parameters: { type: "object" } } },
    ];
    const req = { messages: [{ role: "user", content: "hi" }], tools };
    const res = optimizeContext(structuredClone(req), { mode: "balanced", toolSlim: true, contextWindow: 128_000 });
    assert.equal(res.changed, true);
    assert.ok(res.stats.savedToolTokens > 0);
    assert.ok(res.decisions.some((d) => d.includes("toolslim: shortened 2 tool descriptions")));
    assert.equal(res.request.tools[0].function.name, "read");
    assert.deepEqual(res.request.tools[0].function.parameters, { type: "object" });
    assert.ok(res.request.tools[0].function.description.length < longDesc.length);
  });

  it("stays noop in mode off even with toolSlim enabled", () => {
    const tools = [{ type: "function", function: { name: "read", description: longDesc, parameters: {} } }];
    const req = { messages: [{ role: "user", content: "hi" }], tools };
    const res = optimizeContext(structuredClone(req), { mode: "off", toolSlim: true });
    assert.equal(res.changed, false);
    assert.deepEqual(res.request, req);
  });

  it("respects the minChars threshold", () => {
    const desc = `Sentence one here. ${"y".repeat(TOOL_SLIM_MIN_CHARS)}`;
    const tools = [{ name: "t", description: desc }];
    assert.equal(slimToolDescriptions(tools).changed, true);
    assert.equal(slimToolDescriptions(tools, { minChars: 100000 }).changed, false);
  });
});
