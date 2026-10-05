import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CANCELLED_TOOL_NOTICE,
  closeOrphanToolCalls,
  mergeConsecutiveUserMessages,
  repairChatMessages,
  closeOrphanFunctionCalls,
  mergeConsecutiveUserInputs,
  repairResponsesInput,
} from "../lib/repair.mjs";

import { anthropicToOpenAI } from "../lib/convert.mjs";

const answeredHistory = () => ([
  { role: "user", content: "run it" },
  { role: "assistant", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "ok" },
  { role: "user", content: "thanks" },
]);

describe("Repair: orphan tool calls (chat shape)", () => {
  it("returns the input untouched when every call is answered", () => {
    const msgs = answeredHistory();
    assert.equal(closeOrphanToolCalls(msgs), msgs);
  });

  it("appends a cancellation stub for a trailing orphan call", () => {
    const msgs = [
      { role: "user", content: "run it" },
      { role: "assistant", tool_calls: [{ id: "c9", function: { name: "bash", arguments: "{}" } }] },
    ];
    const fixed = closeOrphanToolCalls(msgs);
    assert.equal(fixed.length, 3);
    assert.deepEqual(fixed[2], { role: "tool", tool_call_id: "c9", content: CANCELLED_TOOL_NOTICE });
    assert.ok(CANCELLED_TOOL_NOTICE.length > 0);
  });

  it("inserts the stub right after the issuing message, in call order", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [
        { id: "c1", function: { name: "bash", arguments: "{}" } },
        { id: "c2", function: { name: "read", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "user", content: "interrupted, new task" },
    ];
    const fixed = closeOrphanToolCalls(msgs);
    assert.equal(fixed.length, 5);
    assert.equal(fixed[2].role, "tool");
    assert.equal(fixed[2].tool_call_id, "c2");
    assert.equal(fixed[2].content, CANCELLED_TOOL_NOTICE);
    assert.equal(fixed[4].content, "interrupted, new task");
  });

  it("ignores calls and results without ids", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ function: { name: "bash" } }] },
      { role: "tool", content: "orphan text" },
    ];
    assert.equal(closeOrphanToolCalls(msgs), msgs);
  });

  it("handles negatives without throwing", () => {
    for (const bad of [null, undefined, "x", {}, []]) {
      assert.deepEqual(closeOrphanToolCalls(bad), bad);
    }
  });
});

describe("Repair: consecutive user messages (chat shape)", () => {
  it("folds adjacent string user messages with a blank line", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third" },
    ];
    const fixed = mergeConsecutiveUserMessages(msgs);
    assert.equal(fixed.length, 3);
    assert.equal(fixed[0].content, "first\n\nsecond");
    assert.equal(fixed[1].content, "ok");
  });

  it("leaves separated users and array content untouched", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: [{ type: "text", text: "c" }] },
      { role: "user", content: "d" },
    ];
    assert.equal(mergeConsecutiveUserMessages(msgs), msgs);
  });

  it("handles negatives without throwing", () => {
    for (const bad of [null, undefined, 42, []]) {
      assert.deepEqual(mergeConsecutiveUserMessages(bad), bad);
    }
  });
});

describe("Repair: Responses input shape", () => {
  it("closes orphan function_call items in place", () => {
    const items = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "fc1", name: "bash", arguments: "{}" },
    ];
    const fixed = closeOrphanFunctionCalls(items);
    assert.equal(fixed.length, 3);
    assert.deepEqual(fixed[2], { type: "function_call_output", call_id: "fc1", output: CANCELLED_TOOL_NOTICE });
  });

  it("keeps answered calls and merges adjacent plain user items", () => {
    const items = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { type: "function_call", call_id: "fc1", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "fc1", output: "ok" },
    ];
    const fixed = repairResponsesInput(items);
    assert.equal(fixed.length, 3);
    assert.equal(fixed[0].content, "a\n\nb");
  });

  it("passes string input through untouched", () => {
    assert.equal(repairResponsesInput("hello"), "hello");
    assert.equal(repairResponsesInput(null), null);
  });
});

describe("Repair: end-to-end interrupted Anthropic transcript", () => {
  it("every converted tool_call gets a tool result after repair", () => {
    const body = {
      model: "muse-spark",
      max_tokens: 64,
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
            { type: "tool_use", id: "tu_2", name: "read", input: { path: "a" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
        { role: "user", content: "[Request interrupted by user for tool use]" },
        { role: "user", content: "stop, new task" },
      ],
    };
    const { messages } = anthropicToOpenAI(body);
    const fixed = repairChatMessages(messages);
    const calls = new Set();
    const results = new Set();
    for (const m of fixed) {
      if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) calls.add(tc.id);
      if (m.role === "tool") results.add(m.tool_call_id);
    }
    assert.ok(calls.has("tu_2"));
    for (const id of calls) assert.ok(results.has(id), `missing result for ${id}`);
    const stub = fixed.find((m) => m.role === "tool" && m.tool_call_id === "tu_2");
    assert.equal(stub.content, CANCELLED_TOOL_NOTICE);
    const userMsgs = fixed.filter((m) => m.role === "user");
    assert.ok(userMsgs.length < 3);
  });
});
