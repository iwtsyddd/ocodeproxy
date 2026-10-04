import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeResponsesTools,
  responsesInputToChatMessages,
  chatCompletionToResponses,
  aggregateResponsesSseToResponses,
  estimateAnthropicTokens,
} from "../lib/convert.mjs";

describe("normalizeResponsesTools", () => {
  it("normalizes Responses API tools", () => {
    const out = normalizeResponsesTools([
      { type: "function", name: "read", description: "r", parameters: { type: "object" } },
      { function: { name: "bash", description: "d", parameters: {} } },
      null,
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, "read");
  });
});

describe("responsesInputToChatMessages", () => {
  it("maps string input to user message", () => {
    assert.deepEqual(responsesInputToChatMessages("hi"), [{ role: "user", content: "hi" }]);
  });
  it("folds instructions into system message", () => {
    const out = responsesInputToChatMessages([{ role: "user", content: "hi" }], "sys");
    assert.equal(out[0].role, "system");
    assert.equal(out[1].role, "user");
  });
  it("maps function_call and function_call_output", () => {
    const out = responsesInputToChatMessages([
      { type: "function_call", id: "fc1", call_id: "c1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]);
    assert.equal(out[0].role, "assistant");
    assert.equal(out[0].tool_calls[0].function.name, "read");
    assert.deepEqual(out[1], { role: "tool", tool_call_id: "c1", content: "ok" });
  });
});

describe("chatCompletionToResponses", () => {
  it("builds Responses object and filters fingerprint tools", () => {
    const out = chatCompletionToResponses({
      id: "chatcmpl-1",
      created: 7,
      choices: [{
        finish_reason: "stop",
        message: {
          content: "hi",
          reasoning_content: "r",
          tool_calls: [
            { id: "c1", function: { name: "get_weather", arguments: "{}" } },
            { id: "c2", function: { name: "bash", arguments: "{}" } },
          ],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }, "m");
    assert.equal(out.object, "response");
    assert.equal(out.model, "m");
    assert.ok(out.output.some((o) => o.type === "message"));
    assert.ok(out.output.some((o) => o.type === "function_call" && o.name === "get_weather"));
    assert.ok(!out.output.some((o) => o.name === "bash"));
    assert.deepEqual(out.usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });
});

describe("aggregateResponsesSseToResponses", () => {
  it("aggregates Responses SSE into Responses object", () => {
    const raw = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } })}`,
    ].join("\n");
    const out = aggregateResponsesSseToResponses(raw, "m");
    assert.equal(out.object, "response");
    assert.ok(out.output.some((o) => o.type === "message"));
  });
});

describe("estimateAnthropicTokens", () => {
  it("counts system, messages and tools", () => {
    const n = estimateAnthropicTokens({
      system: "hello world",
      messages: [{ role: "user", content: "hi there" }],
      tools: [{ name: "read" }],
    });
    assert.ok(n > 5);
  });
  it("returns 0 for empty body and counts images", () => {
    assert.equal(estimateAnthropicTokens({}), 0);
    const n = estimateAnthropicTokens({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] });
    assert.ok(n >= 85);
  });
});
