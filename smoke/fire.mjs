// Fire arbitrary sensor events through deviceIngest, for testing alarm rules.
//
// Usage:
//   node smoke/fire.mjs 0xA1B2C3 0x778899 0x778899
//   node smoke/fire.mjs --delay 2000 0x778899 0x778899
//
// Each argument is an rfId to trigger, in order. --delay N sets ms between
// events (default 800).

const ENDPOINT =
  "https://europe-west1-alarm-system-100.cloudfunctions.net/deviceIngest";

const API_KEY =
  process.env.API_KEY ??
  "fa8d4c99b4dba632cee06f48826ab5b0d458ea4515b8bcab5cf90dc26a10c6eb";

const args = process.argv.slice(2);
let delayMs = 800;
const rfIds = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--delay") {
    delayMs = Number(args[++i]);
  } else {
    rfIds.push(args[i]);
  }
}

if (rfIds.length === 0) {
  console.error("Usage: node smoke/fire.mjs [--delay ms] <rfId> [rfId ...]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fire(rfId) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: API_KEY,
      rfId,
      event: "trigger",
      battery_low: false,
      rssi: -60,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

for (const [i, rfId] of rfIds.entries()) {
  const r = await fire(rfId);
  const stamp = new Date().toLocaleTimeString();
  console.log(
    `${stamp}  ${r.status === 200 ? "✓" : "✗"} ${rfId} → ${JSON.stringify(r.body)}`
  );
  if (i < rfIds.length - 1) await sleep(delayMs);
}
