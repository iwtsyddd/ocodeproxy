import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickChatParams,
  pickResponsesParams,
  chatParamsToResponsesParams,
  anthropicParamsToChat,
  anthropicToOpenAI,
} from "../lib/convert.mjs";

describe("pickChatParams", () => {
  it("forwards valid sampling params", () => {
    assert.deepEqual(
      pickChatParams({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1024,
        stop: ["</end>", "STOP"],
        presence_penalty: -1,
        frequency_penalty: 1.5,
        seed: 42,
        reasoning_effort: "xhigh",
        parallel_tool_calls: false,
      }),
      {
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1024,
        stop: ["</end>", "STOP"],
        presence_penalty: -1,
        frequency_penalty: 1.5,
        seed: 42,
        reasoning_effort: "xhigh",
        parallel_tool_calls: false,
      }
    );
  });
  it("drops out-of-range values and unknown keys", () => {
    assert.deepEqual(
      pickChatParams({
        temperature: 5,
        top_p: -1,
        max_tokens: 0,
        stop: [42],
        presence_penalty: "high",
        seed: 1.5,
        reasoning_effort: "ultra",
        model: "m",
        stream: true,
      }),
      {}
    );
  });
  it("handles missing and non-object input", () => {
    assert.deepEqual(pickChatParams(undefined), {});
    assert.deepEqual(pickChatParams(null), {});
  });
});

describe("pickResponsesParams", () => {
  it("forwards Responses params and maps max_tokens alias", () => {
    assert.deepEqual(
      pickResponsesParams({ temperature: 0.5, max_tokens: 512, truncation: "auto", reasoning: { effort: "high" }, parallel_tool_calls: true }),
      { temperature: 0.5, max_output_tokens: 512, truncation: "auto", reasoning: { effort: "high" }, parallel_tool_calls: true }
    );
  });
  it("maps flat reasoning_effort and prefers max_output_tokens", () => {
    assert.deepEqual(
      pickResponsesParams({ max_output_tokens: 100, max_tokens: 200, reasoning_effort: "low" }),
      { max_output_tokens: 100, reasoning: { effort: "low" } }
    );
  });
  it("drops invalid truncation, reasoning and unknown keys", () => {
    assert.deepEqual(
      pickResponsesParams({ truncation: "sometimes", reasoning: { effort: "ultra" }, input: "hi" }),
      {}
    );
  });
});

describe("chatParamsToResponsesParams", () => {
  it("maps chat params onto Responses fields", () => {
    assert.deepEqual(
      chatParamsToResponsesParams({ temperature: 0.3, top_p: 0.8, max_tokens: 256, reasoning_effort: "medium", stop: "END", stream: true }),
      { temperature: 0.3, top_p: 0.8, max_output_tokens: 256, reasoning: { effort: "medium" } }
    );
  });
  it("prefers max_completion_tokens and returns empty for no params", () => {
    assert.deepEqual(chatParamsToResponsesParams({ max_tokens: 10, max_completion_tokens: 20 }), { max_output_tokens: 20 });
    assert.deepEqual(chatParamsToResponsesParams({}), {});
  });
});

describe("anthropicParamsToChat", () => {
  it("maps max_tokens, temperature, top_p and stop_sequences", () => {
    assert.deepEqual(
      anthropicParamsToChat({ max_tokens: 1024, temperature: 0.7, top_p: 0.9, stop_sequences: ["a"] }),
      { max_tokens: 1024, temperature: 0.7, top_p: 0.9, stop: ["a"] }
    );
  });
  it("drops top_k which has no OpenAI equivalent", () => {
    assert.deepEqual(anthropicParamsToChat({ top_k: 40 }), {});
  });
});

describe("anthropicToOpenAI params", () => {
  it("exposes sampling params alongside messages", () => {
    const out = anthropicToOpenAI({
      model: "m",
      max_tokens: 512,
      temperature: 0.2,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(out.params, { max_tokens: 512, temperature: 0.2 });
    assert.equal(out.messages.length, 1);
  });
});
