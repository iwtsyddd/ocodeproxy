// Tool-aware reducers for ZenDiet.
// Cleans ANSI sequences and terminal progress noise, preserves test failures
// and stack traces, condenses git diff context, and produces compact snapshots
// of older verbose tool executions.

import { isFailureOutput, FAILURE_PATTERNS } from "./classifier.mjs";

export const DEFAULT_FAILURE_MAX_CHARS = 10000;
export const DEFAULT_DIFF_MAX_CHARS = 10000;

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

function snapHead(str, minLengthRatio = 0.7) {
  const nl = str.lastIndexOf("\n");
  if (nl >= 0 && nl >= str.length * minLengthRatio) {
    return str.slice(0, nl);
  }
  return str;
}

function snapTail(str, maxSkipRatio = 0.3) {
  const nl = str.indexOf("\n");
  if (nl >= 0 && nl <= str.length * maxSkipRatio) {
    return str.slice(nl + 1);
  }
  return str;
}

// Hard-cap massive tool outputs (including failure traces, giant diffs, or logs)
// using head + tail split (and middle error preservation when applicable)
// to guarantee prompts never explode even when commands emit megabytes of errors.
export function hardCapText(text, maxChars = DEFAULT_FAILURE_MAX_CHARS, options = {}) {
  if (typeof text !== "string" || !text) return text;
  const max = typeof maxChars === "number" && maxChars > 0 ? maxChars : DEFAULT_FAILURE_MAX_CHARS;
  if (text.length <= max) return text;

  const isFail = options.isFailure ?? isFailureOutput(text);
  const reason = options.reason || (isFail ? "failure output hard-capped" : "output hard-capped");

  // Attempt middle error preservation if error is buried in the middle
  if (isFail && max >= 1500) {
    const headCandidate = text.slice(0, Math.floor(max * 0.55));
    const tailCandidate = text.slice(-Math.floor(max * 0.35));

    const headHasError = isFailureOutput(headCandidate);
    const tailHasError = isFailureOutput(tailCandidate);

    if (!headHasError && !tailHasError) {
      let errorIdx = -1;
      for (const pat of FAILURE_PATTERNS) {
        const m = pat.exec(text);
        if (m && (errorIdx === -1 || m.index < errorIdx)) {
          errorIdx = m.index;
        }
      }

      if (errorIdx !== -1) {
        const banner1 = `\n\n[... ZenDiet: ${text.length} chars omitted ...]\n\n[ZenDiet: error context preserved]\n`;
        const banner2 = `\n\n[... ZenDiet: ${text.length} chars omitted (${reason}) ...]\n\n`;
        const totalBannerLen = banner1.length + banner2.length;
        if (max > totalBannerLen + 150) {
          const available = max - totalBannerLen;
          const headBudget = Math.floor(available * 0.25);
          const tailBudget = Math.floor(available * 0.25);
          const midBudget = available - headBudget - tailBudget;

          const midLeadBudget = Math.floor(midBudget * 0.15);
          let midStart = Math.max(0, errorIdx - midLeadBudget);
          let midEnd = Math.min(text.length, midStart + midBudget);

          const snapStart = text.indexOf("\n", midStart);
          if (snapStart >= 0 && snapStart < errorIdx) {
            midStart = snapStart + 1;
          }
          const snapEnd = text.lastIndexOf("\n", midEnd);
          if (snapEnd > midStart) {
            midEnd = snapEnd;
          }

          let head = snapHead(text.slice(0, headBudget));
          let tail = snapTail(text.slice(-tailBudget));

          if (head.length > headBudget) head = head.slice(0, headBudget);
          if (tail.length > tailBudget) tail = tail.slice(-tailBudget);
          let mid = text.slice(midStart, midEnd);
          if (mid.length > midBudget) mid = mid.slice(0, midBudget);

          if (midStart > head.length && midEnd < text.length - tail.length) {
            const omittedBefore = midStart - head.length;
            const omittedAfter = (text.length - tail.length) - midEnd;

            if (omittedBefore > 0 && omittedAfter > 0) {
              const assembled = `${head}\n\n[... ZenDiet: ${omittedBefore} chars omitted ...]\n\n[ZenDiet: error context preserved]\n${mid}\n\n[... ZenDiet: ${omittedAfter} chars omitted (${reason}) ...]\n\n${tail}`;
              if (assembled.length <= max) {
                return assembled;
              }
            }
          }
        }
      }
    }
  }

  // Standard head + tail split with line snapping
  const noticeSample = `\n\n[... ZenDiet: ${text.length} chars omitted (${reason}) ...]\n\n`;
  const bannerLen = noticeSample.length;
  if (max <= bannerLen + 20) {
    return text.slice(0, max);
  }

  const available = max - bannerLen;
  const headBudget = Math.floor(available * 0.60);
  const tailBudget = available - headBudget;

  let head = snapHead(text.slice(0, headBudget));
  let tail = snapTail(text.slice(-tailBudget));

  if (!head && headBudget > 0) head = text.slice(0, headBudget);
  if (!tail && tailBudget > 0) tail = text.slice(-tailBudget);

  if (head.length > headBudget) head = head.slice(0, headBudget);
  if (tail.length > tailBudget) tail = tail.slice(-tailBudget);

  const omitted = text.length - head.length - tail.length;
  if (omitted <= 0) return text;

  const result = `${head}\n\n[... ZenDiet: ${omitted} chars omitted (${reason}) ...]\n\n${tail}`;
  if (result.length > max) {
    return result.slice(0, max);
  }
  return result;
}

// Reduce git diff: preserves all hunk headers (@@) and changed lines (+/-).
// Condenses long runs of unchanged context lines (leading space),
// and hard-caps massive diff outputs to prevent prompt explosion.
export function reduceDiffOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 2000;
  const diffMaxChars = options.maxDiffChars ?? options.hardCapChars ?? options.maxFailureChars ?? DEFAULT_DIFF_MAX_CHARS;
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
  if (out.length > diffMaxChars) {
    return hardCapText(out, diffMaxChars, { reason: "diff output hard-capped" });
  }
  return out;
}

// Reduce test output: preserves failures, stack traces, and summary.
// Removes passing noise and progress logs, and hard-caps massive failure traces.
export function reduceTestOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 2000;
  const failureMaxChars = options.maxFailureChars ?? options.hardCapChars ?? DEFAULT_FAILURE_MAX_CHARS;
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
      const res = `[ZenDiet: test failures preserved]\n${preserved.join("\n")}`;
      if (res.length > failureMaxChars) {
        return hardCapText(res, failureMaxChars, { isFailure: true, reason: "test failure output hard-capped" });
      }
      return res;
    }
  } else {
    // All tests passed: keep header and summary
    const summaryLines = lines.filter((l) => /pass|passed|suites|duration|tests/i.test(l));
    if (summaryLines.length) {
      const res = `[ZenDiet: test suite passed]\n${summaryLines.join("\n")}`;
      if (res.length > failureMaxChars) {
        return hardCapText(res, failureMaxChars, { reason: "test summary hard-capped" });
      }
      return res;
    }
  }

  // Fallback head/tail
  const fallback = reduceHeadTail(cleaned, 15, 10);
  if (fallback.length > failureMaxChars) {
    return hardCapText(fallback, failureMaxChars, { isFailure: isFail, reason: isFail ? "test failure output hard-capped" : "test output hard-capped" });
  }
  return fallback;
}

// Reduce file read: keeps head and tail, provides snapshot notice for middle.
export function reduceFileReadOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 2000;
  const hardCap = options.hardCapChars ?? options.maxFailureChars ?? DEFAULT_FAILURE_MAX_CHARS;
  const cleaned = stripTerminalNoise(text);
  if (cleaned.length <= maxChars) return cleaned;

  const lines = cleaned.split("\n");
  let res;
  if (lines.length <= 40) {
    res = reduceHeadTail(cleaned, 25, 10);
  } else {
    const head = lines.slice(0, 25).join("\n");
    const tail = lines.slice(-10).join("\n");
    const omitted = lines.length - 35;
    res = `${head}\n\n[... ZenDiet: ${omitted} lines omitted; can be reread via tool ...]\n\n${tail}`;
  }

  if (res.length > hardCap) {
    return hardCapText(res, hardCap, { reason: "file read hard-capped" });
  }
  return res;
}

// Reduce shell output: strips noise, keeps head and tail if non-error,
// and enforces hard cap on failure outputs.
export function reduceShellOutput(text, options = {}) {
  const maxChars = options.maxChars ?? 1500;
  const failureMaxChars = options.maxFailureChars ?? options.hardCapChars ?? DEFAULT_FAILURE_MAX_CHARS;
  const cleaned = stripTerminalNoise(text);
  if (cleaned.length <= maxChars) return cleaned;

  // Never aggressively cut failure outputs, but enforce hard cap to prevent runaway prompts
  if (isFailureOutput(cleaned)) {
    if (cleaned.length <= failureMaxChars) return cleaned;
    return hardCapText(cleaned, failureMaxChars, { isFailure: true, reason: "failure output hard-capped" });
  }

  const res = reduceHeadTail(cleaned, 20, 15);
  if (res.length > failureMaxChars) {
    return hardCapText(res, failureMaxChars, { reason: "shell output hard-capped" });
  }
  return res;
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
      const failureMaxChars = options.maxFailureChars ?? options.hardCapChars ?? DEFAULT_FAILURE_MAX_CHARS;
      if (isFailureOutput(cleaned)) {
        if (cleaned.length <= failureMaxChars) return cleaned;
        return hardCapText(cleaned, failureMaxChars, { isFailure: true, reason: "failure output hard-capped" });
      }
      if (cleaned.length > maxChars) {
        const res = reduceHeadTail(cleaned, 20, 15);
        if (res.length > failureMaxChars) {
          return hardCapText(res, failureMaxChars, { reason: "tool output hard-capped" });
        }
        return res;
      }
      return cleaned;
    }
  }
}
