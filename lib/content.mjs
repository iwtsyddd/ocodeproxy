export function openAIContentToResponsesText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p?.text === "string") return p.text;
      if (typeof p === "string") return p;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function openAIContentToResponsesInput(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: "" }];
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if ((p.type === "text" || p.type === "input_text") && typeof p.text === "string") {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image_url" && p.image_url?.url) {
      parts.push({ type: "input_image", image_url: p.image_url.url });
    } else if (p.type === "input_image" && p.image_url) {
      parts.push({ type: "input_image", image_url: p.image_url });
    }
  }
  return parts.length ? parts : [{ type: "input_text", text: "" }];
}

export function anthropicImageToOpenAI(b) {
  const src = b?.source || {};
  if (src.type === "base64" && src.data) {
    const mime = src.media_type || "image/jpeg";
    return { type: "image_url", image_url: { url: `data:${mime};base64,${src.data}` } };
  }
  if (src.type === "url" && src.url) return { type: "image_url", image_url: { url: src.url } };
  if (typeof b?.url === "string") return { type: "image_url", image_url: { url: b.url } };
  return null;
}

export function anthropicDocumentText(b) {
  if (typeof b?.text === "string") return b.text;
  const src = b?.source || {};
  if (typeof src.text === "string") return src.text;
  if (typeof src.data === "string") {
    if (src.type === "text" || src.media_type === "text/plain") {
      try {
        return Buffer.from(src.data, "base64").toString("utf8");
      } catch {
        return src.data;
      }
    }
    return `[document: ${b?.title || src.media_type || "binary"}]`;
  }
  if (src.type === "url" && src.url) return `[document: ${src.url}]`;
  if (typeof b?.title === "string" && b.title) return `[document: ${b.title}]`;
  return "";
}

export function anthropicToolResultText(b) {
  let raw = "";
  if (typeof b?.content === "string") raw = b.content;
  else if (Array.isArray(b?.content)) {
    const parts = [];
    for (const c of b.content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      else if (c.type === "image") {
        const img = anthropicImageToOpenAI(c);
        if (img) parts.push(`[image: ${img.image_url.url.slice(0, 200)}]`);
      } else if (c.type === "document") {
        const t = anthropicDocumentText(c);
        if (t) parts.push(t);
      } else if (typeof c.text === "string") parts.push(c.text);
    }
    raw = parts.join("\n");
  } else if (b?.content != null) raw = String(b.content);
  if (b?.is_error) raw = raw ? `[tool_error] ${raw}` : "[tool_error]";
  return raw;
}

export function pickCacheControl(b) {
  const cc = b?.cache_control;
  if (cc && typeof cc === "object" && !Array.isArray(cc)) return cc;
  return undefined;
}
