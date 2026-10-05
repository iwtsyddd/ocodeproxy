// Experimental tool-description slimming for ZenDiet (opt-in via ZEN_TOOL_SLIM).
// Truncates long tool descriptions to their first sentence. Names, parameters
// and input schemas are never touched; tools are never added, removed or renamed.

export const TOOL_SLIM_MIN_CHARS = 300;
export const TOOL_SLIM_MAX_SENTENCE = 300;

// Cut text to its first sentence, hard-capped at `cap` chars.
export function firstSentence(text, cap = TOOL_SLIM_MAX_SENTENCE) {
  if (typeof text !== "string" || !text) return text;
  if (text.length <= cap) {
    const m = text.match(/^.*?[.!?](?=\s|$)/s);
    return m ? m[0] : text;
  }
  const m = text.match(/^.*?[.!?](?=\s|$)/s);
  if (m && m[0].length <= cap) return m[0];
  return `${text.slice(0, cap).trimEnd()}…`;
}

// Shorten tool descriptions in OpenAI, Responses-flat and Anthropic shapes.
// Returns { tools, changed, slimmedCount, savedChars, savedTokens }.
export function slimToolDescriptions(tools, options = {}) {
  const empty = { tools, changed: false, slimmedCount: 0, savedChars: 0, savedTokens: 0 };
  if (!Array.isArray(tools) || tools.length === 0) return empty;

  const minChars = Number.isInteger(options.minChars) && options.minChars >= 0
    ? options.minChars
    : TOOL_SLIM_MIN_CHARS;

  let slimmedCount = 0;
  let savedChars = 0;
  const next = tools.map((t) => {
    if (!t || typeof t !== "object") return t;
    if (typeof t.function === "object" && t.function !== null && typeof t.function.description === "string") {
      return slimOpenAiTool(t);
    }
    if (typeof t.description === "string" && (t.type === "function" || t.input_schema || t.parameters)) {
      return slimFlatTool(t);
    }
    if (typeof t.description === "string" && typeof t.name === "string") {
      return slimFlatTool(t);
    }
    return t;
  });

  function slimOpenAiTool(t) {
    const desc = t.function.description;
    if (desc.length <= minChars) return t;
    const short = firstSentence(desc);
    if (short.length >= desc.length) return t;
    slimmedCount++;
    savedChars += desc.length - short.length;
    return { ...t, function: { ...t.function, description: short } };
  }

  function slimFlatTool(t) {
    const desc = t.description;
    if (desc.length <= minChars) return t;
    const short = firstSentence(desc);
    if (short.length >= desc.length) return t;
    slimmedCount++;
    savedChars += desc.length - short.length;
    return { ...t, description: short };
  }

  if (slimmedCount === 0) return empty;
  return {
    tools: next,
    changed: true,
    slimmedCount,
    savedChars,
    savedTokens: Math.ceil(savedChars / 4),
  };
}
