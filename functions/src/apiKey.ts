// Pure API-key hashing for device auth. Must match the web's hashApiKey
// (SHA-256 of the raw string, lowercase hex) so a key generated in the browser
// verifies here.
import { createHash } from "crypto";

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// Constant-time-ish comparison of two hex hashes of equal length.
export function apiKeyMatches(rawKey: string, storedHash: string): boolean {
  const computed = hashApiKey(rawKey);
  if (computed.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}
