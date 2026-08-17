// Fire 3 simulated Kerui sensor events through the deviceIngest endpoint,
// authenticating with the project's API key exactly as the D1 Mini firmware
// will. No admin credentials needed.
//
// Usage:
//    API_KEY=<rawKey> node smoke/add-sensors.mjs
// or edit the constants below.

const ENDPOINT =
  "https://europe-west1-alarm-system-100.cloudfunctions.net/deviceIngest";

const API_KEY =
  process.env.API_KEY ??
  "fa8d4c99b4dba632cee06f48826ab5b0d458ea4515b8bcab5cf90dc26a10c6eb";

const SENSORS = [
  //{ rfId: "0xA1B2C3", event: "trigger", battery_low: false, rssi: -58 },
  //{ rfId: "0xD4E5F6", event: "trigger", battery_low: false, rssi: -67 },
  //{ rfId: "0x778899", event: "battery_low", battery_low: true, rssi: -80 },
  { rfId: "0x778899", event: "trigger", battery_low: false, rssi: -80 },
];

async function fire(s) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: API_KEY,
      rfId: s.rfId,
      event: s.event,
      battery_low: s.battery_low,
      rssi: s.rssi,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  
  console.log(`Firing ${SENSORS.length} events  via deviceIngest`);
  let ok = 0;
  for (const s of SENSORS) {
    const r = await fire(s);
    if (r.status === 200) {
      ok++;
      console.log(`  ✓ ${s.rfId} (${s.event}) → ${JSON.stringify(r.body)}`);
    } else {
      console.error(`  ✗ ${s.rfId} → HTTP ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  console.log(
    `\n${ok}/${SENSORS.length} accepted. Open Configure → Sensors to pair the unknown sensors.`
  );
  process.exit(ok === SENSORS.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
