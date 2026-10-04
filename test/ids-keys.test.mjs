import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ocId, randomBase62 } from "../lib/ids.mjs";
import { generateKeyString, maskKey, isValidKeysObject } from "../lib/keys.mjs";

describe("ocId", () => {
  it("prefixes ids and keeps them unique", () => {
    const a = ocId("msg");
    const b = ocId("msg");
    assert.match(a, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.notEqual(a, b);
    assert.match(ocId("ses"), /^ses_/);
  });
});

describe("randomBase62", () => {
  it("returns the requested length from the base62 alphabet", () => {
    assert.match(randomBase62(14), /^[0-9A-Za-z]{14}$/);
  });
});

describe("generateKeyString", () => {
  it("emits unique ocp- hex keys", () => {
    const a = generateKeyString();
    assert.match(a, /^ocp-[0-9a-f]{40}$/);
    assert.notEqual(a, generateKeyString());
  });
});

describe("maskKey", () => {
  it("masks keys but keeps head and tail for identification", () => {
    const masked = maskKey("ocp-abcdef1234567890");
    assert.ok(!masked.includes("abcdef1234567890"));
    assert.ok(masked.startsWith("ocp-abc"));
    assert.ok(masked.endsWith("7890"));
  });
  it("masks short and non-string values fully", () => {
    assert.equal(maskKey("short"), "****");
    assert.equal(maskKey(null), "****");
  });
});

describe("isValidKeysObject", () => {
  it("accepts non-empty name-to-key maps", () => {
    assert.equal(isValidKeysObject({ admin: "ocp-x" }), true);
  });
  it("rejects empty, array and malformed values", () => {
    assert.equal(isValidKeysObject({}), false);
    assert.equal(isValidKeysObject([]), false);
    assert.equal(isValidKeysObject(null), false);
    assert.equal(isValidKeysObject({ admin: "" }), false);
    assert.equal(isValidKeysObject({ "": "x" }), false);
    assert.equal(isValidKeysObject("str"), false);
  });
});
