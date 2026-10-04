#!/usr/bin/env npx tsx
//
// Writes an AI-judge API key into the server-only `config/judge` document.
//
// That doc is locked to `allow read, write: if false` in firestore.rules — no
// client can read it, only Cloud Functions through the admin SDK. This script
// uses a service-account credential, which bypasses rules the same way.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json \
//     npm run set:judgeKey -- gemini AQ.xxxxx
//   GOOGLE_APPLICATION_CREDENTIALS=... npm run set:judgeKey -- --show
//
// The key is never echoed back, only masked.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account json.");
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serviceAccount = require(keyPath);

if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

const FIELD: Record<string, string> = {
  anthropic: "anthropicApiKey",
  claude: "anthropicApiKey",
  gemini: "geminiApiKey",
};

function mask(k: string): string {
  return k.length <= 8 ? "****" : `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`;
}

async function main() {
  const db = getFirestore();
  const ref = db.doc("config/judge");
  const [provider, apiKey] = process.argv.slice(2);

  if (provider === "--show" || !provider) {
    const snap = await ref.get();
    if (!snap.exists) {
      console.log("config/judge does not exist yet — no keys configured.");
      return;
    }
    const data = snap.data() ?? {};
    for (const field of ["anthropicApiKey", "geminiApiKey"]) {
      const v = data[field];
      console.log(
        `${field.padEnd(16)} ${typeof v === "string" && v ? mask(v) : "(not set)"}`
      );
    }
    return;
  }

  const field = FIELD[provider];
  if (!field) {
    console.error(`Unknown provider "${provider}". Use: anthropic | gemini`);
    process.exit(2);
  }
  if (!apiKey) {
    console.error(`Usage: npm run set:judgeKey -- ${provider} <apiKey>`);
    process.exit(2);
  }

  await ref.set({ [field]: apiKey }, { merge: true });
  console.log(`config/judge.${field} = ${mask(apiKey)}  ✓ written`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
