// Cloud Function: mintDeviceToken (HTTPS)
// Mints a Firebase custom auth token for a device, scoped to its project via
// custom claims. The device presents its raw apiKey (same credential used by
// deviceIngest); we resolve projectId the same way, then mint a token with
// { projectId, role: "device" } claims. Security rules (database.rules.json)
// use these claims to scope the device's RTDB access to its own project.
//
// POST JSON: { apiKey }
// Response: { customToken } | { error }
import { onRequest } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { db } from "./admin";
import { hashApiKey, apiKeyMatches } from "./apiKey";
import type { Project } from "./types";

export const mintDeviceToken = onRequest(
  { region: "europe-west1", cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }
    const { apiKey } = (req.body ?? {}) as { apiKey?: string };

    if (!apiKey) {
      res.status(400).json({ error: "apiKey required" });
      return;
    }

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
    if (!apiKeyMatches(apiKey, project.device.apiKeyHash)) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }

    const customToken = await getAuth().createCustomToken(`device:${projectId}`, {
      projectId,
      role: "device",
    });

    // projectId is returned alongside the token so the firmware can prefix
    // its RTDB paths (/{projectId}/commands, /config, /events/...) — it has
    // no other way to learn its own project at runtime.
    res.status(200).json({ customToken, projectId });
  }
);
