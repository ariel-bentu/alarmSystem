# Pushover Notification Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pushover as a per-project notification channel that can replace or run alongside Telegram, so an alarm is audible on a muted iPhone.

**Architecture:** A new `notify()` dispatcher replaces nine duplicated
`telegramBotToken`/`telegramChatId` gates across eight Cloud Functions. It
reads a non-secret `notifyChannels` array from the project doc, loads
Pushover credentials from a rules-denied `projects/{id}/secrets/notify`
subcollection, and fans out to both channels concurrently with per-channel
failure isolation. A three-level `severity` maps to Telegram's existing
`silent` boolean and to Pushover's priority scale.

**Tech Stack:** TypeScript, Firebase Functions gen-2, firebase-admin,
Vitest, React + Vite (web), Firestore security rules.

**Spec:** `docs/superpowers/specs/2026-10-04-pushover-notification-channel-design.md`

## Global Constraints

- **Node 20 global `fetch`.** No HTTP client dependency is added. `telegram.ts`
  already uses bare `fetch`; `pushover.ts` must too.
- **Never throw from a notification path.** `notify`, `sendPushover`, and
  `loadNotifySecrets` log on failure and resolve. `deviceLiveness` and
  `deadSensorCheck` latch their alert markers only *after* a successful send,
  so an escaping exception would silently change retry behaviour.
- **Pushover API:** `POST https://api.pushover.net/1/messages.json`,
  `application/x-www-form-urlencoded`. Required: `token`, `user`, `message`.
  Priority 2 additionally **requires** `retry` (≥ 30 s) and `expire`
  (≤ 10800 s); Pushover rejects the message without them. Optional
  `url`/`url_title` render a tappable action — used for the PWA deep link.
- **PWA deep link:** `https://alarm-system-100.web.app/explore`. The web app's
  manifest already sets `scope: "/"` and `display: "standalone"`
  (`web/vite.config.ts`), so an in-scope https link opens the **installed
  app**, not a browser tab. No manifest change, no custom URL scheme, no App
  Store presence. `/explore` is the events page (`web/src/app/App.tsx`).
- **Pushover HTML subset:** `<b>`, `<i>`, `<u>`, `<font color>`, `<a href>`,
  enabled with `html=1`. The existing Telegram formatters emit only `<b>`
  (verified), so formatters are shared across both channels unchanged.
- **Severity mapping, exact:** `alarm` → Telegram loud, Pushover priority `2`;
  `loud` → Telegram loud, Pushover priority `1`; `notice` → Telegram
  `silent: true`, Pushover priority `-1`.
- **`notifyChannels` absent → `["telegram"]`.** An empty array means send
  nothing and must NOT be coerced to a default.
- **Secrets never in the UI, never in a transcript, never committed.** They
  enter only through `npm run set:notifyKey`.
- **i18n:** every new user-facing string goes in BOTH `web/src/i18n/en.ts` and
  `web/src/i18n/he.ts`.
- **Verification commands:** `cd functions && npx tsc --noEmit && npx vitest run`
  and `cd web && npm run lint && npm test && npm run build`.

## Testing reality in this codebase

**The eight trigger functions being modified have no unit tests.** The
established pattern, stated in `onSnapshotUploaded.test.ts`, is that decision
logic lives in pure separately-tested helpers while thin `onXxx` wrappers are
covered by emulator smoke tests (`smoke/`). Only `onSnapshotUploaded` is
unit-tested, via an injectable `SnapshotUploadDeps`.

Consequences for this plan, which must not be worked around:

1. Tasks 1–4 build `notify` and its dependencies as pure/injectable units with
   full unit tests. This is where correctness is established.
2. Tasks 5–7 are **mechanical call-site edits in untested wrapper code**,
   verified by `tsc --noEmit` and by reading the diff. Do not invent new
   unit-test harnesses for these wrappers; that is a larger refactor than this
   change, and the plan deliberately does not attempt it.
3. Task 11 covers manual end-to-end verification, which is the only thing that
   can prove the mute-defeating behaviour this change exists for.

## File Structure

| File | Responsibility |
|---|---|
| `functions/src/notifySecrets.ts` | Read Pushover credentials from the server-only subcollection. Never throws. |
| `functions/src/pushover.ts` | Pushover sender + pure priority/param helpers. |
| `functions/src/notify.ts` | The dispatcher: channel resolution, fan-out, failure isolation. |
| `functions/src/types.ts` | New `Project` fields. |
| `functions/src/onAlarm.ts` and 7 siblings | Call-site replacement. |
| `functions/scripts/setNotifyKey.ts` | Write credentials via service account. |
| `firestore.rules` | Deny client access to `projects/{id}/secrets/{id}`. |
| `web/src/features/setup/settingsForm.ts` | Pure channel-list validation. |
| `web/src/features/setup/SettingsPage.tsx` | Channel checkboxes. |
| `web/src/i18n/{en,he}.ts` | Strings. |

---

### Task 1: `loadNotifySecrets` — read the server-only credentials

**Files:**
- Create: `functions/src/notifySecrets.ts`
- Create: `functions/src/notifySecrets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface NotifySecrets { pushoverToken?: string; pushoverUserKey?: string }`
  - `function notifySecretsPath(projectId: string): string`
  - `async function loadNotifySecrets(db: Pick<Firestore, "doc">, projectId: string): Promise<NotifySecrets>`

- [ ] **Step 1: Write the failing test**

Create `functions/src/notifySecrets.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  loadNotifySecrets,
  notifySecretsPath,
  NotifySecrets,
} from "./notifySecrets";

// Minimal Firestore stand-in: only doc().get() is exercised.
// Mirrors judgeConfig.test.ts's fakeDb.
function fakeDb(doc: { exists: boolean; data?: Record<string, unknown> } | Error) {
  const get = vi.fn(async () => {
    if (doc instanceof Error) throw doc;
    return { exists: doc.exists, data: () => doc.data };
  });
  const docFn = vi.fn(() => ({ get }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { doc: docFn } as any, docFn, get };
}

describe("notifySecretsPath", () => {
  it("points at a subcollection of the project doc", () => {
    expect(notifySecretsPath("proj1")).toBe("projects/proj1/secrets/notify");
  });
});

describe("loadNotifySecrets", () => {
  it("reads the per-project secrets path", async () => {
    const { db, docFn } = fakeDb({ exists: true, data: {} });
    await loadNotifySecrets(db, "proj1");
    expect(docFn).toHaveBeenCalledWith("projects/proj1/secrets/notify");
  });

  it("returns both credentials when both are set", async () => {
    const { db } = fakeDb({
      exists: true,
      data: { pushoverToken: "atoken", pushoverUserKey: "ukey" },
    });
    expect(await loadNotifySecrets(db, "p")).toEqual({
      pushoverToken: "atoken",
      pushoverUserKey: "ukey",
    });
  });

  it("returns only the field that is present", async () => {
    const { db } = fakeDb({ exists: true, data: { pushoverToken: "atoken" } });
    expect(await loadNotifySecrets(db, "p")).toEqual({ pushoverToken: "atoken" });
  });

  it("returns an empty set when the doc does not exist", async () => {
    const { db } = fakeDb({ exists: false });
    expect(await loadNotifySecrets(db, "p")).toEqual({});
  });

  it("ignores blank and non-string values", async () => {
    const { db } = fakeDb({
      exists: true,
      data: { pushoverToken: "   ", pushoverUserKey: 42 },
    });
    expect(await loadNotifySecrets(db, "p")).toEqual({});
  });

  // A thrown read must never take down the notification path: the other
  // channel still has to fire.
  it("swallows a Firestore read failure and returns an empty set", async () => {
    const { db } = fakeDb(new Error("permission denied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadNotifySecrets(db, "p")).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx vitest run src/notifySecrets.test.ts`
Expected: FAIL — cannot resolve `./notifySecrets`.

- [ ] **Step 3: Write the implementation**

Create `functions/src/notifySecrets.ts`:

```typescript
// Server-only, per-project notification credentials.
//
// Pushover's app token and user key identify WHO GETS WOKEN UP, so unlike the
// judge API keys in config/judge (one account's credentials, shared by every
// project) these are per-project.
//
// They still must not live on projects/{projectId}: that doc is
// `allow read: if isMember(projectId)` — ANY member — so a credential there is
// downloaded in plaintext by every member's browser. Firestore rules do not
// inherit, so this subcollection is denied to all clients while the parent doc
// stays member-readable. Only the admin SDK reaches it.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/notifySecrets.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/src/notifySecrets.ts functions/src/notifySecrets.test.ts
git commit -m "feat(functions): read per-project notification secrets

Pushover credentials are per-project (they identify who gets woken), but
must stay off the member-readable project doc. Rules do not inherit, so a
secrets subcollection can be denied while the parent stays readable.

Never throws: a credential problem must not cost the other channel."
```

---

### Task 2: `pushover.ts` — the sender and its pure helpers

**Files:**
- Create: `functions/src/pushover.ts`
- Create: `functions/src/pushover.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Severity = "alarm" | "loud" | "notice"` (defined HERE, re-exported by `notify.ts`)
  - `const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json"`
  - `const DEFAULT_RETRY_SEC = 60`, `const DEFAULT_EXPIRE_SEC = 3600`
  - `function pushoverPriority(severity: Severity): number`
  - `function pushoverBody(args: { token: string; user: string; message: string; severity: Severity; title?: string; url?: string; urlTitle?: string; retrySec?: number; expireSec?: number }): URLSearchParams`
  - `async function sendPushover(args: same as pushoverBody's): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `functions/src/pushover.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pushoverPriority,
  pushoverBody,
  sendPushover,
  PUSHOVER_API_URL,
  DEFAULT_RETRY_SEC,
  DEFAULT_EXPIRE_SEC,
} from "./pushover";

describe("pushoverPriority", () => {
  // Both 1 and 2 trigger Apple Critical Alerts, so both are audible through
  // mute. Only 2 repeats until acknowledged, which is why it is reserved for
  // a genuine breach.
  it("maps alarm to emergency priority 2", () => {
    expect(pushoverPriority("alarm")).toBe(2);
  });
  it("maps loud to high priority 1", () => {
    expect(pushoverPriority("loud")).toBe(1);
  });
  it("maps notice to low priority -1", () => {
    expect(pushoverPriority("notice")).toBe(-1);
  });
});

describe("pushoverBody", () => {
  const base = { token: "t", user: "u", message: "<b>Hi</b>", severity: "loud" as const };

  it("includes the required credentials and message", () => {
    const b = pushoverBody(base);
    expect(b.get("token")).toBe("t");
    expect(b.get("user")).toBe("u");
    expect(b.get("message")).toBe("<b>Hi</b>");
  });

  it("enables the HTML subset so shared <b> formatters render", () => {
    expect(pushoverBody(base).get("html")).toBe("1");
  });

  it("omits retry and expire for non-emergency priorities", () => {
    const b = pushoverBody(base);
    expect(b.get("retry")).toBeNull();
    expect(b.get("expire")).toBeNull();
  });

  // Pushover REJECTS priority 2 without both parameters. This is the failure
  // mode worth pinning: an alarm that silently fails to send.
  it("always carries retry and expire for priority 2", () => {
    const b = pushoverBody({ ...base, severity: "alarm" });
    expect(b.get("priority")).toBe("2");
    expect(b.get("retry")).toBe(String(DEFAULT_RETRY_SEC));
    expect(b.get("expire")).toBe(String(DEFAULT_EXPIRE_SEC));
  });

  it("honours per-project retry and expire overrides", () => {
    const b = pushoverBody({ ...base, severity: "alarm", retrySec: 120, expireSec: 7200 });
    expect(b.get("retry")).toBe("120");
    expect(b.get("expire")).toBe("7200");
  });

  it("floors retry at the API minimum of 30s", () => {
    const b = pushoverBody({ ...base, severity: "alarm", retrySec: 5 });
    expect(b.get("retry")).toBe("30");
  });

  it("caps expire at the API maximum of 10800s", () => {
    const b = pushoverBody({ ...base, severity: "alarm", expireSec: 99999 });
    expect(b.get("expire")).toBe("10800");
  });

  it("includes a title when given and omits it otherwise", () => {
    expect(pushoverBody({ ...base, title: "Alarm" }).get("title")).toBe("Alarm");
    expect(pushoverBody(base).get("title")).toBeNull();
  });

  // The PWA deep link: Pushover renders url/url_title as a tappable action,
  // and because the web app's manifest has scope "/" and display
  // "standalone", an in-scope https link opens the INSTALLED app rather than
  // Safari.
  it("includes the supplementary url and its title when given", () => {
    const b = pushoverBody({
      ...base,
      url: "https://alarm-system-100.web.app/explore",
      urlTitle: "Open alarm system",
    });
    expect(b.get("url")).toBe("https://alarm-system-100.web.app/explore");
    expect(b.get("url_title")).toBe("Open alarm system");
  });

  it("omits url_title when no url is given", () => {
    const b = pushoverBody({ ...base, urlTitle: "Open alarm system" });
    expect(b.get("url")).toBeNull();
    expect(b.get("url_title")).toBeNull();
  });
});

describe("sendPushover", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs form-encoded to the Pushover messages endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 200, text: async () => "" } as Response);

    await sendPushover({ token: "t", user: "u", message: "m", severity: "loud" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PUSHOVER_API_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(String(init?.body)).toContain("token=t");
  });

  // Same contract as sendTelegram: log, never throw. Callers latch alert
  // markers after a send, so an escaping exception would change retry
  // behaviour.
  it("logs and swallows a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "application token is invalid",
    } as Response);

    await expect(
      sendPushover({ token: "t", user: "u", message: "m", severity: "alarm" })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("logs and swallows a network rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      sendPushover({ token: "t", user: "u", message: "m", severity: "loud" })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx vitest run src/pushover.test.ts`
Expected: FAIL — cannot resolve `./pushover`.

- [ ] **Step 3: Write the implementation**

Create `functions/src/pushover.ts`:

```typescript
// Pushover sender. Same shape as telegram.ts: one fetch sender plus pure,
// unit-tested helpers.
//
// WHY PUSHOVER AT ALL: a muted iPhone (the ringer switch, not Do Not Disturb)
// silences every Telegram notification, and no chat or Focus setting changes
// that — iOS only lets an app play sound through mute if it holds Apple's
// Critical Alerts entitlement, which Telegram does not have. Pushover does,
// and applies it to BOTH priority 1 and priority 2.
//
// Critical Alerts must also be opted into inside the Pushover iOS app; Apple
// requires that consent separately from normal push. Without it, priority 1
// and 2 are ordinary notifications and stay silent on mute — which looks
// exactly like a broken integration.

export type Severity = "alarm" | "loud" | "notice";

export const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

// Emergency-priority defaults. Pushover caps total retries at 50 regardless
// of expire, so 60s over an hour is well inside the cap.
export const DEFAULT_RETRY_SEC = 60;
export const DEFAULT_EXPIRE_SEC = 3600;

// API-enforced bounds for priority 2.
const MIN_RETRY_SEC = 30;
const MAX_EXPIRE_SEC = 10800;

export interface PushoverArgs {
  token: string;
  user: string;
  message: string;
  severity: Severity;
  title?: string;
  // A supplementary URL, rendered by Pushover as a tappable action on the
  // notification. Used for the PWA deep link — the web app's manifest has
  // scope "/" and display "standalone", so an in-scope https link opens the
  // INSTALLED app rather than a browser tab.
  url?: string;
  urlTitle?: string;
  retrySec?: number;
  expireSec?: number;
}

export function pushoverPriority(severity: Severity): number {
  switch (severity) {
    case "alarm":
      return 2; // Critical Alert, repeats until acknowledged.
    case "loud":
      return 1; // Critical Alert, single shot.
    case "notice":
      return -1; // Delivered with no sound or vibration.
  }
}

/**
 * Builds the form body. Pure, so the priority-2 invariant below is testable
 * without a network call.
 *
 * Priority 2 REQUIRES retry and expire — Pushover rejects the message
 * otherwise, which would mean an alarm that silently fails to send. They are
 * therefore added unconditionally whenever priority is 2, clamped to the
 * API's own bounds.
 */
export function pushoverBody(args: PushoverArgs): URLSearchParams {
  const priority = pushoverPriority(args.severity);
  const body = new URLSearchParams({
    token: args.token,
    user: args.user,
    message: args.message,
    priority: String(priority),
    // The shared formatters emit <b>, which is inside Pushover's HTML subset.
    html: "1",
  });
  if (args.title) body.set("title", args.title);
  // url_title without url is meaningless to Pushover, so it is gated on url.
  if (args.url) {
    body.set("url", args.url);
    if (args.urlTitle) body.set("url_title", args.urlTitle);
  }
  if (priority === 2) {
    const retry = Math.max(MIN_RETRY_SEC, args.retrySec ?? DEFAULT_RETRY_SEC);
    const expire = Math.min(MAX_EXPIRE_SEC, args.expireSec ?? DEFAULT_EXPIRE_SEC);
    body.set("retry", String(retry));
    body.set("expire", String(expire));
  }
  return body;
}

/**
 * Sends one Pushover message. Mirrors sendTelegram's contract exactly: logs
 * on failure and NEVER throws, so a Pushover outage cannot take down the
 * caller or prevent the Telegram channel from firing.
 */
export async function sendPushover(args: PushoverArgs): Promise<void> {
  try {
    const res = await fetch(PUSHOVER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: pushoverBody(args),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Pushover API error: ${res.status} ${text}`);
    }
  } catch (e) {
    console.error("Pushover send failed", e);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/pushover.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/src/pushover.ts functions/src/pushover.test.ts
git commit -m "feat(functions): Pushover sender

Pushover holds Apple's Critical Alerts entitlement, so priority 1 and 2
play at full volume through a muted ringer -- which no Telegram setting can
do. Priority 2 also repeats until acknowledged.

Priority 2 requires retry and expire or Pushover rejects the message, so
pushoverBody adds them unconditionally, clamped to the API bounds. Pinned
by test: a silently-unsent alarm is the failure that matters."
```

---

### Task 3: `Project` type fields

**Files:**
- Modify: `functions/src/types.ts` (the `Project` interface, after `notifyEverySensorTrigger`)

**Interfaces:**
- Consumes: `Severity` from `./pushover` (not needed here, but `NotifyChannel` is used by Task 4).
- Produces:
  - `type NotifyChannel = "telegram" | "pushover"`
  - `Project.notifyChannels?: NotifyChannel[]`
  - `Project.pushoverConfigured?: boolean`
  - `Project.pushoverRetrySec?: number`
  - `Project.pushoverExpireSec?: number`

- [ ] **Step 1: Add the type and fields**

In `functions/src/types.ts`, add above the `Project` interface:

```typescript
/**
 * A notification channel. Projects may enable either, both, or neither.
 *
 * Pushover exists because a muted iPhone silences every Telegram
 * notification; see pushover.ts.
 */
export type NotifyChannel = "telegram" | "pushover";
```

Then inside `Project`, immediately after `notifyEverySensorTrigger?: boolean;`:

```typescript
  // Which notification channels are enabled.
  //
  // ABSENT means ["telegram"] — every project predating this field keeps
  // behaving exactly as before, with no migration. An EMPTY ARRAY means send
  // nothing, which is a legitimate choice and is NOT coerced to the default.
  //
  // Not a secret, so it belongs here where the web UI can read and write it.
  // The Pushover CREDENTIALS deliberately do not live on this doc — see
  // notifySecrets.ts.
  notifyChannels?: NotifyChannel[];
  // Mirror of "a Pushover credential has been written", maintained by the
  // set:notifyKey script. Exists only so the settings UI can show whether
  // Pushover is set up: the client cannot read the secret itself.
  pushoverConfigured?: boolean;
  // Priority-2 repeat interval and give-up window, in seconds. Optional:
  // absent means pushover.ts's DEFAULT_RETRY_SEC / DEFAULT_EXPIRE_SEC. Values
  // are clamped to the API's own bounds (retry >= 30, expire <= 10800).
  pushoverRetrySec?: number;
  pushoverExpireSec?: number;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd functions && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add functions/src/types.ts
git commit -m "feat(functions): Project fields for notification channels

notifyChannels absent means [\"telegram\"], so existing projects need no
migration; an empty array means send nothing and is not coerced."
```

---

### Task 4: `notify()` — the dispatcher

**Files:**
- Create: `functions/src/notify.ts`
- Create: `functions/src/notify.test.ts`

**Interfaces:**
- Consumes: `Severity`, `sendPushover` from `./pushover`; `loadNotifySecrets`,
  `NotifySecrets` from `./notifySecrets`; `sendTelegram` from `./telegram`;
  `NotifyChannel`, `Project` from `./types`.
- Produces:
  - `interface NotifyMessage { text: string; severity: Severity; title?: string; link?: boolean }`
  - `interface NotifyDeps { loadSecrets: typeof loadNotifySecrets; sendTelegramFn: typeof sendTelegram; sendPushoverFn: typeof sendPushover; db: Pick<Firestore, "doc"> }`
  - `const APP_URL = "https://alarm-system-100.web.app"`
  - `const APP_EVENTS_URL = `${APP_URL}/explore``
  - `function resolveChannels(project: Pick<Project, "notifyChannels">): NotifyChannel[]`
  - `async function notify(projectId: string, project: Project, msg: NotifyMessage, deps?: Partial<NotifyDeps>): Promise<void>`
  - re-export `Severity`

Note the `deps` parameter: it exists so this task's tests can inject fakes
without `vi.mock`, matching the injectable-deps pattern
`onSnapshotUploaded` established. Every call site in Tasks 5–7 omits it.

- [ ] **Step 1: Write the failing test**

Create `functions/src/notify.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notify, resolveChannels, NotifyMessage, APP_EVENTS_URL } from "./notify";
import type { Project } from "./types";

function project(over: Partial<Project> = {}): Project {
  // Only the fields notify() reads matter; the rest of Project is irrelevant
  // here, hence the cast.
  return {
    telegramBotToken: "bot",
    telegramChatId: "chat",
    ...over,
  } as Project;
}

function deps(secrets: Record<string, string> = {}) {
  return {
    db: {} as never,
    loadSecrets: vi.fn(async () => secrets),
    sendTelegramFn: vi.fn(async () => {}),
    sendPushoverFn: vi.fn(async () => {}),
  };
}

const bothSecrets = { pushoverToken: "ptok", pushoverUserKey: "pkey" };
const msg: NotifyMessage = { text: "hello", severity: "loud" };

describe("resolveChannels", () => {
  // The no-migration guarantee: every project predating the field keeps
  // behaving exactly as it did.
  it("defaults to telegram only when the field is absent", () => {
    expect(resolveChannels({})).toEqual(["telegram"]);
  });

  // An explicit empty array is a real choice ("notify me nowhere") and must
  // not be silently turned back into the default.
  it("returns nothing for an explicit empty array", () => {
    expect(resolveChannels({ notifyChannels: [] })).toEqual([]);
  });

  it("returns pushover only", () => {
    expect(resolveChannels({ notifyChannels: ["pushover"] })).toEqual(["pushover"]);
  });

  it("returns both when both are enabled", () => {
    expect(resolveChannels({ notifyChannels: ["telegram", "pushover"] })).toEqual([
      "telegram",
      "pushover",
    ]);
  });
});

describe("notify", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends Telegram only by default", async () => {
    const d = deps(bothSecrets);
    await notify("p", project(), msg, d);
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
  });

  it("sends nothing when the channel list is empty", async () => {
    const d = deps(bothSecrets);
    await notify("p", project({ notifyChannels: [] }), msg, d);
    expect(d.sendTelegramFn).not.toHaveBeenCalled();
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
  });

  it("sends both when both channels are enabled", async () => {
    const d = deps(bothSecrets);
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
    expect(d.sendPushoverFn).toHaveBeenCalledTimes(1);
  });

  it("passes the message text and credentials through to Telegram", async () => {
    const d = deps();
    await notify("p", project(), { text: "<b>Boom</b>", severity: "loud" }, d);
    expect(d.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "<b>Boom</b>", false);
  });

  // The severity model is a faithful generalisation of the `silent` boolean
  // the code already used for arm/disarm notices.
  it("marks only notices silent on Telegram", async () => {
    const d = deps();
    await notify("p", project(), { text: "t", severity: "notice" }, d);
    expect(d.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "t", true);

    const d2 = deps();
    await notify("p", project(), { text: "t", severity: "alarm" }, d2);
    expect(d2.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "t", false);
  });

  it("passes severity and credentials through to Pushover", async () => {
    const d = deps(bothSecrets);
    await notify(
      "p",
      project({ notifyChannels: ["pushover"], pushoverRetrySec: 90, pushoverExpireSec: 600 }),
      { text: "t", severity: "alarm", title: "Alarm" },
      d
    );
    expect(d.sendPushoverFn).toHaveBeenCalledWith({
      token: "ptok",
      user: "pkey",
      message: "t",
      severity: "alarm",
      title: "Alarm",
      url: undefined,
      urlTitle: undefined,
      retrySec: 90,
      expireSec: 600,
    });
  });

  // The deep link: tapping the notification opens the installed PWA on the
  // events page, where the camera snapshots for the trigger are.
  it("attaches the PWA events link when link is set", async () => {
    const d = deps(bothSecrets);
    await notify(
      "p",
      project({ notifyChannels: ["pushover"] }),
      { text: "t", severity: "alarm", link: true },
      d
    );
    const call = d.sendPushoverFn.mock.calls[0][0];
    expect(call.url).toBe(APP_EVENTS_URL);
    expect(call.urlTitle).toBe("Open alarm system");
  });

  it("omits the link when not requested", async () => {
    const d = deps(bothSecrets);
    await notify("p", project({ notifyChannels: ["pushover"] }), msg, d);
    expect(d.sendPushoverFn.mock.calls[0][0].url).toBeUndefined();
  });

  // Telegram messages are unaffected: the link is a Pushover notification
  // action, and Telegram already renders bare URLs in the message body.
  it("does not alter the Telegram text when link is set", async () => {
    const d = deps();
    await notify("p", project(), { text: "t", severity: "alarm", link: true }, d);
    expect(d.sendTelegramFn).toHaveBeenCalledWith("bot", "chat", "t", false);
  });

  it("skips Telegram when its credentials are missing", async () => {
    const d = deps(bothSecrets);
    await notify(
      "p",
      project({ notifyChannels: ["telegram"], telegramBotToken: "", telegramChatId: "" }),
      msg,
      d
    );
    expect(d.sendTelegramFn).not.toHaveBeenCalled();
  });

  it("skips Pushover when its credentials are missing but still sends Telegram", async () => {
    const d = deps({}); // no secrets written yet
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
  });

  it("skips Pushover when only one of the two credentials is present", async () => {
    const d = deps({ pushoverToken: "ptok" });
    await notify("p", project({ notifyChannels: ["pushover"] }), msg, d);
    expect(d.sendPushoverFn).not.toHaveBeenCalled();
  });

  // Failure isolation is the core contract: one channel must never be able to
  // suppress the other.
  it("still sends Pushover when Telegram throws", async () => {
    const d = deps(bothSecrets);
    d.sendTelegramFn.mockRejectedValue(new Error("telegram down"));
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendPushoverFn).toHaveBeenCalledTimes(1);
  });

  it("still sends Telegram when Pushover throws", async () => {
    const d = deps(bothSecrets);
    d.sendPushoverFn.mockRejectedValue(new Error("pushover down"));
    await notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d);
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
  });

  // Callers (deviceLiveness, deadSensorCheck) latch their alert markers only
  // after notify() resolves. If notify threw, that latch would be skipped and
  // retry behaviour would change silently.
  it("never rejects, even when both channels throw", async () => {
    const d = deps(bothSecrets);
    d.sendTelegramFn.mockRejectedValue(new Error("x"));
    d.sendPushoverFn.mockRejectedValue(new Error("y"));
    await expect(
      notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d)
    ).resolves.toBeUndefined();
  });

  it("never rejects when the secrets read throws", async () => {
    const d = deps();
    d.loadSecrets.mockRejectedValue(new Error("permission denied"));
    await expect(
      notify("p", project({ notifyChannels: ["telegram", "pushover"] }), msg, d)
    ).resolves.toBeUndefined();
    // Telegram is unaffected by a Pushover-credential failure.
    expect(d.sendTelegramFn).toHaveBeenCalledTimes(1);
  });

  // No point paying a Firestore read when no channel needs it.
  it("does not read secrets when Pushover is not enabled", async () => {
    const d = deps();
    await notify("p", project({ notifyChannels: ["telegram"] }), msg, d);
    expect(d.loadSecrets).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx vitest run src/notify.test.ts`
Expected: FAIL — cannot resolve `./notify`.

- [ ] **Step 3: Write the implementation**

Create `functions/src/notify.ts`:

```typescript
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
import { db as defaultDb } from "./admin";
import { NotifyChannel, Project } from "./types";
import { sendTelegram } from "./telegram";
import { Severity, sendPushover } from "./pushover";
import { loadNotifySecrets } from "./notifySecrets";

export type { Severity };

// The hosted web app. Its PWA manifest declares scope "/" and display
// "standalone", so an in-scope https link opens the INSTALLED app rather than
// a browser tab — which is why no custom URL scheme or App Store presence is
// needed to deep-link into it.
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
  const deps: NotifyDeps = {
    db: defaultDb,
    loadSecrets: loadNotifySecrets,
    sendTelegramFn: sendTelegram,
    sendPushoverFn: sendPushover,
    ...depsOverride,
  };

  const channels = resolveChannels(project);
  if (channels.length === 0) return;

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
      secrets = await deps.loadSecrets(deps.db, projectId);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx vitest run src/notify.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add functions/src/notify.ts functions/src/notify.test.ts
git commit -m "feat(functions): notify() dispatcher for multi-channel alerts

Replaces nine duplicated token-and-chatId gates with one seam. Channels
dispatch concurrently via allSettled with per-channel failure isolation:
a Telegram outage must not cost a Pushover alarm, or vice versa.

notify() never throws -- deviceLiveness and deadSensorCheck latch their
alert markers only after a successful send."
```

---

### Task 5: Route the three arm/disarm notices through `notify`

These three are grouped because they are the identical edit — each passes
`silent: true` today and becomes `severity: "notice"`. A reviewer would
accept or reject all three together.

**Files:**
- Modify: `functions/src/onArmStateChange.ts:85-94`
- Modify: `functions/src/onDeviceArmStateChange.ts:122-129`
- Modify: `functions/src/onServerArmChange.ts:53-60`

**Interfaces:**
- Consumes: `notify` from `./notify` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Edit `onArmStateChange.ts`**

Replace the import of `sendTelegram`:

```typescript
import { formatArmState, armSourceLabel } from "./telegram";
import { notify } from "./notify";
```

Replace lines 85–94 (the gate and the send) with:

```typescript
    await notify(projectId, project, {
      // The source, not a hardcoded "Device": a scheduled arm read "Device
      // armed — Night", which is the same conflation the timeline had.
      text: formatArmState(armed, armSourceLabel(armSource), profileName),
      severity: "notice", // arm/disarm is a notice, not a demand for attention
    });
```

Delete the now-dead `if (!project.telegramBotToken || !project.telegramChatId) return;`
line that preceded it. If `projectId` is not already in scope under that name,
use whatever the surrounding function calls it — do not introduce a new variable.

- [ ] **Step 2: Edit `onDeviceArmStateChange.ts`**

Replace the import:

```typescript
import { formatArmStateBySource } from "./telegram";
import { notify } from "./notify";
```

Replace lines 122–129 with:

```typescript
    await notify(projectId, project, {
      text: formatArmStateBySource(armed, source, remoteName),
      severity: "notice", // arm/disarm is a notice, not a demand for attention
    });
```

Delete the preceding credential gate.

- [ ] **Step 3: Edit `onServerArmChange.ts`**

This one reads the project from a variable named `after`, not `project`.

Replace the import:

```typescript
import { formatArmState } from "./telegram";
import { notify } from "./notify";
```

Replace lines 53–60 with:

```typescript
    await notify(projectId, after, {
      text: formatArmState(armed, "Server", profileName),
      severity: "notice", // see onArmStateChange
    });
```

Delete the preceding `if (!after.telegramBotToken || !after.telegramChatId) return;`.
Confirm `projectId` is in scope; if the handler derives it from
`event.params.projectId`, use that expression.

- [ ] **Step 4: Verify it compiles and nothing regressed**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all suites pass.

- [ ] **Step 5: Confirm no `sendTelegram` call remains in these three files**

Run: `cd functions && grep -n "sendTelegram" src/onArmStateChange.ts src/onDeviceArmStateChange.ts src/onServerArmChange.ts`
Expected: NO output.

- [ ] **Step 6: Commit**

```bash
git add functions/src/onArmStateChange.ts functions/src/onDeviceArmStateChange.ts \
        functions/src/onServerArmChange.ts
git commit -m "refactor(functions): route arm/disarm notices through notify()

All three passed silent: true, which severity \"notice\" now names."
```

---

### Task 6: Route the alarm and sensor paths through `notify`

**Files:**
- Modify: `functions/src/onAlarm.ts:58-62`
- Modify: `functions/src/onSensorEvent.ts:154-159` and `:279-288`

**Interfaces:**
- Consumes: `notify` from `./notify` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Edit `onAlarm.ts`**

Replace the import:

```typescript
import { formatAlarm } from "./telegram";
import { notify } from "./notify";
```

Replace lines 58–62:

```typescript
    await notify(projectId, project, {
      text: label ? formatAlarm(label) : "🚨 Alarm triggered!",
      severity: "alarm",
      title: "Alarm",
      link: true, // tapping opens the PWA on the events page
    });
```

Delete the preceding `if (!project.telegramBotToken || !project.telegramChatId) return;`.

**Careful:** that `return` also guarded nothing else — the timeline write
above it already happened. Removing the early return is correct and
intentional, but confirm no code after the send depends on having returned.

- [ ] **Step 2: Edit `onSensorEvent.ts`, first site (sensor alert)**

The existing condition mixes notification *policy* with *credentials*. Keep
the policy, drop only the credential half — `notify` owns credentials now.

Replace lines 154–159 (the `if` and its body) with:

```typescript
    if (
      policy.notify &&
      !alreadyAlerted &&
      (project.notifyEverySensorTrigger !== false || alwaysNotify)
    ) {
      await notify(projectId, project, {
        text: formatSensorAlert(sensor.name, eventType),
        severity: "loud",
        link: true,
      });
    }
```

- [ ] **Step 3: Edit `onSensorEvent.ts`, second site (server-evaluated alarm)**

`serverActions.sendTelegram` is a **separate pre-existing project toggle** and
must be preserved exactly. Despite its name it means "notify when the siren is
suppressed"; do not fold it into `notifyChannels`.

Replace lines 279–288 with:

```typescript
      } else if (
        // Siren suppressed, so onAlarm never runs — send the alarm
        // notification directly instead. These two toggles are
        // independent, so notify-without-siren must still fire.
        project.serverActions.sendTelegram
      ) {
        await notify(projectId, project, {
          text: formatAlarm(label),
          severity: "alarm",
          title: "Alarm",
          link: true,
        });
      }
```

Then fix the imports at the top of the file:

```typescript
import { formatSensorAlert, formatAlarm } from "./telegram";
import { notify } from "./notify";
```

- [ ] **Step 4: Verify it compiles and nothing regressed**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all suites pass.

- [ ] **Step 5: Confirm the credential gates are gone**

Run: `cd functions && grep -n "sendTelegram\|telegramBotToken" src/onAlarm.ts src/onSensorEvent.ts`
Expected: exactly ONE line — `project.serverActions.sendTelegram` in
`onSensorEvent.ts`. No `telegramBotToken`, no `sendTelegram(` call.

- [ ] **Step 6: Commit**

```bash
git add functions/src/onAlarm.ts functions/src/onSensorEvent.ts
git commit -m "refactor(functions): route alarm and sensor alerts through notify()

Alarms get severity \"alarm\" (Pushover priority 2, repeats until
acknowledged); sensor alerts get \"loud\" (priority 1, audible through mute,
single shot).

serverActions.sendTelegram is preserved: despite the name it means \"notify
when the siren is suppressed\" and is independent of notifyChannels."
```

---

### Task 7: Route the scheduled checks and the snapshot breach through `notify`

**Files:**
- Modify: `functions/src/deviceLiveness.ts:36, 62-66, 89-93`
- Modify: `functions/src/deadSensorCheck.ts:63, 89-93, 115`
- Modify: `functions/src/onSnapshotUploaded.ts:294-303`

**Interfaces:**
- Consumes: `notify` from `./notify` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Edit `deviceLiveness.ts`**

Replace the import of `sendTelegram` (keep the formatters):

```typescript
import { formatDeviceOffline, formatDeviceBackOnline } from "./telegram";
import { notify } from "./notify";
```

Delete the per-project credential gate at line 36
(`if (!project.telegramBotToken || !project.telegramChatId) continue;`) — the
loop must now continue to projects that use Pushover only.

Replace the offline send (lines 62–66):

```typescript
        await notify(project.id, project, {
          text: formatDeviceOffline(silence, armed),
          severity: "loud",
          title: "Device offline",
        });
```

Replace the back-online send (lines 89–93):

```typescript
        await notify(project.id, project, {
          // A recovery message is informational. Under the Pushover mapping a
          // "loud" severity would fire a Critical Alert through a muted phone
          // to say everything is fine, so this is deliberately a notice.
          text: formatDeviceBackOnline(outage),
          severity: "notice",
        });
```

Confirm the project variable exposes `id`; if the loop uses
`projectDoc.id` instead, pass that.

**Preserve the latch ordering.** The `projectDoc.ref.update(...)` calls that
follow each send must stay AFTER it, so a channel outage retries next minute.

- [ ] **Step 2: Edit `deadSensorCheck.ts`**

Replace the import:

```typescript
import { formatDeadSensor, formatStaleBattery } from "./telegram";
import { notify } from "./notify";
```

Delete the credential gate at line 63 (`continue`), same reasoning as above.

Replace the stale-battery send (lines 89–93):

```typescript
          await notify(project.id, project, {
            text: formatStaleBattery(sensor.name, months),
            severity: "loud",
            title: "Battery",
          });
```

Replace the dead-sensor send (line 115):

```typescript
        await notify(project.id, project, {
          text: msg,
          severity: "loud",
          title: "Dead sensor",
        });
```

**Preserve the latch ordering** for both: the `sensorDoc.ref.update(...)`
calls stay after their send.

- [ ] **Step 3: Edit `onSnapshotUploaded.ts`**

The breach **photo** keeps going through `sendTelegramPhoto` — Pushover image
attachments are deliberately out of scope for this change. Add a text-only
Pushover-capable alert alongside it so a Pushover-only project still gets
woken by a confirmed breach.

Keep the existing `sendTelegramPhoto` import and add:

```typescript
import { notify } from "./notify";
```

At lines 294–303, keep the photo path's own credential check (it needs
`telegramBotToken` specifically) but add the `notify` call before it, outside
that gate:

```typescript
    // Routed through notify so a Pushover-only project is woken by a
    // confirmed breach. The PHOTO below stays Telegram-only: Pushover
    // attachments are out of scope for this change.
    await notify(projectId, project, {
      text: caption,
      severity: "alarm",
      title: "Breach",
      link: true, // the snapshots this breach was judged on are on that page
    });

    if (!project.telegramBotToken || !project.telegramChatId) {
      // existing log line stays as-is
      return;
    }
    await sendTelegramPhoto(project.telegramBotToken, project.telegramChatId, jpeg, caption);
```

Note this means a Telegram-enabled project receives both a text message and a
captioned photo for one breach. That is accepted: the duplicate is a cheap
price for a channel-independent alert, and a 3am breach is exactly when
redundancy is wanted.

`onSnapshotUploaded` is unit-tested with injectable deps, so its existing
test file will need `notify` mocked. Add to the top of
`functions/src/onSnapshotUploaded.test.ts`:

```typescript
vi.mock("./notify", () => ({ notify: vi.fn(async () => {}) }));
```

- [ ] **Step 4: Verify it compiles and nothing regressed**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all suites pass, including `onSnapshotUploaded.test.ts`.

- [ ] **Step 5: Confirm every credential gate is gone repo-wide**

Run: `cd functions && grep -rn "telegramBotToken" src/*.ts | grep -v test`
Expected: exactly TWO lines, both in `onSnapshotUploaded.ts` (the photo path's
own gate). Nothing in `onAlarm`, `onSensorEvent`, `deviceLiveness`,
`deadSensorCheck`, `onArmStateChange`, `onDeviceArmStateChange`,
`onServerArmChange`.

Run: `cd functions && grep -rn "sendTelegram(" src/*.ts | grep -v test`
Expected: only the definition inside `src/telegram.ts`.

- [ ] **Step 6: Commit**

```bash
git add functions/src/deviceLiveness.ts functions/src/deadSensorCheck.ts \
        functions/src/onSnapshotUploaded.ts functions/src/onSnapshotUploaded.test.ts
git commit -m "refactor(functions): route liveness, dead-sensor and breach through notify()

Removes the per-project credential gates that made the scheduled loops skip
projects using Pushover only.

device-back-online is reclassified loud -> notice: under the Pushover
mapping, loud would fire a Critical Alert through a muted phone to report
that everything is fine.

Breach keeps its Telegram photo and gains a channel-independent text alert;
Pushover attachments are out of scope."
```

---

### Task 8: Firestore rules — deny the secrets subcollection

**Files:**
- Modify: `firestore.rules` (inside the `match /projects/{projectId}` block)

**Interfaces:**
- Consumes: nothing.
- Produces: the deployed rule Task 9's script depends on.

- [ ] **Step 1: Add the rule**

Inside `match /projects/{projectId} { ... }`, alongside the other
subcollection matches (`members`, `sensors`, …), add:

```
      // Server-only per-project secrets: the Pushover app token and user key.
      // No client may read or write these, ever — Cloud Functions reach them
      // through the admin SDK, which bypasses these rules entirely.
      //
      // Rules do NOT inherit, which is the whole point: the parent project
      // doc stays `allow read: if isMember(projectId)` while this
      // subcollection is denied outright. A credential on the parent doc
      // would be downloaded in plaintext by every member's browser.
      match /secrets/{secretId} {
        allow read, write: if false;
      }
```

- [ ] **Step 2: Verify the rules compile**

Run: `npx firebase deploy --only firestore:rules --dry-run`
Expected: rules compile. If `--dry-run` is unsupported by the installed CLI
version, run `npx firebase firestore:rules:check firestore.rules` or simply
confirm no syntax error at deploy time in Task 11.

- [ ] **Step 3: Commit**

```bash
git add firestore.rules
git commit -m "feat(rules): deny client access to projects/{id}/secrets

Rules do not inherit, so the parent project doc stays member-readable while
the Pushover credentials beside it are unreachable by any client."
```

---

### Task 9: `set:notifyKey` script

**Files:**
- Create: `functions/scripts/setNotifyKey.ts`
- Modify: `functions/package.json` (the `scripts` block)

**Interfaces:**
- Consumes: `notifySecretsPath` from `../src/notifySecrets` (Task 1).
- Produces: the `npm run set:notifyKey` entry point.

- [ ] **Step 1: Write the script**

Create `functions/scripts/setNotifyKey.ts`, modelled on `setJudgeKey.ts`:

```typescript
#!/usr/bin/env npx tsx
//
// Writes a project's Pushover credentials into the server-only
// projects/{projectId}/secrets/notify document.
//
// That subcollection is locked to `allow read, write: if false` in
// firestore.rules — no client can read it, only Cloud Functions through the
// admin SDK. This script uses a service-account credential, which bypasses
// rules the same way.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json \
//     npm run set:notifyKey -- <projectId> <appToken> <userKey>
//   GOOGLE_APPLICATION_CREDENTIALS=... npm run set:notifyKey -- --show <projectId>
//
// Credentials are never echoed back, only masked. Get the app token by
// creating an application at https://pushover.net/apps/build; the user key is
// on the Pushover dashboard.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { notifySecretsPath } from "../src/notifySecrets";

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

function mask(k: string): string {
  return k.length <= 8 ? "****" : `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`;
}

async function main() {
  const db = getFirestore();
  const args = process.argv.slice(2);

  if (args[0] === "--show") {
    const projectId = args[1];
    if (!projectId) {
      console.error("Usage: npm run set:notifyKey -- --show <projectId>");
      process.exit(2);
    }
    const snap = await db.doc(notifySecretsPath(projectId)).get();
    if (!snap.exists) {
      console.log(`${notifySecretsPath(projectId)} does not exist — Pushover not configured.`);
      return;
    }
    const data = snap.data() ?? {};
    for (const field of ["pushoverToken", "pushoverUserKey"]) {
      const v = data[field];
      console.log(
        `${field.padEnd(18)} ${typeof v === "string" && v ? mask(v) : "(not set)"}`
      );
    }
    return;
  }

  const [projectId, appToken, userKey] = args;
  if (!projectId || !appToken || !userKey) {
    console.error(
      "Usage: npm run set:notifyKey -- <projectId> <appToken> <userKey>"
    );
    process.exit(2);
  }

  // Pushover tokens and user keys are both 30 chars. Catch a swapped or
  // truncated paste before it becomes a silent 400 at alarm time.
  for (const [label, value] of [
    ["appToken", appToken],
    ["userKey", userKey],
  ] as const) {
    if (value.length !== 30) {
      console.warn(
        `warning: ${label} is ${value.length} chars; Pushover credentials are normally 30.`
      );
    }
  }

  const projectRef = db.doc(`projects/${projectId}`);
  if (!(await projectRef.get()).exists) {
    console.error(`No such project: projects/${projectId}`);
    process.exit(2);
  }

  await db
    .doc(notifySecretsPath(projectId))
    .set({ pushoverToken: appToken, pushoverUserKey: userKey }, { merge: true });
  // Non-secret mirror so the settings UI can show "configured" without
  // reading the secret, which no client is allowed to do.
  await projectRef.set({ pushoverConfigured: true }, { merge: true });

  console.log(`${notifySecretsPath(projectId)}`);
  console.log(`  pushoverToken    = ${mask(appToken)}  ✓ written`);
  console.log(`  pushoverUserKey  = ${mask(userKey)}  ✓ written`);
  console.log(`projects/${projectId}.pushoverConfigured = true  ✓ written`);
  console.log(
    "\nNext: enable Pushover in the project's Settings page, then opt into\n" +
      "Critical Alerts inside the Pushover iOS app — Apple requires that\n" +
      "consent separately, and without it priority 1 and 2 stay SILENT on mute."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Register the npm script**

In `functions/package.json`, add to `scripts`, after `set:judgeKey`:

```json
    "set:notifyKey": "tsx scripts/setNotifyKey.ts",
```

- [ ] **Step 3: Verify it typechecks and the usage path works**

Run: `cd functions && npx tsc --noEmit`
Expected: no errors.

Run: `cd functions && npm run set:notifyKey` (no `GOOGLE_APPLICATION_CREDENTIALS`)
Expected: exits 2 with the "Set GOOGLE_APPLICATION_CREDENTIALS" message. This
confirms the entry point resolves without touching Firestore.

- [ ] **Step 4: Commit**

```bash
git add functions/scripts/setNotifyKey.ts functions/package.json
git commit -m "feat(functions): set:notifyKey script for Pushover credentials

Service-account write to the rules-denied secrets subcollection. Keys are
masked on output and never echoed. Also sets the non-secret
pushoverConfigured mirror so the UI can show state without reading the
secret."
```

---

### Task 10: Web UI — channel selection

**Files:**
- Modify: `web/src/types/index.ts` (mirror the `Project` fields)
- Modify: `web/src/features/setup/settingsForm.ts`
- Modify: `web/src/features/setup/settingsForm.test.ts`
- Modify: `web/src/features/setup/SettingsPage.tsx`
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/he.ts`

**Interfaces:**
- Consumes: the `Project` shape from Task 3 (mirrored, not imported — the web
  app keeps its own copy in `web/src/types/index.ts`).
- Produces: `function normalizeNotifyChannels(input: unknown): NotifyChannel[]`

- [ ] **Step 1: Read the existing form module before editing**

Run: `cd web && sed -n 1,80p src/features/setup/settingsForm.ts`

Follow its existing conventions for validation shape and naming. Do not
restructure it.

- [ ] **Step 2: Write the failing test**

Append to `web/src/features/setup/settingsForm.test.ts` (keep the file's
existing import style):

```typescript
describe("normalizeNotifyChannels", () => {
  // Absent must stay absent-equivalent: the server treats undefined as
  // ["telegram"], and writing an explicit default here would mean every saved
  // settings form silently migrated projects.
  it("defaults to telegram when nothing is selected in a legacy project", () => {
    expect(normalizeNotifyChannels(undefined)).toEqual(["telegram"]);
  });

  it("keeps an explicit empty selection empty", () => {
    expect(normalizeNotifyChannels([])).toEqual([]);
  });

  it("passes through a valid pair in a stable order", () => {
    expect(normalizeNotifyChannels(["pushover", "telegram"])).toEqual([
      "telegram",
      "pushover",
    ]);
  });

  it("drops unknown channel names", () => {
    expect(normalizeNotifyChannels(["telegram", "sms"])).toEqual(["telegram"]);
  });

  it("de-duplicates repeated channels", () => {
    expect(normalizeNotifyChannels(["telegram", "telegram"])).toEqual(["telegram"]);
  });

  it("returns the default for a non-array value", () => {
    expect(normalizeNotifyChannels("telegram")).toEqual(["telegram"]);
  });
});
```

Add `normalizeNotifyChannels` to the file's existing import from
`./settingsForm`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd web && npx vitest run src/features/setup/settingsForm.test.ts`
Expected: FAIL — `normalizeNotifyChannels` is not exported.

- [ ] **Step 4: Implement it**

Add to `web/src/features/setup/settingsForm.ts`:

```typescript
export type NotifyChannel = "telegram" | "pushover";

const ALL_CHANNELS: NotifyChannel[] = ["telegram", "pushover"];

/**
 * Normalises the channel list read from a project doc or a form.
 *
 * `undefined` (and any non-array) yields ["telegram"], matching the server's
 * absent-means-telegram rule. An explicit empty array is preserved: "notify
 * me nowhere" is a real choice.
 *
 * Output order is always ALL_CHANNELS order, so a saved doc does not churn
 * just because the user ticked the boxes in a different sequence.
 */
export function normalizeNotifyChannels(input: unknown): NotifyChannel[] {
  if (!Array.isArray(input)) return ["telegram"];
  const seen = new Set(input);
  return ALL_CHANNELS.filter((c) => seen.has(c));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run src/features/setup/settingsForm.test.ts`
Expected: PASS.

- [ ] **Step 6: Mirror the type fields**

In `web/src/types/index.ts`, add to the `Project` interface (match the file's
existing comment style):

```typescript
  notifyChannels?: ("telegram" | "pushover")[];
  // Read-only mirror maintained by the set:notifyKey script. The credentials
  // themselves live in a server-only subcollection no client may read.
  pushoverConfigured?: boolean;
```

- [ ] **Step 7: Add the i18n strings to BOTH locales**

**These files use FLAT DOTTED KEYS**, not nested objects — e.g. the existing
`"settings.telegramBotToken": "Telegram Bot Token"`. Follow that exactly.

In `web/src/i18n/en.ts`, beside the other `settings.*` keys:

```typescript
  "settings.notifyChannels": "Notification channels",
  "settings.channelTelegram": "Telegram",
  "settings.channelPushover": "Pushover",
  "settings.pushoverNotConfigured":
    "No Pushover credentials set. Run: npm run set:notifyKey -- <projectId> <appToken> <userKey>",
  "settings.pushoverConfigured": "Pushover credentials are set",
  "settings.pushoverCriticalAlertsHint":
    "Pushover plays through a muted ringer only after you enable Critical Alerts inside the Pushover app.",
```

In `web/src/i18n/he.ts`, the identical key strings with Hebrew values:

```typescript
  "settings.notifyChannels": "ערוצי התראה",
  "settings.channelTelegram": "טלגרם",
  "settings.channelPushover": "Pushover",
  "settings.pushoverNotConfigured":
    "לא הוגדרו פרטי Pushover. הרץ: npm run set:notifyKey -- <projectId> <appToken> <userKey>",
  "settings.pushoverConfigured": "פרטי Pushover מוגדרים",
  "settings.pushoverCriticalAlertsHint":
    "Pushover ישמיע בצליל גם במצב שקט רק לאחר הפעלת Critical Alerts באפליקציית Pushover.",
```

Verify both locales carry the same key set — if the project has a test
asserting locale parity, it will catch a mismatch; otherwise compare with
`cd web && grep -c '"settings\.' src/i18n/en.ts src/i18n/he.ts`.

- [ ] **Step 8: Add the checkboxes to `SettingsPage.tsx`**

Read the surrounding form first (`cd web && grep -n "telegramBotToken" src/features/setup/SettingsPage.tsx`)
and follow its existing control markup, state handling, and save path. Add a
"Notification channels" group with two checkboxes bound to
`notifyChannels`, defaulting via `normalizeNotifyChannels(project.notifyChannels)`.

When `pushover` is ticked and `project.pushoverConfigured` is not true, show
`pushoverNotConfigured` as a warning. Always show
`pushoverCriticalAlertsHint` beneath the Pushover checkbox when it is ticked —
the on-phone opt-in is the single most likely reason a user concludes this
feature is broken.

Do NOT add any input for the Pushover token or user key. They are server-only.

- [ ] **Step 9: Verify the web app**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: lint clean, all tests pass, build succeeds.

- [ ] **Step 10: Commit**

```bash
git add web/src/types/index.ts web/src/features/setup/settingsForm.ts \
        web/src/features/setup/settingsForm.test.ts \
        web/src/features/setup/SettingsPage.tsx web/src/i18n/en.ts web/src/i18n/he.ts
git commit -m "feat(web): notification channel selection in Settings

Checkboxes write notifyChannels; an explicit empty selection is preserved.
No credential inputs: Pushover keys are server-only, so the page shows only
whether they are configured, plus the Critical Alerts opt-in hint -- the
most likely reason a user thinks the feature is broken."
```

---

### Task 11: Documentation, deploy, and end-to-end verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `SECURITY.md`
- Modify: `todo.txt`

**Interfaces:**
- Consumes: everything above.
- Produces: a verified deployment.

- [ ] **Step 1: Document the feature in `CLAUDE.md`**

Add a status section in the established style, and update the Firestore
layout block to include `projects/{projectId}/secrets/notify`:

```markdown
**Pushover notification channel (2026-10-04) — built, NOT verified on a muted phone.**
A muted iPhone (ringer switch, not DND) silences every Telegram
notification; only an app holding Apple's Critical Alerts entitlement can
play through it. Pushover has that entitlement and applies it to priority 1
and 2, so it is now a per-project channel alongside Telegram.

`notifyChannels?: ("telegram"|"pushover")[]` on `projects/{projectId}` —
**absent means `["telegram"]`** (no migration needed); an **empty array means
send nothing** and is deliberately not coerced. Credentials live in
`projects/{projectId}/secrets/notify`, a subcollection locked to
`allow read, write: if false` — per-project because they identify who gets
woken, but off the member-readable project doc. Set them with
`cd functions && npm run set:notifyKey -- <projectId> <appToken> <userKey>`.

All nine former `sendTelegram` call sites now route through `notify()`
(`functions/src/notify.ts`), which fans out concurrently with per-channel
failure isolation and **never throws** — `deviceLiveness` and
`deadSensorCheck` latch their alert markers only after a successful send.
Severity maps `alarm`→priority 2 (repeats until acknowledged), `loud`→1,
`notice`→-1; the Telegram half reuses the pre-existing `silent` boolean.
`device back online` was reclassified loud→notice, since loud would fire a
Critical Alert through a muted phone to say everything is fine.

⚠️ **Critical Alerts must be opted into inside the Pushover iOS app** —
Apple requires that consent separately from normal push. Without it,
priority 1 and 2 are ordinary notifications and stay silent on mute, which
is indistinguishable from a broken integration.

Alarm, breach and sensor-alert messages carry `link: true`, which adds
Pushover's `url`/`url_title` pointing at `/explore`. Because the PWA manifest
declares `scope: "/"` and `display: "standalone"`, tapping it opens the
**installed app**, not Safari — no custom URL scheme and no App Store
presence needed. The link is Pushover-only; Telegram already renders URLs in
the message body.

Deliberately out of scope: Pushover image attachments (the breach photo
stays Telegram-only; a text alert goes to both), the `device` parameter
(omitted so all the owner's devices alert), acknowledgement callbacks, and
deep-linking to a SPECIFIC event — `/explore` reads no query parameter today,
so the link lands on the unfiltered events list.
```

- [ ] **Step 2: Record the pre-existing Telegram credential exposure in `SECURITY.md`**

`SECURITY.md`'s "Known issues" section is severity-tiered
(`### Critical`, `### High`, `### Medium`, `### By design, not bugs`). This
belongs under **`### Medium`**: it requires an already-invited member, and the
impact is spoofed notifications rather than control of the alarm. Match the
format of the entries already there.

```markdown
- **Telegram bot token is readable by any project member.**
  `telegramBotToken` and `telegramChatId` are fields on
  `projects/{projectId}`, which is `allow read: if isMember(projectId)`, so
  every member's browser downloads them. A member can post arbitrary messages
  as the alarm system — including a false "all clear". The Pushover
  credentials added 2026-10-04 avoid this by living in
  `projects/{projectId}/secrets/notify` (`allow read, write: if false`); the
  Telegram pair should move to the same subcollection. Not done in that change
  because migrating live credentials risks every project's alerting and cannot
  be rehearsed against production.
```

- [ ] **Step 3: Note the follow-ups in `todo.txt`**

```
- move telegramBotToken/telegramChatId into projects/{id}/secrets/notify, the
  way the Pushover credentials already are. They are on the member-readable
  project doc today (see SECURITY.md). Needs a backfill that writes the
  secret, flips a read to the new path, then clears the old fields.
- Pushover image attachments, so a breach photo reaches a Pushover-only
  project. onSnapshotUploaded currently sends the photo via Telegram and only
  the caption text through notify().
- deep-link an alert to the SPECIFIC event. The Pushover notification already
  links to /explore, but ExplorePage reads no query parameter, so the link
  lands on the unfiltered list. Teaching it to honour ?rfId=&ts= and
  pre-select that row would put the triggering sensor's snapshots on screen
  directly from the notification. notify() would take the rfId and build the
  query; APP_EVENTS_URL is the seam.
```

- [ ] **Step 4: Full verification before deploying**

Run: `cd functions && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; every suite passes.

Run: `cd web && npm run lint && npm test && npm run build`
Expected: all clean.

Do not proceed to deploy if anything fails. Report the failure output.

- [ ] **Step 5: Commit the docs**

```bash
git add CLAUDE.md SECURITY.md todo.txt
git commit -m "docs: Pushover notification channel

Also records the pre-existing Telegram-token exposure on the
member-readable project doc, which this change did not fix but which the
new secrets subcollection shows the fix for."
```

- [ ] **Step 6: Deploy, in this order**

Rules FIRST — the secret must never be writable by a client, even briefly.

```bash
npx firebase deploy --only firestore:rules
cd functions && npm run build && cd ..
npx firebase deploy --only functions
cd web && npm run build && cd ..
npx firebase deploy --only hosting
```

- [ ] **Step 7: Write the credentials — THE USER RUNS THIS, NOT THE AGENT**

Ask the user to run, in their own terminal, substituting their real values:

```bash
cd functions
GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json \
  npm run set:notifyKey -- <projectId> <appToken> <userKey>
```

**The agent must never ask for, echo, or store these credentials.** They must
not appear in the conversation.

Verify with: `GOOGLE_APPLICATION_CREDENTIALS=... npm run set:notifyKey -- --show <projectId>`
Expected: both fields shown masked.

- [ ] **Step 8: Verify the rule actually denies clients**

In the web app, signed in as a project member, open the browser console and
attempt the read that must fail:

```javascript
// Expected: FirebaseError "Missing or insufficient permissions."
await firebase.firestore().doc("projects/<projectId>/secrets/notify").get();
```

If this SUCCEEDS, stop: the rule did not deploy, and the credentials are
exposed to every member. Re-deploy rules before continuing.

- [ ] **Step 9: Enable the channel and verify end to end**

1. In Settings, tick **Pushover** (and leave Telegram ticked).
2. In the Pushover iOS app, enable **Critical Alerts** and check the Quiet
   Hours overrides for priority 1 and 2.
3. **Mute the phone with the ringer switch.**
4. Fire a trigger: `curl -s -X POST "http://alarm.local/trigger?rfId=0x2E5B73"`
   on an armed system, or use the web simulator.
5. Confirm: the Pushover alert **sounds at full volume on the muted phone**,
   and a priority-2 alarm **keeps repeating until acknowledged**.
6. Tap the alert's **"Open alarm system"** action. Confirm it opens the
   **installed PWA** (standalone, no Safari chrome) on the events page — not a
   browser tab. If it opens Safari, the PWA is not installed to the home
   screen, or the link fell outside the manifest `scope`.
7. Disarm and confirm the arm/disarm notice arrives **silently** (priority -1)
   and carries **no** link action.

Step 5 is the only test that proves what this change exists for. Nothing in
the unit suite can establish it.

- [ ] **Step 10: Record the hardware-verified result**

Update the `CLAUDE.md` section from Step 1, replacing "**NOT verified on a
muted phone**" with the measured outcome — what sounded, what repeated, and
whether Critical Alerts needed the in-app opt-in. Then commit:

```bash
git add CLAUDE.md
git commit -m "docs: Pushover verified on a muted phone"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| Credentials: server-only per-project subcollection | 1, 8, 9 |
| Enablement: `notifyChannels` on the project doc | 3, 4, 10 |
| One dispatcher replacing nine gates | 4, 5, 6, 7 |
| Severity mapping | 2, 4 |
| `pushover.ts` | 2 |
| PWA deep link (added after the spec, at the user's request) | 2, 4, 6, 7, 11 |
| Web UI | 10 |
| Setter script | 9 |
| Data flow | 4 |
| Error handling table | 1, 2, 4 (every row has a test) |
| Testing | 1, 2, 4, 10 |
| Files touched | all tasks |
| Security | 1, 8, 11 |
| Deployment and manual steps | 11 |

**Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N".
Every code step carries real code. Three steps deliberately say "read the
surrounding file first and follow its conventions" (5, 10 step 1, 10 step 8) —
these are UI/wrapper edits in files whose local style the plan cannot
faithfully reproduce without inlining them wholesale; each pairs the
instruction with an exact `grep` to run and an exact assertion to verify.

**Type consistency:** `Severity` is defined once in `pushover.ts` (Task 2) and
re-exported from `notify.ts` (Task 4), never redefined. `NotifyChannel` is
defined in `functions/src/types.ts` (Task 3) and mirrored in
`web/src/features/setup/settingsForm.ts` (Task 10) because the web app keeps
its own types — intentional duplication, matching how `Project` is already
mirrored. `notifySecretsPath` is defined in Task 1 and consumed by Task 9.
`NotifySecrets` field names (`pushoverToken`, `pushoverUserKey`) are identical
in Tasks 1, 4, and 9. `sendPushover`'s argument object matches
`pushoverBody`'s in Tasks 2 and 4.

**Known gap, stated not hidden:** Tasks 5–7 edit wrapper code that has no unit
tests, because this codebase deliberately keeps those wrappers untested (see
"Testing reality" above). Their verification is `tsc --noEmit`, the exact
`grep` assertions in each task, and the end-to-end check in Task 11. A plan
that claimed unit coverage for them would be lying.
