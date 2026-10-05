// Tool-aware reducers for ZenDiet.
// Cleans ANSI sequences and terminal progress noise, preserves test failures
// and stack traces, condenses git diff context, and produces compact snapshots
// of older verbose tool executions.

import { isFailureOutput } from "./classifier.mjs";

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const PROGRESS_LINE_REGEX = /(?:\[[=\->\s]{4,}\]|(?:downloading|extracting|uploading|fetching).*\d+%\b|\b\d+(?:\.\d+)?%\s*(?:completed|done|progress)\b)/i;

// Strip ANSI color and cursor codes from text.
export function stripAnsi(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(ANSI_REGEX, "");
}

// Clean terminal noise: ANSI escapes, carriage-return rewrites, progress spam,
// and long runs of byte-identical repeated lines (log spam, test lists).
export function stripTerminalNoise(text) {
  if (typeof text !== "string" || !text) return text;
  const noAnsi = stripAnsi(text);
  const lines = noAnsi.split(/\r?\n/);
  const cleanLines = [];

  for (let line of lines) {
    if (line.includes("\r")) {
      const parts = line.split("\r").filter(Boolean);
      line = parts.length ? parts[parts.length - 1] : "";
    }
    if (PROGRESS_LINE_REGEX.test(line)) continue;
    cleanLines.push(line);
  }

  return collapseRepeatedLines(cleanLines).join("\n");
}

// Collapse runs of >10 identical consecutive lines into a single placeholder.
export function collapseRepeatedLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return lines;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run > 10 && lines[i].trim() !== "") {
      out.push(lines[i]);
      out.push(`[... repeated ${run - 1} identical lines ...]`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}

// Reduce git diff: preserves all hunk headers (@@) and changed lines (+/-).
// Condenses long runs of unchanged context lines (leading space).
export function reduceDiffOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 2000;
  const cleaned = stripTerminalNoise(text);
  if (cleaned.length <= maxChars) return cleaned;

  const lines = cleaned.split("\n");
  const result = [];
  let unchangedRun = 0;

  for (const line of lines) {
    const isContextLine = line.startsWith(" ");
    if (isContextLine) {
      unchangedRun++;
      if (unchangedRun <= 2) {
        result.push(line);
      } else if (unchangedRun === 3) {
        result.push("  [... unchanged context ...]");
      }
      continue;
    }
    unchangedRun = 0;
    result.push(line);
  }

  const out = result.join("\n");
  return out;
}

// Reduce test output: preserves failures, stack traces, and summary.
// Removes passing noise and progress logs.
export function reduceTestOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 2000;
  const cleaned = stripTerminalNoise(text);
  if (cleaned.length <= maxChars) return cleaned;

  const isFail = isFailureOutput(cleaned);
  const lines = cleaned.split("\n");

  if (isFail) {
    // Preserve failure blocks: keep failing test names, errors, stack traces, summary
    const preserved = [];
    let inStackTrace = false;
    for (const line of lines) {
      if (/FAIL|FAILED|Error:|TypeError|AssertionError|at\s+\S+\s+\(/.test(line)) {
        preserved.push(line);
        inStackTrace = true;
        continue;
      }
      if (inStackTrace && /^\s+at\s+/.test(line)) {
        preserved.push(line);
        continue;
      }
      inStackTrace = false;
      // Keep summary lines
      if (/tests|suites|pass|fail|duration/i.test(line)) {
        preserved.push(line);
      }
    }
    if (preserved.length >= 3) {
      return `[ZenDiet: test failures preserved]\n${preserved.join("\n")}`;
    }
  } else {
    // All tests passed: keep header and summary
    const summaryLines = lines.filter((l) => /pass|passed|suites|duration|tests/i.test(l));
    if (summaryLines.length) {
      return `[ZenDiet: test suite passed]\n${summaryLines.join("\n")}`;
    }
  }

  // Fallback head/tail
  return reduceHeadTail(cleaned, 15, 10);
}

// Reduce file read: keeps head and tail, provides snapshot notice for middle.
export function reduceFileReadOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 2000;
  const cleaned = stripTerminalNoise(text);
  if (cleaned.length <= maxChars) return cleaned;

  const lines = cleaned.split("\n");
  if (lines.length <= 40) return reduceHeadTail(cleaned, 25, 10);

  const head = lines.slice(0, 25).join("\n");
  const tail = lines.slice(-10).join("\n");
  const omitted = lines.length - 35;
  return `${head}\n\n[... ZenDiet: ${omitted} lines omitted; can be reread via tool ...]\n\n${tail}`;
}

// Reduce shell output: strips noise, keeps head and tail if non-error.
export function reduceShellOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 1500;
  const cleaned = stripTerminalNoise(text);
  if (cleaned.length <= maxChars) return cleaned;

  // Never aggressively cut failure outputs
  if (isFailureOutput(cleaned)) return cleaned;

  return reduceHeadTail(cleaned, 20, 15);
}

// Helper to keep head and tail of long text. Falls back to char-level
// truncation for blobs with few lines (minified JSON, base64, long rows).
function reduceHeadTail(text, headLineCount, tailLineCount) {
  const lines = text.split("\n");
  if (lines.length <= headLineCount + tailLineCount) {
    if (text.length <= (headLineCount + tailLineCount) * 120) return text;
    const headChars = headLineCount * 120;
    const tailChars = tailLineCount * 120;
    const omitted = text.length - headChars - tailChars;
    return `${text.slice(0, headChars)}\n\n[... ZenDiet: ${omitted} chars omitted ...]\n\n${text.slice(-tailChars)}`;
  }
  const head = lines.slice(0, headLineCount).join("\n");
  const tail = lines.slice(-tailLineCount).join("\n");
  const omitted = lines.length - (headLineCount + tailLineCount);
  return `${head}\n\n[... ZenDiet: ${omitted} lines omitted ...]\n\n${tail}`;
}

// Dispatch to the appropriate reducer based on tool type.
export function reduceToolOutput(text, toolType = "generic", options = {}) {
  if (typeof text !== "string" || !text) return text;

  switch (toolType) {
    case "git-diff":
      return reduceDiffOutput(text, options);
    case "test":
      return reduceTestOutput(text, options);
    case "file-read":
      return reduceFileReadOutput(text, options);
    case "shell":
      return reduceShellOutput(text, options);
    default: {
      const cleaned = stripTerminalNoise(text);
      const maxChars = options.maxChars ?? 1500;
      if (cleaned.length > maxChars && !isFailureOutput(cleaned)) {
        return reduceHeadTail(cleaned, 20, 15);
      }
      return cleaned;
    }
  }
}
