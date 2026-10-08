#!/usr/bin/env npx tsx
//
// Build the ESP32-S3 firmware and publish it for over-the-air install.
//
// Uploads the image to Storage at firmware/{version}/firmware.bin and points
// Firestore firmware/latest at it. The web UI's Firmware card reads that doc
// and offers Install when it is newer than what the device reports running;
// Install writes /{projectId}/commands/ota and the device takes it from there
// (see firmware/edge/device/src/ota_updater.h).
//
// DRY RUN unless --write: builds and prints what would be published.
//
//   GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json npm run publish:firmware
//   GOOGLE_APPLICATION_CREDENTIALS=... npm run publish:firmware -- --write
//
// Flags:
//   --write          actually upload and update firmware/latest
//   --no-build       publish the existing .pio/build/esp32s3 output as-is
//   --allow-dirty    allow a build from a tree with uncommitted changes
//   --force          allow a version that does not sort after the current one
//   --notes "..."    short release note shown in the web UI
//
// The version is stamped by firmware/edge/device/fw_version.py at build time
// and read back from the build directory, so the published manifest always
// names the exact string the image will report once running.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import {
  FIRMWARE_COLLECTION,
  FIRMWARE_LATEST_DOC,
  FirmwareManifest,
  firmwareObjectPath,
  publishBlocker,
} from "../src/firmwareRelease";

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS to the service-account json.");
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serviceAccount = require(resolve(keyPath));
const bucketName =
  process.env.FIREBASE_STORAGE_BUCKET ?? `${serviceAccount.project_id}.firebasestorage.app`;

if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount), storageBucket: bucketName });
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const noBuild = args.includes("--no-build");
const allowDirty = args.includes("--allow-dirty");
const force = args.includes("--force");
const notesIdx = args.indexOf("--notes");
const notes = notesIdx >= 0 ? args[notesIdx + 1] : undefined;

const deviceDir = resolve(__dirname, "../../firmware/edge/device");
const buildDir = join(deviceDir, ".pio/build/esp32s3");

function findPio(): string {
  if (process.env.PIO) return process.env.PIO;
  const which = spawnSync("which", ["pio"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const penv = join(homedir(), ".platformio/penv/bin/pio");
  if (existsSync(penv)) return penv;
  throw new Error("pio not found: install PlatformIO or set PIO=/path/to/pio");
}

async function main() {
  if (!noBuild) {
    // ALWAYS -e esp32s3: a bare `pio run` also builds [env:native], which
    // fails to link (CLAUDE.md).
    console.log("Building firmware (pio run -e esp32s3)…");
    const r = spawnSync(findPio(), ["run", "-e", "esp32s3"], { cwd: deviceDir, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`build failed (exit ${r.status})`);
  }

  const version = readFileSync(join(buildDir, "fw_version.txt"), "utf8").trim();
  const image = readFileSync(join(buildDir, "firmware.bin"));
  const md5 = createHash("md5").update(image).digest("hex");
  const sha256 = createHash("sha256").update(image).digest("hex");

  const db = getFirestore();
  const latestRef = db.collection(FIRMWARE_COLLECTION).doc(FIRMWARE_LATEST_DOC);
  const current = (await latestRef.get()).data() as FirmwareManifest | undefined;

  console.log(`\n  version:   ${version}`);
  console.log(`  size:      ${image.length} bytes`);
  console.log(`  md5:       ${md5}`);
  console.log(`  bucket:    ${bucketName}`);
  console.log(`  published: ${current ? current.version : "(none yet)"}`);

  const blocker = publishBlocker({
    version,
    size: image.length,
    currentLatest: current?.version ?? null,
    allowDirty,
    force,
  });
  if (blocker) {
    console.error(`\nRefusing to publish: ${blocker}`);
    process.exit(1);
  }

  const path = firmwareObjectPath(version);
  if (!write) {
    console.log(`\nDry run. Would upload gs://${bucketName}/${path} and update firmware/latest.`);
    console.log("Re-run with --write to publish.");
    return;
  }

  // Image first, manifest second: the manifest is what makes the web UI
  // offer the update, so it must never point at an object not yet uploaded.
  await getStorage()
    .bucket()
    .file(path)
    .save(image, {
      resumable: false,
      contentType: "application/octet-stream",
      metadata: { metadata: { version, md5, sha256 } },
    });
  console.log(`\nUploaded gs://${bucketName}/${path}`);

  const manifest: FirmwareManifest = {
    version,
    path,
    size: image.length,
    md5,
    sha256,
    publishedAt: Date.now(),
    ...(notes ? { notes } : {}),
  };
  await latestRef.set(manifest);
  console.log(`firmware/latest -> ${version}. The web UI will now offer it.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
