// The notification dispatcher.
//
// Every alert in the system routes through here. It replaced nine copies of
//
//   if (!project.telegramBotToken || !project.telegramChatId) return;
//   await sendTelegram(project.telegramBotToken, project.telegramChatId, msg);
//
// spread across eight Cloud Functions. Adding a second channel to nine
// separate gates would have guaranteed drift between them.
//
// CONTRACT: notify() NEVER throws. Callers such as deviceLiveness and
// deadSensorCheck latch their alert markers only AFTER a successful send, so
// an escaping exception would silently change their retry behaviour. Each
// channel is also isolated from the other: a Telegram outage must not cost a
// Pushover alarm, and vice versa.

import type { Firestore } from "firebase-admin/firestore";
import { NotifyChannel, Project } from "./types";
import { sendTelegram } from "./telegram";
import { Severity, sendPushover } from "./pushover";
import { loadNotifySecrets } from "./notifySecrets";

export type { Severity };

// The hosted web app.
//
// ⚠️ Tapping this link on iOS opens SAFARI, not the installed PWA. An earlier
// version of this comment claimed the opposite — that the manifest's
// scope "/" + display "standalone" made an in-scope https link open the
// installed app, so no custom scheme was needed. That is WRONG, and it went
// unnoticed because nobody tapped one: scope and display govern navigation
// *within* an already-running PWA, not what a third-party app does with a
// URL. iOS has no https->installed-PWA deep-link mechanism at all (no
// equivalent of Android App Links), and Pushover opens the URL in its own
// web view / Safari.
//
// MEASURED 2026-10-05, on a real device, with the PWA backgrounded:
//   https://alarm-system-100.web.app/explore  -> Safari
//   webapp://alarm-system-100.web.app/        -> nothing happens
//   webapp://alarm-system-100.web.app/explore -> nothing happens
// The undocumented `webapp://` scheme is reported to work in 3-year-old
// forum posts; it does not work here, on this iOS version, through Pushover.
// Pushover's API accepts it (HTTP 200) — the tap is simply inert, so an
// apparent success at the send end proves nothing. Do not re-add it without
// testing the TAP on hardware.
//
// Accepted: the link lands in a browser. Telegram already renders URLs in the
// message body, so this only affects the Pushover `url` field.
export const APP_URL = "https://alarm-system-100.web.app";
// The events page: where a trigger's camera snapshots are, and so the right
// landing place for an alert link.
export const APP_EVENTS_URL = `${APP_URL}/explore`;

export interface NotifyMessage {
  // Already formatted and escaped. The formatters in telegram.ts emit only
  // <b>, which is inside Pushover's HTML subset too, so one formatted string
  // serves both channels and wording cannot drift between them.
  text: string;
  severity: Severity;
  // Pushover only; Telegram has no title concept and ignores it.
  title?: string;
  // Attach a tappable link to the PWA's events page. Pushover only: Telegram
  // already renders bare URLs in the body, and adding one to every message
  // would clutter the chat. Set it on alerts worth opening the app for.
  link?: boolean;
}

export interface NotifyDeps {
  db: Pick<Firestore, "doc">;
  loadSecrets: typeof loadNotifySecrets;
  sendTelegramFn: typeof sendTelegram;
  sendPushoverFn: typeof sendPushover;
}

/**
 * Which channels this project wants.
 *
 * ABSENT → ["telegram"]: every project predating the field keeps behaving
 * exactly as before, so this change needs no data migration.
 * EMPTY ARRAY → []: "notify me nowhere" is a legitimate choice and is NOT
 * coerced back to the default.
 */
export function resolveChannels(
  project: Pick<Project, "notifyChannels">
): NotifyChannel[] {
  return project.notifyChannels ?? ["telegram"];
}

export async function notify(
  projectId: string,
  project: Project,
  msg: NotifyMessage,
  depsOverride: Partial<NotifyDeps> = {}
): Promise<void> {
  const channels = resolveChannels(project);
  if (channels.length === 0) return;

  // ./admin is resolved LAZILY, and only when a channel actually needs
  // Firestore. Importing it at module scope initialises the Firebase app,
  // which throws "Can't determine Firebase Database URL" outside a deployed
  // environment — that is why no unit test in this codebase imports ./admin,
  // and why a top-level import here broke notify.test.ts.
  const resolveDb = async (): Promise<Pick<Firestore, "doc">> =>
    depsOverride.db ?? (await import("./admin")).db;

  const deps = {
    loadSecrets: depsOverride.loadSecrets ?? loadNotifySecrets,
    sendTelegramFn: depsOverride.sendTelegramFn ?? sendTelegram,
    sendPushoverFn: depsOverride.sendPushoverFn ?? sendPushover,
  };

  const sends: Promise<void>[] = [];

  if (channels.includes("telegram")) {
    if (project.telegramBotToken && project.telegramChatId) {
      sends.push(
        deps.sendTelegramFn(
          project.telegramBotToken,
          project.telegramChatId,
          msg.text,
          // The existing `silent` boolean already drew this exact line for
          // arm/disarm notices; severity just names it.
          msg.severity === "notice"
        )
      );
    } else {
      console.warn(`notify: project=${projectId} enables telegram but has no credentials`);
    }
  }

  if (channels.includes("pushover")) {
    // Only read the secrets doc when a channel actually needs it.
    let secrets: Awaited<ReturnType<typeof loadNotifySecrets>> = {};
    try {
      secrets = await deps.loadSecrets(await resolveDb(), projectId);
    } catch (e) {
      // loadNotifySecrets already swallows its own errors; this guards an
      // injected or future implementation that does not.
      console.error(`notify: secrets read failed for project=${projectId}`, e);
    }
    if (secrets.pushoverToken && secrets.pushoverUserKey) {
      sends.push(
        deps.sendPushoverFn({
          token: secrets.pushoverToken,
          user: secrets.pushoverUserKey,
          message: msg.text,
          severity: msg.severity,
          title: msg.title,
          url: msg.link ? APP_EVENTS_URL : undefined,
          urlTitle: msg.link ? "Open alarm system" : undefined,
          sound: project.pushoverSound,
          retrySec: project.pushoverRetrySec,
          expireSec: project.pushoverExpireSec,
        })
      );
    } else {
      console.warn(`notify: project=${projectId} enables pushover but has no credentials`);
    }
  }

  // Concurrent, and allSettled rather than all: an alarm must not wait for a
  // slow Telegram request before reaching Pushover, and neither rejection may
  // propagate out of notify().
  const results = await Promise.allSettled(sends);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`notify: a channel failed for project=${projectId}`, r.reason);
    }
  }
}
