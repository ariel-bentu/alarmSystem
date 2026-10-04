# Pushover as a second notification channel

**Date:** 2026-10-04
**Status:** design, approved for planning

## Problem

A breach at night does not wake the owner. The siren is outdoors and rarely
heard from the bedroom; the phone is on **mute** (the ringer switch, not Do
Not Disturb), which silences every Telegram notification regardless of chat
settings or Focus exceptions.

Mute cannot be defeated by configuring Telegram. iOS silences app
notification sounds in mute unless the app holds Apple's **Critical Alerts**
entitlement, which Telegram does not have. The options that do survive mute
are a phone call from a contact with Emergency Bypass, an app holding the
Critical Alerts entitlement, or a noise source that does not involve the
phone at all.

**Pushover holds the Critical Alerts entitlement.** It applies Critical
Alerts to both priority 1 (High) and priority 2 (Emergency) messages, so a
Pushover push plays at full volume through mute and through Do Not Disturb.
Priority 2 additionally repeats until acknowledged.

This design adds Pushover as a per-project notification channel that can
replace Telegram or run alongside it.

### Out of scope, deliberately

- **An indoor siren.** Independently the best fix for "I don't wake up": no
  code, ~$15, and it works during a WiFi outage, which matters given the
  WiFi-independence decision in `CLAUDE.md`. A second siren paired to the
  existing EV1527 address needs no firmware change at all, since EV1527 is
  broadcast. Recommended, but not a software change and not part of this work.
- **Migrating the Telegram credentials off `projects/{projectId}`.** They are
  member-readable today (see Security below). Real, but a separate change:
  doing it here would put every project's existing alerting at risk inside a
  change that cannot be tested against production. Recorded in
  `SECURITY.md` known issues instead.
- **Pushover image attachments.** Pushover supports them, so the
  `onSnapshotUploaded` breach photo could go to both channels. Deferred to
  keep this change reviewable; `onSnapshotUploaded` keeps using
  `sendTelegramPhoto` and gains a text-only Pushover alert.
- **The Pushover `device` parameter.** Omitted on purpose: omitting it
  delivers to *all* the user's devices, which is what an alarm wants. A
  phone that is off or out of battery must not swallow the alert.
- **Acknowledgement callbacks.** Priority 2 accepts a `callback` URL that
  Pushover hits on acknowledgement. A plausible future timeline enrichment,
  not needed now.
- **Deep-linking to a specific event.** The alert links to the events page
  (see below), but `/explore` reads no query parameter today, so it cannot
  pre-select the triggering sensor's row. Worth doing; a separate change.
- **A Twilio voice call.** The other mute-defeating remote channel, and
  harder to sleep through than any notification. Worth revisiting only if
  Pushover priority 2 proves insufficient in the field.

## Current state

`sendTelegram(botToken, chatId, text, silent?)` is called from **nine sites
across eight functions**, each preceded by a copy of the same gate:

```ts
if (!project.telegramBotToken || !project.telegramChatId) return;
```

| Function | Site | `silent` | Severity it deserves |
|---|---|---|---|
| `onAlarm` | alarm fired | default (loud) | `alarm` |
| `onSensorEvent` | sensor trigger notice | default (loud) | `loud` |
| `onSensorEvent` | server-evaluated alarm | default (loud) | `alarm` |
| `deviceLiveness` | device offline | default (loud) | `loud` |
| `deviceLiveness` | device back online | default (loud) | `notice` |
| `deadSensorCheck` | stale battery | default (loud) | `loud` |
| `deadSensorCheck` | dead sensor | default (loud) | `loud` |
| `onArmStateChange` | arm/disarm | `true` | `notice` |
| `onDeviceArmStateChange` | arm/disarm | `true` | `notice` |
| `onServerArmChange` | arm/disarm | `true` | `notice` |
| `onSnapshotUploaded` | breach photo | (`sendTelegramPhoto`) | `alarm` |

The `silent` boolean already encodes two levels — loud for alerts, quiet for
notices. The severity model below is a faithful generalisation of that
existing distinction, not a new concept imposed on the code.

Note `device back online` is reclassified from loud to `notice`: a recovery
message is informational, and under Pushover's mapping a loud severity would
play a Critical Alert through mute to say everything is fine.

## Design

### 1. Credentials: a server-only per-project subcollection

```
projects/{projectId}/secrets/notify → { pushoverToken, pushoverUserKey }
```

Pushover credentials are **per project**, not global. The token and user key
identify *who gets woken up*, which is a property of the project. This is
unlike the judge API keys in `config/judge`, which are one account's
credentials shared across every project — that precedent does not transfer.

They must still stay off `projects/{projectId}`, because that doc is
`allow read: if isMember(projectId)` — *any* member — so a credential there
is downloaded in plaintext by every member's browser. Firestore rules do not
inherit, so a subcollection can be denied while its parent stays readable:

```
match /projects/{projectId}/secrets/{secretId} {
  allow read, write: if false;
}
```

Only the admin SDK reaches it. This also establishes the pattern the Telegram
credentials should eventually move into, making this change a step toward
fixing that wart rather than widening it.

`loadNotifySecrets(db, projectId)` mirrors `loadJudgeKeys`: **never throws,
never rejects.** A missing doc, missing field, or Firestore read failure all
resolve to an empty secret set, and the caller treats that as "channel not
configured". A credential problem must never take down the other channel.

### 2. Enablement: a non-secret field on the project doc

```ts
notifyChannels?: ("telegram" | "pushover")[];
```

Absent → `["telegram"]`, so **every existing project behaves exactly as it
does today** with no migration. An empty array means no notifications, which
is a legitimate choice and must not be silently coerced to a default. This
field is not a secret and belongs on the project doc, where the web UI can
read and write it.

### 3. One dispatcher replacing nine gates

New `functions/src/notify.ts`:

```ts
export type Severity = "alarm" | "loud" | "notice";

export interface NotifyMessage {
  text: string;        // already-formatted, HTML-escaped per Telegram rules
  severity: Severity;
  title?: string;      // Pushover only; Telegram has no title concept
}

export async function notify(
  projectId: string,
  project: Project,
  msg: NotifyMessage
): Promise<void>;
```

`notify` resolves the channel list, loads the secrets doc once, and fans out.
Each call site collapses from gate-plus-send to one `await notify(...)`.

**Failure isolation is the core contract.** Each channel is dispatched inside
its own `try`/`catch`; a throw or a non-OK HTTP status is logged and
swallowed. One channel failing must never prevent the other from firing, and
`notify` itself never throws — matching the contract `sendTelegram` already
has, which several callers depend on (`deviceLiveness` and `deadSensorCheck`
latch their alert markers only *after* a successful send, so an exception
escaping would change retry behaviour).

Channels are dispatched **concurrently** (`Promise.allSettled`), not in
series: an alarm should not wait for a slow Telegram request before reaching
Pushover.

### 4. Severity mapping

| Severity | Telegram | Pushover |
|---|---|---|
| `alarm` | loud (`silent: false`) | priority **2** + `retry`, `expire` |
| `loud` | loud (`silent: false`) | priority **1** |
| `notice` | `silent: true` | priority **-1** |

Pushover specifics, confirmed against the current API docs:

- Priority **2** *requires* `retry` (≥ 30s) and `expire` (≤ 10800s). Pushover
  rejects the message without them — a real failure mode, pinned by a test.
  Defaults: `retry: 60`, `expire: 3600`. Overridable per project via optional
  non-secret fields `pushoverRetrySec` / `pushoverExpireSec`.
- Retries are capped at 50 attempts regardless of `expire`.
- Priority **1** also triggers Critical Alerts — loud through mute, but a
  single alert with no repeat. This is why `loud` is useful and why `alarm`
  is reserved for the three genuine breach sites.
- Priority **-1** delivers with no sound or vibration.

### 4a. The PWA deep link

Pushover's optional `url` / `url_title` render a tappable action on the
notification. Alarm, breach and sensor-alert messages set it to
`https://alarm-system-100.web.app/explore` — the events page, where a
trigger's camera snapshots are.

**This opens the installed PWA, not Safari**, because `web/vite.config.ts`
already declares `scope: "/"` and `display: "standalone"` in the manifest. An
in-scope https link is captured by the installed app. No manifest change, no
custom URL scheme, no App Store presence, no Apple developer account — which
is the constraint that ruled out a native app in the first place.

`NotifyMessage.link?: boolean` requests it; `notify` builds the URL so no call
site hardcodes it. Pushover-only: Telegram already renders URLs in the message
body, and adding one to every message would clutter the chat. Notices
(arm/disarm, device back online) carry no link — there is nothing to look at.

The link lands on the **unfiltered** events list, since `/explore` reads no
query parameter. Pre-selecting the triggering event is a follow-up recorded in
`todo.txt`.

### 5. `pushover.ts`

Same shape as `telegram.ts`: one `fetch` sender plus pure, unit-tested
helpers. `POST https://api.pushover.net/1/messages.json`, form-encoded, with
`token`, `user`, `message`, `priority`, and — for priority 2 — `retry` and
`expire`. Logs and swallows on non-OK, like `sendTelegram`.

Pushover messages support a limited HTML subset (`<b>`, `<i>`, `<u>`, `<font
color>`, `<a href>`) when `html=1` is passed. The existing formatters emit
`<b>` and plain text, which is within that subset, so `html=1` is passed and
the formatters are shared across both channels unchanged. No per-channel
formatter variants — verdicts and wording cannot drift between channels.

### 6. Web UI

`SettingsPage.tsx` gains channel checkboxes beside the existing Telegram
fields, writing `notifyChannels`. The Pushover **credentials do not appear in
the UI at all** — they are server-only, same as the judge keys, and a form
field for them would defeat the subcollection. The page shows whether
Pushover credentials are present, which it must infer from a non-secret
boolean the setter script maintains (`pushoverConfigured`), since the client
cannot read the secret.

i18n strings added to both `en.ts` and `he.ts`, kept in sync per house rules.

### 7. Setter script

`npm run set:notifyKey -- <projectId> <appToken> <userKey>`, modelled on
`setJudgeKey.ts`: service-account credential, keys never echoed back, only
masked. `--show <projectId>` lists masked values. Writing the secret also
sets `projects/{projectId}.pushoverConfigured = true` so the UI can reflect
state without reading the secret.

**Keys are entered only through this script.** They must never be pasted into
a chat transcript, committed, or placed in the web UI.

## Data flow

```
event (RTDB write / scheduled tick)
  → existing Cloud Function
  → notify(projectId, project, { text, severity })
      ├─ resolve notifyChannels (absent → ["telegram"])
      ├─ loadNotifySecrets(projectId)        [never throws]
      └─ Promise.allSettled:
           ├─ telegram: sendTelegram(..., silent = severity === "notice")
           └─ pushover: sendPushover(..., priority = map(severity))
```

## Error handling

| Failure | Behaviour |
|---|---|
| `notifyChannels` absent | Telegram only (today's behaviour) |
| `notifyChannels: []` | Nothing sent; not coerced to a default |
| Pushover listed, no credentials | Pushover skipped, logged; Telegram still sends |
| Telegram listed, no credentials | Telegram skipped, logged; Pushover still sends |
| Secrets read throws | Treated as no credentials; Telegram unaffected |
| One channel HTTP error | Logged, swallowed; other channel unaffected |
| Priority 2 without retry/expire | Impossible by construction; pinned by test |

`notify` never throws. Callers that latch alert markers after a send keep
their existing semantics.

## Testing

TDD, per `CONTRIBUTING.md`. Mocked `fetch`; no live API calls in any test.

`notify.test.ts`
- channel resolution: absent → telegram only; `["pushover"]` → pushover only;
  both → both; `[]` → neither
- severity → `silent` mapping for Telegram
- severity → priority mapping for Pushover
- Pushover skipped when credentials are missing, Telegram still sent
- a throwing Telegram send does not prevent the Pushover send (and vice versa)
- `notify` never rejects, including when the secrets read throws

`pushover.test.ts`
- priority 2 always carries `retry` and `expire`
- `retry` floored at 30s, `expire` capped at 10800s
- per-project overrides honoured, defaults applied when absent
- non-OK response is logged and swallowed, never thrown
- `html=1` is passed

`notifySecrets.test.ts`
- missing doc, missing field, blank string, and a throwing read all yield an
  empty secret set

Existing suites for the eight touched functions must keep passing with their
`sendTelegram` assertions updated to the `notify` seam.

## Files touched

| File | Change |
|---|---|
| `functions/src/notify.ts` | new — dispatcher |
| `functions/src/pushover.ts` | new — sender + helpers |
| `functions/src/notifySecrets.ts` | new — `loadNotifySecrets` |
| `functions/src/types.ts` | `notifyChannels`, `pushoverConfigured`, `pushoverRetrySec`, `pushoverExpireSec` |
| `functions/src/onAlarm.ts` | → `notify`, `alarm` |
| `functions/src/onSensorEvent.ts` | → `notify` ×2 (`loud`, `alarm`) |
| `functions/src/deviceLiveness.ts` | → `notify` ×2 (`loud`, `notice`) |
| `functions/src/deadSensorCheck.ts` | → `notify` ×2 (`loud`) |
| `functions/src/onArmStateChange.ts` | → `notify`, `notice` |
| `functions/src/onDeviceArmStateChange.ts` | → `notify`, `notice` |
| `functions/src/onServerArmChange.ts` | → `notify`, `notice` |
| `functions/src/onSnapshotUploaded.ts` | keeps photo; adds `notify` text, `alarm` |
| `functions/scripts/setNotifyKey.ts` | new |
| `functions/package.json` | `set:notifyKey` script |
| `firestore.rules` | deny `projects/{id}/secrets/{id}` |
| `web/src/types/index.ts` | mirror the new fields |
| `web/src/features/setup/SettingsPage.tsx`, `settingsForm.ts` | channel checkboxes |
| `web/src/i18n/{en,he}.ts` | strings |
| `CLAUDE.md`, `SECURITY.md` | document channel + the Telegram-creds wart |

## Security

- Pushover credentials are server-only, unreachable by any client, in a
  subcollection denied by rules while the parent project doc stays
  member-readable.
- Keys enter only via `set:notifyKey`. Never in the UI, never in a transcript,
  never committed.
- A leaked Pushover app token lets a third party send notifications to the
  owner's devices — nuisance-grade, not billable like an LLM key, but it is
  also an alert channel for a *security system*: a spoofed "all clear" or an
  alert flood that trains the owner to ignore it is the real risk. Hence
  server-only.
- **Pre-existing, not fixed here:** `telegramBotToken` and `telegramChatId`
  are fields on the member-readable project doc. A member can read the bot
  token and post as the alarm system. Recorded in `SECURITY.md`.

## Deployment and manual steps

Order matters: the rules change must land before the first secret is written.

1. Deploy `firestore.rules` (denies the new subcollection).
2. `npm run set:notifyKey -- <projectId> <appToken> <userKey>`.
3. Deploy functions.
4. Enable Pushover in Settings for the project.

**Then, on the phone — no code substitutes for these:**

5. **Opt into Critical Alerts in the Pushover iOS app.** Apple requires
   separate user consent even when normal push is already allowed. Without
   it, priority 1 and 2 are ordinary notifications and stay *silent on mute*
   — indistinguishable from a broken integration.
6. Check the Pushover **Quiet Hours** overrides for priority 1 and 2.
7. Verify with a real armed trigger, phone muted. Nothing short of that
   confirms the mute-defeating behaviour this whole change exists for.
8. Tap the alert's link and confirm it opens the **installed PWA** standalone,
   not a Safari tab. If Safari opens, the app is not installed to the home
   screen.

## Open questions

None blocking. Two judgement calls made and recorded above: `device back
online` reclassified to `notice`, and `onSnapshotUploaded` keeps its Telegram
photo while gaining a text-only Pushover alert.
