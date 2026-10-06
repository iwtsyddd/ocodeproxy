import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSseLineSplitter,
  STREAM_SSE_MAX_LINE_CHARS,
  STREAM_SSE_HEAD_MAX_CHARS,
  BufferLimitError,
  isStreamClosed,
  safeWrite,
  safeFlush,
  safeEnd,
} from "../lib/sse.mjs";

describe("createSseLineSplitter", () => {
  it("splits lines across chunk boundaries without rescanning", () => {
    const sp = createSseLineSplitter();
    const out = [];
    out.push(...sp.push("data: 1\npar"));
    out.push(...sp.push("tial\n"));
    out.push(...sp.push("data: 2\n"));
    assert.deepEqual(out, ["data: 1", "partial", "data: 2"]);
    assert.equal(sp.bufferedLength(), 0);
  });

  it("strips CR from CRLF and handles split CRLF", () => {
    const sp = createSseLineSplitter();
    assert.deepEqual(sp.push("a\r"), []);
    assert.deepEqual(sp.push("\nb\r\nc"), ["a", "b"]);
    assert.deepEqual(sp.flush(), ["c"]);
  });

  it("decodes split multibyte characters across Buffer boundaries", () => {
    const sp = createSseLineSplitter();
    const raw = Buffer.from("data: hi 👍 bye\n", "utf8");
    const lines = [];
    lines.push(...sp.push(raw.subarray(0, raw.length - 2)));
    lines.push(...sp.push(raw.subarray(raw.length - 2)));
    assert.deepEqual(lines, ["data: hi 👍 bye"]);
  });

  it("handles negatives without throwing", () => {
    const sp = createSseLineSplitter();
    assert.deepEqual(sp.push(""), []);
    assert.deepEqual(sp.push(null), []);
    assert.deepEqual(sp.push(undefined), []);
    assert.deepEqual(sp.pushText(""), []);
    assert.deepEqual(sp.pushText(null), []);
    assert.deepEqual(sp.flush(), []);
    assert.equal(sp.buffered(), "");
    assert.equal(sp.head(), "");
  });

  it("caps a giant line without newlines", () => {
    const sp = createSseLineSplitter(16);
    assert.throws(() => sp.push("a".repeat(17)), (e) => e instanceof BufferLimitError && e.code === "buffer_limit_exceeded");
  });

  it("caps across many small chunks", () => {
    const sp = createSseLineSplitter(10);
    sp.push("12345");
    assert.throws(() => sp.push("67890A"), (e) => e.code === "buffer_limit_exceeded");
  });

  it("keeps only a head sample for error detection", () => {
    const sp = createSseLineSplitter();
    sp.push("x".repeat(STREAM_SSE_HEAD_MAX_CHARS + 100) + "\n");
    assert.equal(sp.head().length, STREAM_SSE_HEAD_MAX_CHARS);
  });

  it("flush returns trailing line without newline", () => {
    const sp = createSseLineSplitter();
    assert.deepEqual(sp.push("data: hi"), []);
    assert.deepEqual(sp.flush(), ["data: hi"]);
    assert.equal(sp.bufferedLength(), 0);
  });

  it("handles many small chunks in linear fashion", () => {
    const sp = createSseLineSplitter();
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(...sp.push(`data: ${i}\n`));
    }
    assert.equal(lines.length, 1000);
    assert.equal(lines[0], "data: 0");
    assert.equal(lines[999], "data: 999");
  });

  it("exposes max and defaults", () => {
    assert.ok(STREAM_SSE_MAX_LINE_CHARS >= 1024 * 1024);
    assert.equal(createSseLineSplitter().getMax(), STREAM_SSE_MAX_LINE_CHARS);
    assert.equal(createSseLineSplitter(0).getMax(), STREAM_SSE_MAX_LINE_CHARS);
  });
});

describe("isStreamClosed", () => {
  it("treats null, undefined, and non-objects as closed", () => {
    assert.equal(isStreamClosed(null), true);
    assert.equal(isStreamClosed(undefined), true);
    assert.equal(isStreamClosed("string"), true);
    assert.equal(isStreamClosed(123), true);
  });

  it("identifies closed and destroyed states", () => {
    assert.equal(isStreamClosed({ writableEnded: true }), true);
    assert.equal(isStreamClosed({ destroyed: true }), true);
    assert.equal(isStreamClosed({ closed: true }), true);
    assert.equal(isStreamClosed({ socket: { destroyed: true } }), true);
    assert.equal(isStreamClosed({ writableEnded: false, destroyed: false, closed: false }), false);
  });
});

describe("safeWrite", () => {
  it("returns false on closed or destroyed streams without calling write", () => {
    let called = false;
    const closedRes = { destroyed: true, write: () => { called = true; } };
    assert.equal(safeWrite(closedRes, "data"), false);
    assert.equal(called, false);
    assert.equal(safeWrite(null, "data"), false);
  });

  it("catches ERR_STREAM_DESTROYED and sync errors without throwing", () => {
    const errorRes = {
      destroyed: false,
      write: () => {
        const err = new Error("Cannot call write after a stream was destroyed");
        err.code = "ERR_STREAM_DESTROYED";
        throw err;
      },
    };
    assert.equal(safeWrite(errorRes, "data"), false);
  });

  it("writes to active stream and returns write result", () => {
    let written = null;
    const activeRes = {
      destroyed: false,
      writableEnded: false,
      closed: false,
      write: (chunk) => {
        written = chunk;
        return true;
      },
    };
    assert.equal(safeWrite(activeRes, "hello"), true);
    assert.equal(written, "hello");
  });
});

describe("safeFlush and safeEnd", () => {
  it("safeFlush does not throw on closed stream or flush throw", () => {
    assert.doesNotThrow(() => safeFlush(null));
    assert.doesNotThrow(() => safeFlush({ destroyed: true }));
    assert.doesNotThrow(() => safeFlush({
      flush: () => { throw new Error("flush error"); },
    }));
    let flushed = false;
    safeFlush({ flush: () => { flushed = true; } });
    assert.equal(flushed, true);
  });

  it("safeEnd returns false on closed or destroyed streams", () => {
    assert.equal(safeEnd(null), false);
    assert.equal(safeEnd({ destroyed: true }), false);
    assert.equal(safeEnd({ writableEnded: true }), false);
  });

  it("safeEnd catches throw and returns false", () => {
    const errorRes = {
      end: () => { throw new Error("end error"); },
    };
    assert.equal(safeEnd(errorRes), false);
  });

  it("safeEnd calls end on active stream", () => {
    let endedWith = null;
    const activeRes = {
      end: (chunk) => { endedWith = chunk; },
    };
    assert.equal(safeEnd(activeRes, "tail"), true);
    assert.equal(endedWith, "tail");
  });
});

