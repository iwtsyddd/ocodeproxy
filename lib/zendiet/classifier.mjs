// Tool output classifier for ZenDiet.
// Categorizes tool results into semantic types (git-diff, test, file-read, search,
// shell, generic) and identifies error/failure states to ensure critical debugging
// context is never lost.

export const TOOL_TYPES = new Set([
  "git-diff",
  "test",
  "file-read",
  "search",
  "shell",
  "generic",
]);

const FAILURE_PATTERNS = [
  /\b(?:FAIL|FAILED|FAILURE)\b/,
  /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|AssertionError)\b/,
  /\b(?:(?:exit|exited)(?: with)? code [1-9]|status [1-9]|returned [1-9])\b/i,
  /\b(?:fatal:|panic:|traceback \(most recent call last\):)/i,
  /\bTS\d{4,5}\b/,
  /\b(?:ENOENT|ECONNREFUSED|EACCES|EPERM|ETIMEDOUT)\b/,
];

// Returns true if output contains error, failure, or crash signals.
export function isFailureOutput(text) {
  if (typeof text !== "string" || !text) return false;
  return FAILURE_PATTERNS.some((re) => re.test(text));
}

// Classify tool execution result based on tool name and output content.
export function classifyToolOutput(toolName = "", content = "") {
  const name = String(toolName || "").toLowerCase();
  const text = typeof content === "string" ? content : "";

  // 1. Git diff
  if (/diff|git_diff/.test(name) || text.startsWith("diff --git") || /@@ -\d+,\d+ \+\d+,\d+ @@/.test(text)) {
    return "git-diff";
  }

  // 2. Test output
  if (
    /test|jest|vitest|pytest|mocha|karma|ava|run_test/.test(name) ||
    /\b(?:\d+ passed|\d+ failed|\d+ suites|test results:|tests passed)\b/i.test(text)
  ) {
    return "test";
  }

  // 3. Search results (grep, glob, find)
  if (
    /grep|glob|find|search/.test(name) ||
    /^(?:[^\n:]+:\d+:.*(?:\n|$)){2,}/m.test(text)
  ) {
    return "search";
  }

  // 4. File reading (cat, view_file, read_file)
  if (/read|cat|view_file|open_file|viewfile|readfile|get_file/.test(name)) {
    return "file-read";
  }

  // 5. Shell execution
  if (/bash|sh|cmd|exec|terminal|run_command|runcommand|shell|command/.test(name)) {
    return "shell";
  }

  return "generic";
}
