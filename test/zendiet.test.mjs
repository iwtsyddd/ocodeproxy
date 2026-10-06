import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isAlreadyCompacted,
  isTier0Block,
  findLastUserIndex,
  getActiveTurnRange,
  validateToolPairing,
} from "../lib/zendiet/safety.mjs";

import {
  countCharsTokens,
  estimateRequestTokens,
  calculateContextPressure,
  hasCacheDirectives,
  assessCacheRisk,
} from "../lib/zendiet/analyzer.mjs";

import {
  detectClient,
  optimizeContext,
  HUGE_TOOL_CHARS,
  PER_OUTPUT_TRIGGER_CHARS,
} from "../lib/zendiet.mjs";

import {
  sha256,
  formatDuplicateNotice,
  normalizeForHash,
  deduplicateToolResults,
} from "../lib/zendiet/dedup.mjs";

import {
  isFailureOutput,
  classifyToolOutput,
} from "../lib/zendiet/classifier.mjs";

import {
  stripAnsi,
  stripTerminalNoise,
  collapseRepeatedLines,
  reduceDiffOutput,
  reduceTestOutput,
  reduceFileReadOutput,
  reduceShellOutput,
  reduceToolOutput,
  hardCapText,
  DEFAULT_FAILURE_MAX_CHARS,
  DEFAULT_DIFF_MAX_CHARS,
} from "../lib/zendiet/reducers.mjs";

describe("ZenDiet Safety & Tier 0 Invariants", () => {
  it("detects existing client-side compaction markers", () => {
    assert.equal(isAlreadyCompacted("[Old tool result content cleared]"), true);
    assert.equal(isAlreadyCompacted("Error: command failed\n[Output truncated: 500 lines omitted]"), true);
    assert.equal(isAlreadyCompacted("[... ZenDiet: trimmed 4500 chars ...]"), true);
    assert.equal(isAlreadyCompacted("Normal output from ls -la"), false);
    assert.equal(isAlreadyCompacted(null), false);
    assert.equal(isAlreadyCompacted(""), false);
  });

  it("identifies Tier 0 blocks as immutable", () => {
    assert.equal(isTier0Block({ type: "thinking", thinking: "internal" }), true);
    assert.equal(isTier0Block({ type: "redacted_thinking", data: "..." }), true);
    assert.equal(isTier0Block({ type: "text", signature: "sig_abc123" }), true);
    assert.equal(isTier0Block({ type: "text", text: "hello" }), false);
    assert.equal(isTier0Block({ type: "tool_result", content: "data" }), false);
    assert.equal(isTier0Block(null), false);
  });

  it("calculates active turn range and protects latest user interaction", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "calling tool" },
      { role: "tool", content: "tool output" },
    ];
    assert.equal(findLastUserIndex(messages), 2);
    const range = getActiveTurnRange(messages);
    assert.equal(range.startIndex, 2);
    assert.equal(range.count, 3);

    // Empty or no user fallback
    assert.deepEqual(getActiveTurnRange([]), { startIndex: -1, count: 0 });
    assert.deepEqual(getActiveTurnRange([{ role: "assistant", content: "hi" }]), { startIndex: 0, count: 1 });
  });

  it("validates tool pairing across OpenAI and Anthropic formats", () => {
    const openaiMsgs = [
      { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "bash" } }] },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ];
    const pairing1 = validateToolPairing(openaiMsgs);
    assert.equal(pairing1.valid, true);
    assert.equal(pairing1.totalCalls, 1);
    assert.equal(pairing1.totalResults, 1);

    const anthropicMsgs = [
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "data" }] },
    ];
    const pairing2 = validateToolPairing(anthropicMsgs);
    assert.equal(pairing2.valid, true);
    assert.equal(pairing2.totalCalls, 1);
    assert.equal(pairing2.totalResults, 1);
  });
});

describe("ZenDiet Token Analyzer & Context Pressure", () => {
  it("counts characters to tokens using 4 chars/token heuristic", () => {
    assert.equal(countCharsTokens(""), 0);
    assert.equal(countCharsTokens(null), 0);
    assert.equal(countCharsTokens("abcd"), 1);
    assert.equal(countCharsTokens("abcdefgh"), 2);
    assert.equal(countCharsTokens("a".repeat(100)), 25);
  });

  it("breaks down tokens across system, messages, tools, toolResults and reasoning", () => {
    const body = {
      system: "You are a helpful assistant.", // 28 chars -> 7 tok
      tools: [{ name: "bash", description: "run" }],
      messages: [
        { role: "user", content: "hello world" }, // 11 chars -> 3 tok + 4 overhead
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think about this" }, // 23 chars -> 6 tok
            { type: "text", text: "got it" }, // 6 chars -> 2 tok
          ],
        },
        { role: "tool", content: "huge tool result data" }, // 21 chars -> 6 tok + 4 overhead
      ],
    };
    const est = estimateRequestTokens(body);
    assert.equal(est.system, 7);
    assert.equal(est.reasoning, 6);
    assert.ok(est.toolResults >= 6);
    assert.ok(est.tools > 0);
    assert.ok(est.total > 0);
  });

  it("evaluates context pressure across low, moderate, high, and critical levels", () => {
    const win = 100_000;
    const reserve = 10_000;
    // usable = 90,000

    const low = calculateContextPressure(20_000, win, { reserveTokens: reserve });
    assert.equal(low.level, "low");
    assert.equal(low.action, "noop");
    assert.ok(low.ratio < 0.55);

    const moderate = calculateContextPressure(55_000, win, { reserveTokens: reserve });
    assert.equal(moderate.level, "moderate");
    assert.equal(moderate.action, "light");

    const high = calculateContextPressure(70_000, win, { reserveTokens: reserve });
    assert.equal(high.level, "high");
    assert.equal(high.action, "balanced");

    const critical = calculateContextPressure(85_000, win, { reserveTokens: reserve });
    assert.equal(critical.level, "critical");
    assert.equal(critical.action, "emergency");
  });

  it("evaluates cache directives and cache risk thresholds", () => {
    const noCacheBody = { messages: [{ role: "user", content: "hi" }] };
    assert.equal(hasCacheDirectives(noCacheBody), false);
    const noRisk = assessCacheRisk(noCacheBody, 1000, 50_000);
    assert.equal(noRisk.hasCache, false);
    assert.equal(noRisk.allowOptimization, true);

    const cacheBody = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
      ],
    };
    assert.equal(hasCacheDirectives(cacheBody), true);

    // Minor savings (<3000 tok and <5%) -> high risk to break cache
    const highRisk = assessCacheRisk(cacheBody, 500, 50_000);
    assert.equal(highRisk.hasCache, true);
    assert.equal(highRisk.risk, "high");
    assert.equal(highRisk.allowOptimization, false);

    // Significant savings (>=3000 tok) -> acceptable risk
    const okRisk = assessCacheRisk(cacheBody, 15_000, 50_000);
    assert.equal(okRisk.hasCache, true);
    assert.equal(okRisk.risk, "acceptable");
    assert.equal(okRisk.allowOptimization, true);
  });
});

describe("ZenDiet Coordinator & Client Detection", () => {
  it("detects agent clients from user-agent and payload headers", () => {
    assert.equal(detectClient({ "user-agent": "claude-code/0.2.29" }), "claude-code");
    assert.equal(detectClient({ "User-Agent": "opencode/1.2.3" }), "opencode");
    assert.equal(detectClient({ "x-opencode-client": "cli" }), "opencode");
    assert.equal(detectClient({ "user-agent": "Cursor/0.45.0" }), "cursor");
    assert.equal(detectClient({ "user-agent": "aider/0.70.0" }), "aider");
    assert.equal(detectClient({}, { system: "x-anthropic-billing-header: cc_version=1" }), "claude-code");
    assert.equal(detectClient({ "user-agent": "curl/7.88.1" }), "generic");
  });

  it("handles mode: off with immediate noop", () => {
    const req = { messages: [{ role: "user", content: "hello" }] };
    const res = optimizeContext(req, { mode: "off" });
    assert.equal(res.changed, false);
    assert.deepEqual(res.request, req);
    assert.ok(res.decisions.includes("mode: off -> noop"));
  });

  it("preserves full fidelity when context pressure is low", () => {
    const req = {
      messages: [
        { role: "user", content: "What is the capital of France?" },
      ],
    };
    const res = optimizeContext(req, { mode: "balanced", contextWindow: 200_000 });
    assert.equal(res.changed, false);
    assert.equal(res.stats.savedTokens, 0);
    assert.equal(res.stats.pressureLevel, "low");
    assert.ok(res.decisions.some((d) => d.includes("low pressure -> noop")));
  });

  it("collapses duplicate tool outputs when context pressure is moderate/high", () => {
    const repeatedOutput = "const x = 1;\n".repeat(120); // 1560 chars (~390 tokens * 2)
    const req = {
      messages: [
        { role: "user", content: "read file twice" },
        { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "read" } }] },
        { role: "tool", tool_call_id: "call_1", content: repeatedOutput },
        { role: "assistant", tool_calls: [{ id: "call_2", function: { name: "read" } }] },
        { role: "tool", tool_call_id: "call_2", content: repeatedOutput },
        { role: "user", content: "what is x?" },
      ],
    };
    // Force higher pressure by setting smaller context window
    const res = optimizeContext(req, { mode: "balanced", contextWindow: 1000 });
    assert.equal(res.changed, true);
    assert.ok(res.stats.savedTokens > 0);
    assert.ok(res.decisions.some((d) => d.includes("dedup: collapsed 1 duplicate")));

    // First tool result is preserved (or previewed)
    assert.ok(res.request.messages[2].content.includes("const x = 1;\n"));
    // Second tool result is collapsed
    assert.match(res.request.messages[4].content, /\[ZenDiet: duplicate of tool result #call_1/);
  });
});

describe("ZenDiet Tool Result Deduplication", () => {
  it("computes accurate sha256 hex hashes", () => {
    const hash = sha256("hello world");
    assert.equal(hash.length, 64);
    assert.equal(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("formats duplicate notice with reference, hash and length", () => {
    const notice = formatDuplicateNotice("call_42", "b94d27b9934d", 1500);
    assert.equal(notice, "[ZenDiet: duplicate of tool result #call_42 (sha256: b94d27b9934d, 1500 chars)]");
  });

  it("leaves single or distinct tool outputs untouched", () => {
    const msgs = [
      { role: "tool", tool_call_id: "call_1", content: "first long output ".repeat(15) },
      { role: "tool", tool_call_id: "call_2", content: "different long output ".repeat(15) },
    ];
    const res = deduplicateToolResults(msgs, { protectActiveTurn: false });
    assert.equal(res.changed, false);
    assert.equal(res.duplicatesCount, 0);
    assert.equal(res.savedChars, 0);
  });

  it("does not deduplicate short outputs below threshold", () => {
    const shortText = "ok";
    const msgs = [
      { role: "tool", tool_call_id: "call_1", content: shortText },
      { role: "tool", tool_call_id: "call_2", content: shortText },
    ];
    const res = deduplicateToolResults(msgs, { minChars: 100, protectActiveTurn: false });
    assert.equal(res.changed, false);
  });

  it("protects active turn tool results from deduplication", () => {
    const repeated = "repeat content ".repeat(20);
    const msgs = [
      { role: "tool", tool_call_id: "call_1", content: repeated },
      { role: "user", content: "next prompt" }, // active turn starts here
      { role: "tool", tool_call_id: "call_2", content: repeated },
    ];
    const res = deduplicateToolResults(msgs, { activeStartIndex: 1, protectActiveTurn: true });
    assert.equal(res.changed, false);
    assert.equal(res.duplicatesCount, 0);
  });

  it("deduplicates Anthropic tool_result blocks in content array", () => {
    const repeated = "anthropic test output ".repeat(20);
    const msgs = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: repeated }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_2", content: repeated }],
      },
    ];
    const res = deduplicateToolResults(msgs, { protectActiveTurn: false });
    assert.equal(res.changed, true);
    assert.equal(res.duplicatesCount, 1);
    assert.match(res.messages[1].content[0].content, /\[ZenDiet: duplicate of tool result #tu_1/);
  });
});

describe("ZenDiet Tool Output Classifier", () => {
  it("detects errors and failure patterns", () => {
    assert.equal(isFailureOutput("Command exited with code 1"), true);
    assert.equal(isFailureOutput("TypeError: Cannot read properties of undefined"), true);
    assert.equal(isFailureOutput("AssertionError [ERR_ASSERTION]: expected true"), true);
    assert.equal(isFailureOutput("fatal: not a git repository"), true);
    assert.equal(isFailureOutput("Compiled successfully in 420ms"), false);
    assert.equal(isFailureOutput(null), false);
    assert.equal(isFailureOutput(""), false);
  });

  it("classifies tool outputs into semantic types", () => {
    assert.equal(classifyToolOutput("git_diff", "diff --git a/file b/file"), "git-diff");
    assert.equal(classifyToolOutput("run_command", "@@ -1,5 +1,5 @@"), "git-diff");
    assert.equal(classifyToolOutput("test", "✓ 14 suites passed"), "test");
    assert.equal(classifyToolOutput("run_tests", "output"), "test");
    assert.equal(classifyToolOutput("grep_search", "src/index.js:10: hello"), "search");
    assert.equal(classifyToolOutput("cat", "function foo() {}"), "file-read");
    assert.equal(classifyToolOutput("bash", "echo hello"), "shell");
    assert.equal(classifyToolOutput("custom_tool", "random string"), "generic");
  });
});

describe("ZenDiet Tool Reducers & Noise Stripping", () => {
  it("strips ANSI escape sequences", () => {
    const colored = "\x1B[31mError:\x1B[0m something went wrong";
    assert.equal(stripAnsi(colored), "Error: something went wrong");
  });

  it("strips terminal progress spam and carriage return overwrites", () => {
    const raw = "Downloading... 10%\rDownloading... 50%\rDownloading... 100%\n[===>    ] 45%\nDone!";
    const cleaned = stripTerminalNoise(raw);
    assert.match(cleaned, /Done!/);
    assert.ok(!cleaned.includes("45%"));
  });

  it("preserves hunk headers and changed lines in git diff", () => {
    const diff = [
      "diff --git a/foo.js b/foo.js",
      "@@ -10,10 +10,12 @@",
      " context 1",
      " context 2",
      " context 3",
      " context 4",
      "-old line",
      "+new line",
      " context 5",
      " context 6",
    ].join("\n");
    const reduced = reduceDiffOutput(diff, { maxChars: 50 });
    assert.ok(reduced.includes("@@ -10,10 +10,12 @@"));
    assert.ok(reduced.includes("-old line"));
    assert.ok(reduced.includes("+new line"));
    assert.ok(reduced.includes("[... unchanged context ...]"));
  });

  it("preserves test failures and stack traces", () => {
    const failureOutput = [
      "▶ test suite",
      "  ✔ passing test 1 (1ms)",
      "  ✖ failing test 2 (2ms)",
      "  AssertionError: expected 1 to equal 2",
      "      at TestContext.<anonymous> (file:///test/foo.js:10:5)",
      "      at runTest (file:///test/runner.js:20:10)",
      "ℹ tests 2",
      "ℹ suites 1",
      "ℹ pass 1",
      "ℹ fail 1",
    ].join("\n");
    const reduced = reduceTestOutput(failureOutput, { maxChars: 50 });
    assert.ok(reduced.includes("[ZenDiet: test failures preserved]"));
    assert.ok(reduced.includes("AssertionError"));
    assert.ok(reduced.includes("at TestContext"));
    assert.ok(reduced.includes("fail 1"));
  });

  it("reduces passing test suite to summary", () => {
    const passOutput = `${Array.from({ length: 50 }, (_, i) => `✔ passing test ${i + 1} (1ms)`).join("\n")}\nℹ tests 50\nℹ pass 50\nℹ fail 0\n`;
    const reduced = reduceTestOutput(passOutput, { maxChars: 100 });
    assert.ok(reduced.includes("[ZenDiet: test suite passed]"));
    assert.ok(reduced.includes("pass 50"));
  });

  it("collapses byte-identical passing spam via noise stripping", () => {
    const passOutput = "✔ passing test (1ms)\n".repeat(50) + "ℹ tests 50\nℹ pass 50\nℹ fail 0\n";
    const reduced = reduceTestOutput(passOutput, { maxChars: 100 });
    assert.ok(reduced.length < passOutput.length);
    assert.ok(reduced.includes("pass 50"));
  });

  it("reduces long file reads into snapshots with head, tail, and omit notice", () => {
    const fileContent = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const reduced = reduceFileReadOutput(fileContent, { maxChars: 100 });
    assert.ok(reduced.includes("line 1"));
    assert.ok(reduced.includes("line 60"));
    assert.match(reduced, /\[\.\.\. ZenDiet: \d+ lines omitted; can be reread via tool \.\.\.\]/);
  });

  it("reduces older tool output in optimizeContext under high pressure", () => {
    const longFile = "line content\n".repeat(260); // 3380 chars (~845 tokens, > 0.70 pressure)
    const req = {
      messages: [
        { role: "user", content: "inspect file" },
        { role: "assistant", tool_calls: [{ id: "call_read", function: { name: "cat" } }] },
        { role: "tool", tool_call_id: "call_read", content: longFile },
        { role: "user", content: "now summarize" },
      ],
    };
    const res = optimizeContext(req, { mode: "balanced", contextWindow: 800 });
    assert.equal(res.changed, true);
    assert.ok(res.stats.savedTokens > 0);
    assert.ok(res.decisions.some((d) => d.includes("reduction: optimized 1 older tool results")));
  });

  it("optimizes older tool results in multi-step agent session while protecting active tail cycle", () => {
    const oldRead = Array.from({ length: 200 }, (_, i) => `line ${i + 1} with long realistic source code content`).join("\n");
    const activeTest = "FAIL: test failed at line 10\nAssertionError";
    const req = {
      messages: [
        { role: "user", content: "Fix the bug" },
        { role: "assistant", tool_calls: [{ id: "call_read_old", function: { name: "view_file" } }] },
        { role: "tool", tool_call_id: "call_read_old", content: oldRead },
        { role: "assistant", tool_calls: [{ id: "call_run_test", function: { name: "run_tests" } }] },
        { role: "tool", tool_call_id: "call_run_test", content: activeTest },
      ],
    };
    // Balanced mode with > 2000 tokens should optimize oldRead but preserve activeTest
    const res = optimizeContext(req, { mode: "balanced", contextWindow: 128_000 });
    assert.equal(res.changed, true);
    // Old file read was reduced
    const optimizedOldRead = res.request.messages[2].content;
    assert.match(optimizedOldRead, /\[\.\.\. ZenDiet: \d+ lines omitted/);
    // Active test result was protected and preserved in full
    const optimizedActive = res.request.messages[4].content;
    assert.equal(optimizedActive, activeTest);
  });

  it("supports Anthropic format messages with array content in tool_result blocks", () => {
    const longOutput = "verbose logs \x1B[32mgreen\x1B[0m\n".repeat(100);
    const req = {
      messages: [
        { role: "user", content: "test anthropic" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_bash", name: "bash", input: { command: "test" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_bash", content: [{ type: "text", text: longOutput }] }],
        },
        { role: "assistant", content: [{ type: "text", text: "now next step" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_active", name: "view_file", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_active", content: "active file" }],
        },
      ],
    };
    const res = optimizeContext(req, { mode: "balanced", contextWindow: 128_000 });
    assert.equal(res.changed, true);
    // Prior tool result array was reduced and noise stripped
    const priorResult = res.request.messages[2].content[0];
    assert.equal(priorResult.type, "tool_result");
    assert.ok(Array.isArray(priorResult.content));
    assert.ok(!priorResult.content[0].text.includes("\x1B[32m"));
  });
});

describe("ZenDiet Active Turn Narrowing", () => {
  it("locks only the last tool cycle instead of everything since last user", () => {
    const messages = [
      { role: "user", content: "fix" },
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "read" } }] },
      { role: "tool", tool_call_id: "c1", content: "output" },
    ];
    const range = getActiveTurnRange(messages);
    assert.equal(range.startIndex, 1);
    assert.equal(range.count, 2);
  });

  it("still locks from last user when no tool calls follow it", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "tool", content: "e" },
    ];
    const range = getActiveTurnRange(messages);
    assert.equal(range.startIndex, 2);
  });

  it("locks only the trailing user message when it is last", () => {
    const range = getActiveTurnRange([
      { role: "user", content: "a" },
      { role: "tool", tool_call_id: "c1", content: "old" },
      { role: "user", content: "next" },
    ]);
    assert.equal(range.startIndex, 2);
    assert.equal(range.count, 1);
  });
});

describe("ZenDiet Huge-Output Emergency", () => {
  it("reduces a single huge active tool result in every mode including safe", () => {
    const huge = Array.from({ length: 300 }, (_, i) => `line ${i + 1} const x = ${i} padding1234567890`).join("\n");
    assert.ok(huge.length > HUGE_TOOL_CHARS);
    for (const mode of ["safe", "balanced", "aggressive"]) {
      const req = {
        messages: [
          { role: "user", content: "read it" },
          { role: "assistant", tool_calls: [{ id: "c1", function: { name: "read" } }] },
          { role: "tool", tool_call_id: "c1", content: huge },
        ],
      };
      const res = optimizeContext(req, { mode, contextWindow: 128_000 });
      assert.equal(res.changed, true, `${mode} should emergency-reduce huge active output`);
      assert.ok(res.decisions.some((d) => d.includes("emergency: reduced")), `${mode} decision`);
      assert.ok(res.request.messages[2].content.length < huge.length);
    }
  });

  it("preserves failure markers when a huge shell output fails", () => {
    const hugeFailure = `${"ok line\n".repeat(300)}TypeError: Cannot read properties of undefined\n${"x".repeat(9000)}`;
    const req = {
      messages: [
        { role: "user", content: "run" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "bash" } }] },
        { role: "tool", tool_call_id: "c1", content: hugeFailure },
        { role: "user", content: "fix it" },
      ],
    };
    const res = optimizeContext(req, { mode: "balanced", contextWindow: 128_000 });
    const out = res.request.messages[2].content;
    assert.ok(out.includes("TypeError"));
  });

  it("skips already-compacted huge outputs", () => {
    const compacted = `[Old tool result content cleared]\n${"x".repeat(HUGE_TOOL_CHARS + 100)}`;
    const req = {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "read" } }] },
        { role: "tool", tool_call_id: "c1", content: compacted },
        { role: "user", content: "b" },
      ],
    };
    const res = optimizeContext(req, { mode: "aggressive", contextWindow: 800 });
    assert.equal(res.request.messages[2].content, compacted);
  });
});

describe("ZenDiet Per-Output Trigger", () => {
  it("balanced engages on a medium single output even when total is small", () => {
    assert.ok(PER_OUTPUT_TRIGGER_CHARS < 4000);
    const medium = Array.from({ length: 80 }, (_, i) => `line ${i + 1} const y = ${i} padding1234567890`).join("\n");
    assert.ok(medium.length > PER_OUTPUT_TRIGGER_CHARS);
    const req = {
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "cat" } }] },
        { role: "tool", tool_call_id: "c1", content: medium },
        { role: "user", content: "summarize" },
      ],
    };
    const balanced = optimizeContext(JSON.parse(JSON.stringify(req)), { mode: "balanced", contextWindow: 128_000 });
    assert.equal(balanced.changed, true);
  });

  it("safe still ignores medium outputs below the huge threshold", () => {
    const medium = Array.from({ length: 80 }, (_, i) => `line ${i + 1} const y = ${i} padding1234567890`).join("\n");
    assert.ok(medium.length < HUGE_TOOL_CHARS);
    const req = {
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "cat" } }] },
        { role: "tool", tool_call_id: "c1", content: medium },
        { role: "user", content: "summarize" },
      ],
    };
    const res = optimizeContext(req, { mode: "safe", contextWindow: 128_000 });
    assert.equal(res.changed, false);
  });
});

describe("ZenDiet Normalized Dedup & Shapes", () => {
  it("treats outputs differing only in ANSI codes as duplicates", () => {
    assert.equal(normalizeForHash("\x1B[31mhello\x1B[0m  "), normalizeForHash("hello"));
    const a = `\x1B[32m${"same content line\n".repeat(20)}\x1B[0m`;
    const b = `same content line\n`.repeat(20);
    const msgs = [
      { role: "tool", tool_call_id: "c1", content: a },
      { role: "tool", tool_call_id: "c2", content: b },
      { role: "user", content: "done" },
    ];
    const res = deduplicateToolResults(msgs, { activeStartIndex: 2, protectActiveTurn: true });
    assert.equal(res.changed, true);
    assert.equal(res.duplicatesCount, 1);
  });

  it("keeps Anthropic array shape when collapsing duplicates", () => {
    const repeated = "anthropic dup output ".repeat(20);
    const msgs = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: repeated }] }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: repeated }] }] },
      { role: "user", content: "tail" },
    ];
    const res = deduplicateToolResults(msgs, { activeStartIndex: 2, protectActiveTurn: true });
    assert.equal(res.changed, true);
    const second = res.messages[1].content[0];
    assert.ok(Array.isArray(second.content));
    assert.match(second.content[0].text, /\[ZenDiet: duplicate of tool result #t1/);
  });

  it("does not dedup genuinely different outputs", () => {
    const msgs = [
      { role: "tool", tool_call_id: "c1", content: `alpha ${"x".repeat(200)}` },
      { role: "tool", tool_call_id: "c2", content: `beta ${"y".repeat(200)}` },
    ];
    const res = deduplicateToolResults(msgs, { protectActiveTurn: false });
    assert.equal(res.changed, false);
  });
});

describe("ZenDiet Repetition Collapse & Blob Fallback", () => {
  it("collapses long runs of identical lines in noise stripping", () => {
    const spam = `${"identical log line\n".repeat(15)}final line`;
    const cleaned = stripTerminalNoise(spam);
    assert.match(cleaned, /repeated 14 identical lines/);
    assert.ok(cleaned.includes("final line"));
  });

  it("leaves short runs and blank runs untouched", () => {
    const short = `${"same\n".repeat(5)}end`;
    assert.equal(collapseRepeatedLines(short.split("\n")).length, 6);
    const blanks = Array(15).fill("").join("\n");
    assert.ok(!stripTerminalNoise(`${blanks}x`).includes("repeated"));
  });

  it("reduces single-line huge blobs by chars instead of passing through", () => {
    const blob = "z".repeat(10000);
    const reduced = reduceToolOutput(blob, "generic");
    assert.ok(reduced.length < blob.length);
    assert.match(reduced, /chars omitted/);
  });

  it("reduces few-line huge file reads instead of passing through", () => {
    const blob = `${"a".repeat(5000)}\n${"b".repeat(5000)}`;
    const reduced = reduceFileReadOutput(blob, { maxChars: 100 });
    assert.ok(reduced.length < blob.length);
  });
});

describe("ZenDiet Failure Hard-Cap & Output Bounding", () => {
  it("hardCapText handles negatives safely", () => {
    assert.equal(hardCapText(null), null);
    assert.equal(hardCapText(undefined), undefined);
    assert.equal(hardCapText(""), "");
    assert.equal(hardCapText(123), 123);
  });

  it("hardCapText leaves text under limit untouched", () => {
    const text = "short trace under limit\nError: something broke";
    assert.equal(hardCapText(text, 1000), text);
  });

  it("hardCapText enforces exact upper bound and head-tail split on large text", () => {
    const large = Array.from({ length: 400 }, (_, i) => `line ${i}: some payload content`).join("\n");
    const capped = hardCapText(large, 5000);
    assert.ok(capped.length <= 5000);
    assert.ok(capped.length > 2000);
    assert.match(capped, /\[\.\.\. ZenDiet: \d+ chars omitted/);
    assert.ok(capped.startsWith("line 0:"));
    assert.ok(capped.includes("line 399:"));
  });

  it("hardCapText preserves failure marker when present in head or tail", () => {
    const headError = `Error: startup configuration missing\n${"x".repeat(15000)}`;
    const cappedHead = hardCapText(headError, 6000);
    assert.ok(cappedHead.length <= 6000);
    assert.ok(cappedHead.includes("Error: startup configuration missing"));

    const tailError = `${"y".repeat(15000)}\nFATAL: server crashed at port 8080`;
    const cappedTail = hardCapText(tailError, 6000);
    assert.ok(cappedTail.length <= 6000);
    assert.ok(cappedTail.includes("FATAL: server crashed at port 8080"));
  });

  it("hardCapText preserves failure marker buried deep in the middle of massive trace", () => {
    const hugePrefix = Array.from({ length: 1500 }, (_, i) => `startup step ${i} completed ok`).join("\n");
    const errorBlock = "TypeError: Cannot read properties of null (reading 'listen')\n    at startServer (server.js:42:15)\n    at init (app.js:10:3)";
    const hugeSuffix = Array.from({ length: 1500 }, (_, i) => `shutdown step ${i} completed ok`).join("\n");
    const massiveMiddleError = `${hugePrefix}\n${errorBlock}\n${hugeSuffix}`;
    assert.ok(massiveMiddleError.length > 80000);

    const capped = hardCapText(massiveMiddleError, 8000);
    assert.ok(capped.length <= 8000);
    assert.ok(capped.includes("TypeError: Cannot read properties of null"));
    assert.ok(capped.includes("at startServer"));
    assert.match(capped, /\[ZenDiet: error context preserved\]/);
    assert.match(capped, /\[\.\.\. ZenDiet: \d+ chars omitted \(failure output hard-capped\) \.\.\.\]/);
  });

  it("hardCapText bounds single giant line with no newlines without throwing", () => {
    const noNewlines = `Error: ${"a".repeat(30000)}`;
    const capped = hardCapText(noNewlines, 4000);
    assert.ok(capped.length <= 4000);
    assert.ok(capped.includes("Error:"));
    assert.match(capped, /chars omitted/);
  });

  it("reduceShellOutput caps massive failure trace while preserving short failures", () => {
    const shortFailure = "npm ERR! code ENOENT\nnpm ERR! syscall open\nError: file not found";
    assert.equal(reduceShellOutput(shortFailure), shortFailure);

    const massiveFailure = `Error: build failed\n${Array.from({ length: 2500 }, (_, i) => `  at step_${i} (/app/src/worker_${i}.js:${i}:14)`).join("\n")}`;
    assert.ok(massiveFailure.length > 50000);
    const reduced = reduceShellOutput(massiveFailure);
    assert.ok(reduced.length <= DEFAULT_FAILURE_MAX_CHARS);
    assert.ok(reduced.includes("Error: build failed"));
    assert.match(reduced, /\[\.\.\. ZenDiet:/);
  });

  it("reduceShellOutput respects explicit maxFailureChars option", () => {
    const failure = `Error: panic\n${Array.from({ length: 300 }, (_, i) => `log line ${i} detailing subsystem state ${i}`).join("\n")}`;
    const reduced = reduceShellOutput(failure, { maxFailureChars: 3000 });
    assert.ok(reduced.length <= 3000);
    assert.ok(reduced.includes("Error: panic"));
  });

  it("reduceDiffOutput hard-caps giant diffs with only additions and deletions", () => {
    const giantDiff = Array.from({ length: 2000 }, (_, i) => `+const row_${i} = generateNewRecordData(${i});`).join("\n");
    assert.ok(giantDiff.length > 70000);
    const reduced = reduceDiffOutput(giantDiff);
    assert.ok(reduced.length <= DEFAULT_DIFF_MAX_CHARS);
    assert.ok(reduced.length < giantDiff.length);
    assert.match(reduced, /\[\.\.\. ZenDiet: \d+ chars omitted \(diff output hard-capped\) \.\.\.\]/);
  });

  it("reduceTestOutput hard-caps massive failing test suites with thousands of failures", () => {
    const massiveTestFails = Array.from({ length: 1500 }, (_, i) => `FAIL src/test_${i}.js\n  AssertionError: expected ${i} to equal ${i + 1}\n    at runTest (test_${i}.js:20:5)`).join("\n");
    assert.ok(massiveTestFails.length > 80000);
    const reduced = reduceTestOutput(massiveTestFails);
    assert.ok(reduced.length <= DEFAULT_FAILURE_MAX_CHARS);
    assert.match(reduced, /\[ZenDiet: test failures preserved\]/);
    assert.match(reduced, /\[\.\.\. ZenDiet:/);
  });

  it("reduceToolOutput generic default hard-caps massive failure output", () => {
    const genericFailure = `command returned 1\n${"dump row\n".repeat(2000)}`;
    const reduced = reduceToolOutput(genericFailure, "custom-runner");
    assert.ok(reduced.length <= DEFAULT_FAILURE_MAX_CHARS);
    assert.ok(reduced.includes("command returned 1"));
  });

  it("emergency pass in safe mode reduces 5MB failure output in active turn", () => {
    const massiveTrace = `Command exited with code 1\n${"debug info trace log line\n".repeat(4000)}`;
    assert.ok(massiveTrace.length > 80000);
    const req = {
      messages: [
        { role: "user", content: "cat huge.log" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "cat" } }] },
        { role: "tool", tool_call_id: "c1", content: massiveTrace },
      ],
    };
    const res = optimizeContext(req, { mode: "safe", contextWindow: 128000 });
    assert.equal(res.changed, true);
    assert.ok(res.decisions.some((d) => d.includes("emergency: reduced 1 huge tool results")));
    const output = res.request.messages[2].content;
    assert.ok(output.length <= HUGE_TOOL_CHARS);
    assert.ok(output.includes("Command exited with code 1"));
  });

  it("emergency pass reduces massive git diff in Anthropic tool_result array format", () => {
    const giantDiff = Array.from({ length: 1500 }, (_, i) => `+added feature line ${i} with extra padding`).join("\n");
    assert.ok(giantDiff.length > 50000);
    const req = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_diff",
              content: [{ type: "text", text: giantDiff }],
            },
          ],
        },
      ],
    };
    const res = optimizeContext(req, { mode: "safe", contextWindow: 128000 });
    assert.equal(res.changed, true);
    const textOut = res.request.messages[0].content[0].content[0].text;
    assert.ok(textOut.length <= HUGE_TOOL_CHARS);
    assert.match(textOut, /\[\.\.\. ZenDiet:/);
  });
});

