import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

export function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) result += BASE62[bytes[i] % 62];
  return result;
}

export function ocId(prefix) {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastIdTimestamp) {
    lastIdTimestamp = currentTimestamp;
    idCounter = 0;
  }
  idCounter++;

  const now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  return `${prefix}_${timeBytes.toString("hex")}${randomBase62(14)}`;
}
