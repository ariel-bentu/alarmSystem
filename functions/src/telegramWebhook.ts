// Cloud Function: telegramWebhook
// HTTPS endpoint that receives Telegram updates.
// Webhook URL must include ?projectId= query parameter to identify the project.

import { onRequest } from "firebase-functions/v2/https";
import { db, rtdb } from "./admin";
import { Project, Sensor, Profile } from "./types";
import { parseCommand } from "./parseCommand";
import { sendTelegram, formatStatus, StatusInfo } from "./telegram";

export const telegramWebhook = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const projectId = req.query.projectId as string | undefined;
    if (!projectId) {
      res.status(400).send("Missing projectId query parameter");
      return;
    }

    const body = req.body;
    const message = body?.message;
    if (!message || !message.text) {
      res.status(200).send("OK");
      return;
    }

    const chatId = String(message.chat.id);

    // Load project and authorize
    const projectDoc = await db.doc(`projects/${projectId}`).get();
    if (!projectDoc.exists) {
      res.status(404).send("Project not found");
      return;
    }
    const project = { id: projectDoc.id, ...projectDoc.data() } as Project;

    // Authorization: only accept messages from the configured chat
    if (chatId !== project.telegramChatId) {
      res.status(403).send("Unauthorized chat");
      return;
    }

    const { cmd } = parseCommand(message.text);

    switch (cmd) {
      case "arm": {
        await db.doc(`projects/${projectId}`).update({ serverArmed: true });
        await rtdb.ref(`${projectId}/commands/armed`).set(true);
        await sendTelegram(project.telegramBotToken, chatId, "🔒 System armed");
        break;
      }
      case "disarm": {
        await db.doc(`projects/${projectId}`).update({ serverArmed: false });
        await rtdb.ref(`${projectId}/commands/armed`).set(false);
        await sendTelegram(project.telegramBotToken, chatId, "🔓 System disarmed");
        break;
      }
      case "status": {
        const info = await gatherStatus(projectId, project);
        const text = formatStatus(info);
        await sendTelegram(project.telegramBotToken, chatId, text);
        break;
      }
      case "siren_off": {
        await rtdb.ref(`${projectId}/commands/siren`).set(false);
        await sendTelegram(project.telegramBotToken, chatId, "Siren silenced");
        break;
      }
      default: {
        await sendTelegram(
          project.telegramBotToken,
          chatId,
          "Unknown command. Available: /arm /disarm /status /siren off"
        );
      }
    }

    res.status(200).send("OK");
  }
);

async function gatherStatus(projectId: string, project: Project): Promise<StatusInfo> {
  // Device armed from RTDB
  const armedSnap = await rtdb.ref(`${projectId}/state/armed`).get();
  const deviceArmed = armedSnap.val() === true;

  // Siren
  const sirenSnap = await rtdb.ref(`${projectId}/state/siren_active`).get();
  const sirenActive = sirenSnap.val() === true;

  // Profiles
  const profilesSnap = await db.collection(`projects/${projectId}/profiles`).get();
  let activeDeviceProfile: string | null = null;
  let activeServerProfile: string | null = null;
  for (const doc of profilesSnap.docs) {
    const p = doc.data() as Profile;
    if (p.isActiveOnDevice) activeDeviceProfile = p.displayName;
    if (p.isActiveOnServer) activeServerProfile = p.displayName;
  }

  // Sensors
  const sensorsSnap = await db.collection(`projects/${projectId}/sensors`).get();
  const sensors = sensorsSnap.docs.map((d) => {
    const s = d.data() as Sensor;
    return { name: s.name, lastSeen: s.lastSeen, batteryStatus: s.batteryStatus };
  });

  return {
    serverArmed: project.serverArmed,
    deviceArmed,
    sirenActive,
    activeDeviceProfile,
    activeServerProfile,
    sensors,
  };
}
