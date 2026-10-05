// Server-only, per-project notification credentials.
//
// Pushover's app token and user key identify WHO GETS WOKEN UP, so unlike the
// judge API keys in config/judge (one account's credentials, shared by every
// project) these are per-project.
//
// They still must not live on projects/{projectId}: that doc is
// `allow read: if isMember(projectId)` — ANY member — so a credential there is
// downloaded in plaintext by every member's browser. Firestore rules do not
// inherit, which is the point: this subcollection is ADMIN-ONLY while the
// parent doc stays member-readable.
//
// Admin-only since 2026-10-05, previously `if false`: the Notifications tab
// edits these directly now, so changing who gets woken no longer needs a
// service-account credential and a CLI script. The admin SDK bypasses rules
// either way, so nothing here changed for notify().
//
// A leaked Pushover token is not billable like an LLM key, but it is an alert
// channel for a SECURITY system: a spoofed "all clear", or an alert flood that
// trains the owner to ignore the channel, is the real risk.

import type { Firestore } from "firebase-admin/firestore";

export interface NotifySecrets {
  pushoverToken?: string;
  pushoverUserKey?: string;
}

export function notifySecretsPath(projectId: string): string {
  return `projects/${projectId}/secrets/notify`;
}

/**
 * Reads the per-project notification credentials. NEVER throws and never
 * rejects: a missing doc, a missing field, or a Firestore read failure all
 * resolve to an empty/partial set. The caller treats a missing credential as
 * "channel not configured" and still dispatches the other channel — a
 * credential problem must never cost an alarm notification.
 */
export async function loadNotifySecrets(
  db: Pick<Firestore, "doc">,
  projectId: string
): Promise<NotifySecrets> {
  try {
    const snap = await db.doc(notifySecretsPath(projectId)).get();
    if (!snap.exists) return {};
    const data = snap.data() ?? {};
    const out: NotifySecrets = {};
    if (typeof data.pushoverToken === "string" && data.pushoverToken.trim() !== "") {
      out.pushoverToken = data.pushoverToken;
    }
    if (
      typeof data.pushoverUserKey === "string" &&
      data.pushoverUserKey.trim() !== ""
    ) {
      out.pushoverUserKey = data.pushoverUserKey;
    }
    return out;
  } catch (e) {
    console.error(
      `loadNotifySecrets: failed to read ${notifySecretsPath(projectId)}`,
      e
    );
    return {};
  }
}
