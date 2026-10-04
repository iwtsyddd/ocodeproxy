import crypto from "node:crypto";

export function generateKeyString() {
  return "ocp-" + crypto.randomBytes(20).toString("hex");
}

export function maskKey(key) {
  if (typeof key !== "string" || key.length < 8) return "****";
  return `${key.slice(0, 7)}…****…${key.slice(-4)}`;
}

export function isValidKeysObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const entries = Object.entries(obj);
  if (entries.length === 0) return false;
  return entries.every(([name, key]) => typeof name === "string" && name.length > 0 && typeof key === "string" && key.length > 0);
}
