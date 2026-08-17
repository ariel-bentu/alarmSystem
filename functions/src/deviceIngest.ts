// Cloud Function: deviceIngest (HTTPS)
// The authentication + write path for edge devices (D1 Mini firmware). Devices
// don't use Google SSO and don't need to know their projectId — they present
// just the raw apiKey. We hash it, look up the deviceKeys index to find the
// project, verify against the stored hash, then write the sensor event to RTDB
// (which fans out to onSensorEvent) and stamp device.lastSeen.
//
// POST JSON: { apiKey, rfId, event, battery_low?, rssi? }
//   event: "trigger" | "tamper" | "battery_low"
import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { db, rtdb } from "./admin";
import { hashApiKey, apiKeyMatches } from "./apiKey";
import type { Project } from "./types";

export const deviceIngest = onRequest(
  { region: "europe-west1", cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }
    const { apiKey, rfId, event, battery_low, rssi } = (req.body ?? {}) as {
      apiKey?: string;
      rfId?: string;
      event?: string;
      battery_low?: boolean;
      rssi?: number;
    };

    if (!apiKey || !rfId || !event) {
      res.status(400).json({ error: "apiKey, rfId, event required" });
      return;
    }

    // Resolve the project from the key hash via the deviceKeys index.
    const keyHash = hashApiKey(apiKey);
    const idxSnap = await db.doc(`deviceKeys/${keyHash}`).get();
    if (!idxSnap.exists) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }
    const projectId = (idxSnap.data() as { projectId: string }).projectId;

    const projectSnap = await db.doc(`projects/${projectId}`).get();
    if (!projectSnap.exists) {
      res.status(404).json({ error: "project missing" });
      return;
    }
    const project = projectSnap.data() as Project;
    // Defence in depth: confirm the stored hash still matches this key.
    if (!apiKeyMatches(apiKey, project.device.apiKeyHash)) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }

    // Authenticated. Write the raw event exactly as the firmware would; the key
    // is an epoch-ms timestamp so events sort chronologically.
    const ts = Date.now();
    await rtdb.ref(`${projectId}/events/${rfId}/${ts}`).set({
      event,
      battery_low: battery_low ?? false,
      rssi: rssi ?? 0,
    });
    await db
      .doc(`projects/${projectId}`)
      .update({ "device.lastSeen": Timestamp.now() });

    res.status(200).json({ status: "ok", timestamp: ts });
  }
);
