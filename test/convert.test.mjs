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
});
