import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  openAIContentToResponsesText,
  openAIContentToResponsesInput,
  anthropicImageToOpenAI,
  anthropicDocumentText,
  anthropicToolResultText,
  pickCacheControl,
} from "../lib/content.mjs";
import {
  FINGERPRINT_TOOLS,
  decoyTool,
  toolName,
  ensureFingerprintTools,
  ensureAssistantReasoning,
  chatToResponses,
  responsesToOpenAI,
  aggregateSseToCompletion,
  aggregateResponsesSseToOpenAI,
  anthropicToOpenAI,
  openAIToAnthropic,
  isAttributionText,
  stripAttributionBlocks,
  validateAnthropicMessagesBody,
  anthropicParamsToChat,
  createAnthropicBlockTracker,
} from "../lib/convert.mjs";

describe("openAIContentToResponsesText", () => {
  it("passes strings through", () => {
    assert.equal(openAIContentToResponsesText("hello"), "hello");
  });
  it("joins text parts and drops non-text", () => {
    assert.equal(openAIContentToResponsesText([{ text: "a" }, "b", { type: "image" }, null]), "a\nb");
  });
  it("returns empty string for non-array input", () => {
    assert.equal(openAIContentToResponsesText(undefined), "");
    assert.equal(openAIContentToResponsesText(42), "");
  });
});

describe("openAIContentToResponsesInput", () => {
  it("wraps a plain string", () => {
    assert.deepEqual(openAIContentToResponsesInput("hi"), [{ type: "input_text", text: "hi" }]);
  });
  it("maps text and image parts, drops unknown", () => {
    const out = openAIContentToResponsesInput([
      { type: "text", text: "see" },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
      { type: "input_image", image_url: "data:img" },
      { type: "audio", data: "x" },
      null,
    ]);
    assert.deepEqual(out, [
      { type: "input_text", text: "see" },
      { type: "input_image", image_url: "https://x/y.png" },
      { type: "input_image", image_url: "data:img" },
    ]);
  });
  it("falls back to a single empty text part", () => {
    assert.deepEqual(openAIContentToResponsesInput([]), [{ type: "input_text", text: "" }]);
    assert.deepEqual(openAIContentToResponsesInput(null), [{ type: "input_text", text: "" }]);
  });
});

describe("chatToResponses", () => {
  it("folds system and developer messages into instructions", () => {
    const body = chatToResponses("m", [
      { role: "system", content: "sys" },
      { role: "developer", content: "dev" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(body.instructions, "sys\ndev");
    assert.equal(body.input.length, 1);
  });
  it("maps tool results to function_call_output", () => {
    const body = chatToResponses("m", [{ role: "tool", tool_call_id: "c1", content: "out" }]);
    assert.deepEqual(body.input[0], { type: "function_call_output", call_id: "c1", output: "out" });
  });
  it("maps assistant tool_calls", () => {
    const body = chatToResponses("m", [{
      role: "assistant",
      content: "working",
      tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"a":1}' } }],
    }]);
    assert.deepEqual(body.input[0], { role: "assistant", content: [{ type: "output_text", text: "working" }] });
    assert.deepEqual(body.input[1], {
      type: "function_call", call_id: "c1", name: "read", arguments: '{"a":1}',
    });
  });
  it("never re-emits reasoning_content as output_text", () => {
    const body = chatToResponses("m", [{
      role: "assistant", content: "answer", reasoning_content: "secret chain",
    }]);
    const texts = body.input[0].content.filter((c) => c.type === "output_text").map((c) => c.text);
    assert.deepEqual(texts, ["answer"]);
  });
  it("keeps refusal blocks and maps user messages", () => {
    const body = chatToResponses("m", [
      { role: "assistant", content: "", refusal: "no" },
      { role: "user", content: "hello" },
    ]);
    assert.deepEqual(body.input[0].content, [{ type: "refusal", refusal: "no" }]);
    assert.deepEqual(body.input[1], { role: "user", content: [{ type: "input_text", text: "hello" }] });
  });
  it("maps tools and tool_choice", () => {
    const tools = [{ function: { name: "read", description: "d", parameters: { type: "object" } } }];
    const byName = chatToResponses("m", [], tools, { function: { name: "read" } });
    assert.deepEqual(byName.tools[0].name, "read");
    assert.deepEqual(byName.tool_choice, { type: "function", name: "read" });
    const asString = chatToResponses("m", [], tools, "auto");
    assert.equal(asString.tool_choice, "auto");
    assert.equal(chatToResponses("m", []).tool_choice, undefined);
  });
});

describe("ensureAssistantReasoning", () => {
  it("does not mutate the input array", () => {
    const messages = [{ role: "assistant", content: "x" }, { role: "user", content: "y" }];
    const snapshot = JSON.stringify(messages);
    const out = ensureAssistantReasoning(messages);
    assert.equal(JSON.stringify(messages), snapshot);
    assert.notEqual(out, messages);
    assert.deepEqual(out[0], { role: "assistant", content: "x", reasoning_content: "" });
    assert.deepEqual(out[1], { role: "user", content: "y" });
  });
  it("keeps existing reasoning_content and passes non-arrays through", () => {
    const m = { role: "assistant", content: "x", reasoning_content: "r" };
    assert.deepEqual(ensureAssistantReasoning([m])[0], m);
    assert.equal(ensureAssistantReasoning(null), null);
  });
});

describe("ensureFingerprintTools", () => {
  it("adds missing decoys without duplicating existing tools", () => {
    const real = { function: { name: "read", description: "r", parameters: {} } };
    const out = ensureFingerprintTools([real]);
    assert.ok(out.includes(real));
    for (const name of FINGERPRINT_TOOLS) {
      assert.equal(out.filter((t) => toolName(t) === name).length, 1);
    }
  });
  it("drops nameless entries and handles missing input", () => {
    assert.equal(ensureFingerprintTools([{}, null]).length, FINGERPRINT_TOOLS.length);
    assert.equal(ensureFingerprintTools(undefined).length, FINGERPRINT_TOOLS.length);
  });
  it("builds decoys with the unavailable marker", () => {
    const d = decoyTool("bash");
    assert.equal(d.function.name, "bash");
    assert.match(d.function.description, /unavailable/);
  });
});

describe("responsesToOpenAI", () => {
  it("converts message, reasoning, refusal and tool calls", () => {
    const out = responsesToOpenAI({
      id: "resp_1",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hi", annotations: [{ a: 1 }] }, { type: "refusal", refusal: "no" }] },
        { type: "reasoning", summary: [{ text: "s" }], content: "c" },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
      ],
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    }, "model-x");
    assert.equal(out.id, "chatcmpl-resp_1");
    assert.equal(out.model, "model-x");
    assert.equal(out.choices[0].message.content, "hi");
    assert.equal(out.choices[0].message.refusal, "no");
    assert.equal(out.choices[0].message.reasoning_content, "sc");
    assert.deepEqual(out.choices[0].message.annotations, [{ a: 1 }]);
    assert.equal(out.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });
  it("maps incomplete reasons and defaults usage to zero", () => {
    const len = responsesToOpenAI({ output: [], status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "m");
    assert.equal(len.choices[0].finish_reason, "length");
    assert.deepEqual(len.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    assert.match(len.id, /^chatcmpl_/);
    const filt = responsesToOpenAI({ output: [], status: "incomplete", incomplete_details: { reason: "content_filter" } }, "m");
    assert.equal(filt.choices[0].finish_reason, "content_filter");
  });
});

describe("aggregateSseToCompletion", () => {
  const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\ndata: [DONE]\n";
  it("accumulates content, reasoning and split tool calls", () => {
    const raw = sse([
      { id: "chatcmpl-1", created: 7, model: "m", choices: [{ delta: { content: "he" } }] },
      { choices: [{ delta: { content: "llo", reasoning_content: "r" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_wea", arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ther", arguments: '1}' } }] }, finish_reason: "stop" }] },
    ]);
    const out = aggregateSseToCompletion(raw, "m");
    assert.equal(out.id, "chatcmpl-1");
    assert.equal(out.choices[0].message.content, "hello");
    assert.equal(out.choices[0].message.reasoning_content, "r");
    assert.equal(out.choices[0].message.tool_calls[0].function.name, "get_weather");
    assert.equal(out.choices[0].finish_reason, "tool_calls");
  });
  it("filters fingerprint tool calls and reports zero usage without upstream data", () => {
    const raw = sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "bash", arguments: "{}" } }] } }] }]);
    const out = aggregateSseToCompletion(raw, "m");
    assert.equal(out.choices[0].message.tool_calls, undefined);
    assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
  it("passes upstream usage through and skips garbage lines", () => {
    const raw = "garbage\ndata: not-json\n" + sse([{ choices: [{ delta: { content: "a" } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }]);
    const out = aggregateSseToCompletion(raw, "m");
    assert.deepEqual(out.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  });
});

describe("aggregateResponsesSseToOpenAI", () => {
  const sse = (evs) => evs.map((e) => `data: ${JSON.stringify(e)}`).join("\n");
  it("builds text, reasoning, refusal and tool calls", () => {
    const raw = sse([
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.reasoning_summary_text.delta", delta: "th" },
      { type: "response.refusal.delta", delta: "no" },
      { type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "c1", name: "read" } },
      { type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"a":1}' },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]);
    const out = aggregateResponsesSseToOpenAI(raw, "m");
    assert.equal(out.choices[0].message.content, "hi");
    assert.equal(out.choices[0].message.reasoning_content, "th");
    assert.equal(out.choices[0].message.refusal, "no");
    assert.deepEqual(out.choices[0].message.tool_calls[0].function, { name: "read", arguments: '{"a":1}' });
    assert.deepEqual(out.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
  it("maps incomplete responses and defaults usage to zero", () => {
    const raw = sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }]);
    const out = aggregateResponsesSseToOpenAI(raw, "m");
    assert.equal(out.choices[0].finish_reason, "length");
    assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe("anthropic block helpers", () => {
  it("converts base64, url and legacy image sources", () => {
    assert.deepEqual(
      anthropicImageToOpenAI({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }),
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }
    );
    assert.deepEqual(
      anthropicImageToOpenAI({ type: "image", source: { type: "url", url: "https://x/y.png" } }),
      { type: "image_url", image_url: { url: "https://x/y.png" } }
    );
    assert.deepEqual(
      anthropicImageToOpenAI({ type: "image", url: "https://x/z.png" }),
      { type: "image_url", image_url: { url: "https://x/z.png" } }
    );
    assert.equal(anthropicImageToOpenAI({ type: "image", source: {} }), null);
  });
  it("extracts document text or a placeholder", () => {
    assert.equal(anthropicDocumentText({ text: "t" }), "t");
    assert.equal(anthropicDocumentText({ source: { text: "s" } }), "s");
    const b64 = Buffer.from("hello").toString("base64");
    assert.equal(anthropicDocumentText({ source: { type: "text", media_type: "text/plain", data: b64 } }), "hello");
    assert.equal(anthropicDocumentText({ source: { type: "base64", media_type: "application/pdf", data: "AA" }, title: "doc" }), "[document: doc]");
    assert.equal(anthropicDocumentText({ source: { type: "url", url: "https://x/d.pdf" } }), "[document: https://x/d.pdf]");
    assert.equal(anthropicDocumentText({}), "");
  });
  it("renders tool results with error markers", () => {
    assert.equal(anthropicToolResultText({ content: "ok" }), "ok");
    assert.equal(
      anthropicToolResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], is_error: true }),
      "[tool_error] a\nb"
    );
    assert.equal(anthropicToolResultText({ content: null, is_error: true }), "[tool_error]");
    assert.equal(anthropicToolResultText({ content: 5 }), "5");
  });
  it("accepts only object cache_control", () => {
    assert.deepEqual(pickCacheControl({ cache_control: { type: "ephemeral" } }), { type: "ephemeral" });
    assert.equal(pickCacheControl({ cache_control: [1] }), undefined);
    assert.equal(pickCacheControl({}), undefined);
  });
});

describe("anthropicToOpenAI", () => {
  it("converts system, text, images and documents", () => {
    const out = anthropicToOpenAI({
      system: "sys",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
          { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from("doc").toString("base64") } },
        ],
      }],
    });
    assert.deepEqual(out.messages[0], { role: "system", content: "sys" });
    assert.equal(out.messages[1].role, "user");
    assert.deepEqual(out.messages[1].content[0], { type: "text", text: "look\ndoc" });
    assert.match(out.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(out.tools, undefined);
  });
  it("converts assistant tool_use and tool_result chains", () => {
    const out = anthropicToOpenAI({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "t1", name: "read", input: { p: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file!" }] },
      ],
    });
    assert.equal(out.messages[0].content, "on it");
    assert.deepEqual(out.messages[0].tool_calls, [{ id: "t1", type: "function", function: { name: "read", arguments: '{"p":1}' } }]);
    assert.deepEqual(out.messages[1], { role: "tool", tool_call_id: "t1", content: "file!" });
  });
  it("forwards cache_control on blocks, messages and tools", () => {
    const cc = { type: "ephemeral" };
    const out = anthropicToOpenAI({
      system: [{ type: "text", text: "s", cache_control: cc }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: cc }] }],
      tools: [{ name: "read", description: "", input_schema: {}, cache_control: cc }],
    });
    assert.deepEqual(out.messages[0].cache_control, cc);
    assert.deepEqual(out.messages[1].cache_control, cc);
    assert.deepEqual(out.tools[0].cache_control, cc);
  });
});

describe("openAIToAnthropic", () => {
  const base = (message, extra = {}) => ({
    id: "chatcmpl-abc", choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 6 }, ...extra,
  });
  it("normalizes response ids to msg_ prefix", () => {
    assert.equal(openAIToAnthropic(base({ content: "x" }), "m", 0).id, "msg_abc");
    assert.equal(openAIToAnthropic(base({ content: "x" }, { id: "resp_1" }), "m", 0).id, "msg_1");
    assert.equal(openAIToAnthropic(base({ content: "x" }, { id: "chatcmpl_xyz" }), "m", 0).id, "msg_xyz");
    assert.equal(openAIToAnthropic(base({ content: "x" }, { id: "msg_keep" }), "m", 0).id, "msg_keep");
    assert.equal(openAIToAnthropic(base({ content: "x" }, { id: "other" }), "m", 0).id, "msg_other");
    assert.match(openAIToAnthropic({ choices: [] }, "m", 0).id, /^msg_/);
  });
  it("returns empty content instead of fabricated empty text", () => {
    assert.deepEqual(openAIToAnthropic({ id: "chatcmpl-1", choices: [] }, "m", 0).content, []);
    assert.deepEqual(openAIToAnthropic(base({ content: null, tool_calls: [] }), "m", 0).content, []);
  });
  it("maps reasoning, refusal and tool calls", () => {
    const out = openAIToAnthropic(base({
      content: "done",
      reasoning_content: "why",
      refusal: "no",
      tool_calls: [
        { id: "c1", function: { name: "read", arguments: '{"p":1}' } },
        { id: "c2", function: { name: "bad", arguments: "not-json" } },
      ],
    }, { id: "chatcmpl-1" }), "m", 0);
    assert.deepEqual(out.content[0], { type: "thinking", thinking: "why" });
    assert.deepEqual(out.content[1], { type: "text", text: "done" });
    assert.deepEqual(out.content[2], { type: "text", text: "no" });
    assert.deepEqual(out.content[3], { type: "tool_use", id: "c1", name: "read", input: { p: 1 } });
    assert.deepEqual(out.content[4], { type: "tool_use", id: "c2", name: "bad", input: {} });
  });
  it("maps stop reasons and keeps zero token counts honest", () => {
    assert.equal(openAIToAnthropic(base({ content: "x" }, { id: "a" }), "m", 0).stop_reason, "end_turn");
    const cases = [["tool_calls", "tool_use"], ["length", "max_tokens"], ["content_filter", "refusal"]];
    for (const [fr, stop] of cases) {
      const out = openAIToAnthropic({ id: "a", choices: [{ message: { content: "x" }, finish_reason: fr }] }, "m", 0);
      assert.equal(out.stop_reason, stop);
    }
    const zero = openAIToAnthropic(
      { id: "a", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } },
      "m", 9
    );
    assert.equal(zero.usage.input_tokens, 0);
    assert.equal(zero.usage.output_tokens, 0);
  });
  it("maps stop_sequence finish reason", () => {
    const out = openAIToAnthropic({ id: "a", choices: [{ message: { content: "x" }, finish_reason: "stop_sequence" }] }, "m", 0);
    assert.equal(out.stop_reason, "stop_sequence");
  });
});

describe("isAttributionText / stripAttributionBlocks", () => {
  it("detects the Claude Code billing header", () => {
    assert.equal(isAttributionText("x-anthropic-billing-header: cc_version=2; cch=1"), true);
    assert.equal(isAttributionText("cc_version=2.1 cch=abc extra"), true);
    assert.equal(isAttributionText("You are a helpful assistant."), false);
    assert.equal(isAttributionText(""), false);
    assert.equal(isAttributionText(null), false);
  });
  it("strips only the leading attribution block", () => {
    const attr = { type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=a" };
    const real = { type: "text", text: "real instructions" };
    assert.deepEqual(stripAttributionBlocks([attr, real]), [real]);
    assert.deepEqual(stripAttributionBlocks([real, attr]), [real, attr]);
    assert.deepEqual(stripAttributionBlocks([real]), [real]);
    assert.deepEqual(stripAttributionBlocks([]), []);
  });
});

describe("validateAnthropicMessagesBody", () => {
  it("requires model, messages and max_tokens", () => {
    assert.match(validateAnthropicMessagesBody({}), /model/);
    assert.match(validateAnthropicMessagesBody({ model: "m" }), /messages/);
    assert.match(validateAnthropicMessagesBody({ model: "m", messages: [] }), /max_tokens/);
  });
  it("rejects non-integer or negative max_tokens", () => {
    assert.match(validateAnthropicMessagesBody({ model: "m", messages: [], max_tokens: -1 }), /max_tokens/);
    assert.match(validateAnthropicMessagesBody({ model: "m", messages: [], max_tokens: 1.5 }), /max_tokens/);
    assert.match(validateAnthropicMessagesBody({ model: "m", messages: [], max_tokens: "5" }), /max_tokens/);
  });
  it("accepts zero (cache pre-warm) and valid bodies", () => {
    assert.equal(validateAnthropicMessagesBody({ model: "m", messages: [], max_tokens: 0 }), null);
    assert.equal(validateAnthropicMessagesBody({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }), null);
  });
});

describe("anthropicParamsToChat effort mapping", () => {
  it("maps output_config.effort to reasoning_effort", () => {
    assert.deepEqual(
      anthropicParamsToChat({ max_tokens: 5, output_config: { effort: "high" } }),
      { max_tokens: 5, reasoning_effort: "high" }
    );
  });
  it("maps adaptive/enabled thinking to medium effort", () => {
    assert.deepEqual(
      anthropicParamsToChat({ max_tokens: 5, thinking: { type: "adaptive" } }),
      { max_tokens: 5, reasoning_effort: "medium" }
    );
    assert.deepEqual(
      anthropicParamsToChat({ max_tokens: 5, thinking: { type: "enabled", budget_tokens: 2000 } }),
      { max_tokens: 5, reasoning_effort: "medium" }
    );
  });
  it("maps disabled/between_tools thinking to none", () => {
    assert.deepEqual(
      anthropicParamsToChat({ max_tokens: 5, thinking: { type: "disabled" } }),
      { max_tokens: 5, reasoning_effort: "none" }
    );
    assert.deepEqual(
      anthropicParamsToChat({ max_tokens: 5, thinking: { type: "between_tools" } }),
      { max_tokens: 5, reasoning_effort: "none" }
    );
  });
  it("keeps explicit reasoning_effort over derived values", () => {
    assert.deepEqual(
      anthropicParamsToChat({ max_tokens: 5, reasoning_effort: "low", output_config: { effort: "high" }, thinking: { type: "adaptive" } }),
      { max_tokens: 5, reasoning_effort: "low" }
    );
  });
});

describe("anthropicToOpenAI gateway handling", () => {
  it("ignores unknown classifier fields like safeguards instead of failing", () => {
    const out = anthropicToOpenAI({
      model: "m",
      max_tokens: 64,
      safeguards: [{ type: "auto_mode_classifier", whatever: true }],
      some_future_field: { nested: [1, 2, 3] },
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.messages.length, 2);
    assert.ok(!("safeguards" in out.params), "safeguards must not leak into upstream params");
    assert.ok(!("some_future_field" in out.params));
    assert.equal(validateAnthropicMessagesBody({
      model: "m",
      max_tokens: 64,
      safeguards: [],
      messages: [{ role: "user", content: "hi" }],
    }), null);
  });
  it("round-trips tool-use ids without rewriting them", () => {
    const out = anthropicToOpenAI({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_abc123", name: "read", input: { p: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_abc123", content: "file!" }] },
      ],
    });
    assert.equal(out.messages[0].tool_calls[0].id, "toolu_abc123");
    assert.equal(out.messages[1].tool_call_id, "toolu_abc123");
    const back = openAIToAnthropic({
      id: "chatcmpl-1",
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "toolu_abc123", function: { name: "read", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, "m", 0);
    assert.equal(back.content[0].id, "toolu_abc123");
  });
  it("strips the attribution block from system arrays", () => {
    const out = anthropicToOpenAI({
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2; cch=1" },
        { type: "text", text: "sys" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(out.messages[0], { role: "system", content: "sys" });
  });
  it("drops thinking blocks instead of leaking them upstream", () => {
    const out = anthropicToOpenAI({
      messages: [{
        role: "user",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "redacted_thinking", data: "enc" },
          { type: "text", text: "hi" },
        ],
      }],
    });
    assert.equal(out.messages[0].content, "hi");
  });
  it("renders server_tool_use as text context", () => {
    const out = anthropicToOpenAI({
      messages: [{
        role: "user",
        content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { q: "x" } }],
      }],
    });
    assert.match(out.messages[0].content, /server_tool_use: web_search/);
  });
});

describe("createAnthropicBlockTracker", () => {
  // Claude Code aborts the stream as malformed when an event references a
  // block whose content_block_start never arrived, or duplicates stops.
  function validateSequence(events) {
    const started = new Set();
    const stopped = new Set();
    for (const [event, data] of events) {
      if (event === "content_block_start") {
        assert.ok(!started.has(data.index), `duplicate start for index ${data.index}`);
        started.add(data.index);
      } else if (event === "content_block_delta") {
        assert.ok(started.has(data.index), `delta for never-started block ${data.index}`);
        assert.ok(!stopped.has(data.index), `delta for stopped block ${data.index}`);
      } else if (event === "content_block_stop") {
        assert.ok(started.has(data.index), `stop for never-started block ${data.index}`);
        assert.ok(!stopped.has(data.index), `duplicate stop for index ${data.index}`);
        stopped.add(data.index);
      }
    }
    return { started, stopped };
  }

  function collect(fn) {
    const events = [];
    const blocks = createAnthropicBlockTracker((event, data) => events.push([event, data]));
    fn(blocks);
    return events;
  }

  it("assigns sequential indices and stops each block exactly once", () => {
    const events = collect((blocks) => {
      const text = blocks.start("text", { type: "text", text: "" });
      assert.equal(text, 0);
      const tool = blocks.start("tool:0", { type: "tool_use", id: "t1", name: "read" });
      assert.equal(tool, 1);
      blocks.stopAll();
      blocks.stopAll();
    });
    const { started, stopped } = validateSequence(events);
    assert.deepEqual([...started].sort(), [0, 1]);
    assert.deepEqual([...stopped].sort(), [0, 1]);
  });

  it("is idempotent per key and ignores stops for unknown blocks", () => {
    const events = collect((blocks) => {
      assert.equal(blocks.start("text", { type: "text", text: "" }), 0);
      assert.equal(blocks.start("text", { type: "text", text: "" }), 0);
      blocks.stopKey("missing");
      blocks.stopIndex(99);
      assert.equal(blocks.has("text"), true);
      assert.equal(blocks.has("missing"), false);
      assert.equal(blocks.isOpen("text"), true);
      blocks.stopKey("text");
      assert.equal(blocks.isOpen("text"), false);
      assert.equal(blocks.startedCount(), 1);
    });
    validateSequence(events);
    assert.equal(events.filter(([e]) => e === "content_block_start").length, 1);
    assert.equal(events.filter(([e]) => e === "content_block_stop").length, 1);
  });

  it("keeps a think-text-tool flow gapless (the malformed-stream regression)", () => {
    const events = collect((blocks) => {
      blocks.start("think", { type: "thinking", thinking: "" });
      blocks.stopKey("think");
      const text = blocks.start("text", { type: "text", text: "" });
      assert.equal(text, 1);
      const tool = blocks.start("tool:0", { type: "tool_use", id: "t1", name: "read" });
      assert.equal(tool, 2);
      blocks.stopAll();
    });
    const { started, stopped } = validateSequence(events);
    assert.deepEqual([...started].sort(), [0, 1, 2]);
    assert.deepEqual([...stopped].sort(), [0, 1, 2]);
  });

  it("keeps text-tool-text flows valid without early stops", () => {
    const events = collect((blocks) => {
      const text = blocks.start("text", { type: "text", text: "" });
      blocks.start("tool:0", { type: "tool_use", id: "t1", name: "read" });
      assert.equal(blocks.keyIndex("text"), text);
      blocks.stopAll();
    });
    validateSequence(events);
  });
});
