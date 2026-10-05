#!/usr/bin/env npx tsx
//
// Set the judge's scene prompt and pin its model.
//
// Both are CONFIG, not code: they take effect on the next trigger with no
// deploy. Read-only unless --write is passed.
//
//   GOOGLE_APPLICATION_CREDENTIALS=... npx tsx scripts/setJudgeTuning.ts
//   GOOGLE_APPLICATION_CREDENTIALS=... npx tsx scripts/setJudgeTuning.ts --write

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS.");
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serviceAccount = require(keyPath);
if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

// Pinned deliberately, NOT the `gemini-flash-lite-latest` alias: that alias
// currently resolves to a 2.5-era model and can be repointed by Google under
// us (see CLAUDE.md and the gemini-judge-api-findings note).
const JUDGE_MODEL = "gemini-3.5-flash-lite";

// Targets the artifact the judge itself reported unprompted on 2026-10-05
// ("an artifact or insect near the lens"). judgePrompt was null, so
// buildPrompt() was rendering "(none)" and the model had no idea which
// quirks of this particular yard are normal.
const JUDGE_PROMPT =
  "Outdoor yard with a shed and a patio, viewed at night by IR cameras. " +
  "Insects, spiders and webs close to the lens are common and appear as " +
  "bright blurred shapes or streaks — these are NOT people. " +
  "Vegetation moves in the wind. Parked vehicles and garden furniture are " +
  "permanent fixtures. Report a breach only for a human figure.";

async function main() {
  const write = process.argv.includes("--write");
  const db = getFirestore();

  for (const p of (await db.collection("projects").get()).docs) {
    const d = p.data();
    console.log(`\n=== ${p.id} (${d.name}) ===`);
    console.log(`  judgeModel:  ${d.judgeModel ?? "(unset -> provider default)"}`);
    console.log(`  judgePrompt: ${d.judgePrompt ? JSON.stringify(d.judgePrompt) : "(unset -> \"(none)\")"}`);

    if (!write) {
      console.log(`  would set judgeModel  = ${JUDGE_MODEL}`);
      console.log(`  would set judgePrompt = ${JSON.stringify(JUDGE_PROMPT)}`);
      continue;
    }
    await p.ref.update({ judgeModel: JUDGE_MODEL, judgePrompt: JUDGE_PROMPT });
    console.log(`  WROTE judgeModel + judgePrompt`);
  }

  if (!write) {
    console.log(`\nDry run. Re-run with --write to apply.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
