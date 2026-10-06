import { StringDecoder } from "node:string_decoder";

export const STREAM_SSE_MAX_LINE_CHARS = 1024 * 1024;
export const STREAM_SSE_HEAD_MAX_CHARS = 65536;

export class BufferLimitError extends Error {
  constructor(totalBytes, maxBytes) {
    super(`Buffered response exceeded limit (${maxBytes} bytes)`);
    this.name = "BufferLimitError";
    this.code = "buffer_limit_exceeded";
    this.status = 413;
    this.totalBytes = totalBytes;
    this.maxBytes = maxBytes;
  }
}

// Incremental SSE line splitter: O(n) total across pushes.
// Keeps decoded chunks in a parts list so appending never copies the
// buffered prefix, and resumes the newline search from the last scanned
// offset instead of re-scanning from zero. Only complete lines are joined
// (each byte joined once); the incomplete tail stays as 1-2 parts.
// Throws BufferLimitError when the incomplete line exceeds maxLineChars,
// which bounds RSS when upstream sends a giant line without newlines.
export function createSseLineSplitter(maxLineChars = STREAM_SSE_MAX_LINE_CHARS) {
  const limit = Number.isInteger(maxLineChars) && maxLineChars > 0
    ? maxLineChars
    : STREAM_SSE_MAX_LINE_CHARS;
  const decoder = new StringDecoder("utf8");
  const parts = [];
  let partsLen = 0;
  let scanPartIdx = 0;
  let scanOffsetInPart = 0;
  let head = "";

  function appendHead(text) {
    if (head.length < STREAM_SSE_HEAD_MAX_CHARS && text) {
      head += text.slice(0, STREAM_SSE_HEAD_MAX_CHARS - head.length);
    }
  }

  function checkLimit() {
    if (partsLen > limit) {
      throw new BufferLimitError(partsLen, limit);
    }
  }

  function consumeThrough(partIdx, nlPos) {
    let line = "";
    for (let i = 0; i < partIdx; i++) {
      line += parts[i];
    }
    line += parts[partIdx].slice(0, nlPos);
    const rest = parts[partIdx].slice(nlPos + 1);
    const tail = parts.slice(partIdx + 1);
    parts.length = 0;
    partsLen = 0;
    if (rest) {
      parts.push(rest);
      partsLen += rest.length;
    }
    for (const t of tail) {
      parts.push(t);
      partsLen += t.length;
    }
    scanPartIdx = 0;
    scanOffsetInPart = 0;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line;
  }

  function extractLines() {
    const out = [];
    for (;;) {
      let foundPart = -1;
      let foundPos = -1;
      for (let i = scanPartIdx; i < parts.length; i++) {
        const part = parts[i];
        const from = i === scanPartIdx ? scanOffsetInPart : 0;
        const nl = part.indexOf("\n", from);
        if (nl !== -1) {
          foundPart = i;
          foundPos = nl;
          break;
        }
      }
      if (foundPart === -1) {
        scanPartIdx = parts.length === 0 ? 0 : parts.length - 1;
        scanOffsetInPart = parts.length === 0 ? 0 : parts[parts.length - 1].length;
        break;
      }
      out.push(consumeThrough(foundPart, foundPos));
    }
    checkLimit();
    return out;
  }

  function push(chunk) {
    const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk ?? "");
    if (!text) return [];
    appendHead(text);
    parts.push(text);
    partsLen += text.length;
    return extractLines();
  }

  function pushText(text) {
    const s = String(text ?? "");
    if (!s) return [];
    appendHead(s);
    parts.push(s);
    partsLen += s.length;
    return extractLines();
  }

  function flush() {
    const tail = decoder.end();
    if (tail) {
      appendHead(tail);
      parts.push(tail);
      partsLen += tail.length;
    }
    if (partsLen === 0) return [];
    checkLimit();
    let line = "";
    for (const p of parts) line += p;
    parts.length = 0;
    partsLen = 0;
    scanPartIdx = 0;
    scanOffsetInPart = 0;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return [line];
  }

  function headText() {
    return head;
  }

  function buffered() {
    let s = "";
    for (const p of parts) s += p;
    return s;
  }

  return {
    push,
    pushText,
    flush,
    head: headText,
    buffered,
    bufferedLength: () => partsLen,
    getMax: () => limit,
  };
}

export function isStreamClosed(res) {
  if (!res || typeof res !== "object") return true;
  return Boolean(res.writableEnded || res.destroyed || res.closed || res.socket?.destroyed);
}

export function safeWrite(res, chunk) {
  if (isStreamClosed(res)) return false;
  try {
    return res.write(chunk);
  } catch {
    return false;
  }
}

export function safeFlush(res) {
  if (isStreamClosed(res)) return;
  try {
    if (typeof res.flush === "function") res.flush();
  } catch {}
}

export function safeEnd(res, chunk) {
  if (isStreamClosed(res)) return false;
  try {
    if (chunk !== undefined) {
      res.end(chunk);
    } else {
      res.end();
    }
    return true;
  } catch {
    return false;
  }
}

