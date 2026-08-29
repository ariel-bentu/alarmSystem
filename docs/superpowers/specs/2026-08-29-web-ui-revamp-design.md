# Web UI Revamp — i18n, RTL, Mobile, Design System, PWA

**Date:** 2026-08-29
**Status:** Implemented. 121 web tests pass; typecheck and production build
clean. Not committed, not deployed — pending visual review in both languages.

**Deviations from the design as written:**
- The Simulator page was styled but NOT translated. It is gated behind
  `DEV_SIMULATOR` and never reaches an end user, so its strings stay English.
- The device's own LAN web page (`local_web_page.h`) stays English by
  agreement — it is an embedded C++ header, not part of this React app.
- Firebase (660KB) could not be shrunk: auth, Firestore, RTDB and functions
  are all genuinely used. It is now a separate cached chunk instead.

## Problem

The web app works but does not present well:

1. **No internationalisation.** Every string is a hardcoded English literal
   across 12 page components. Hebrew is needed as a first-class language.
2. **Breaks on narrow screens.** `AppLayout`'s header is a single non-wrapping
   flex row holding the project name, online dot, project switcher, raw
   project id, six nav links, the user's email and a sign-out button. On a
   phone the later nav items are clipped and **unreachable** — the original
   complaint.
3. **No design system.** 164 inline style objects across 18 components, one
   6-line stylesheet. Nothing is reusable, and inline styles use physical
   properties (`marginLeft`), which cannot flip for RTL.
4. **Slow first load.** A single 868KB JS chunk (220KB gzipped); the build
   already warns about it. No installability, no offline capability.
5. **Operations is cluttered.** It duplicates a sensor list that belongs in
   Configure.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Styling | Hand-rolled CSS design system, no new runtime deps | Matches the project's zero-dependency style; RTL comes free from logical properties |
| Mobile nav | Horizontally scrolling tab strip | User's choice over a bottom bar; mitigated with edge fades + auto-scroll-into-view |
| Language storage | `localStorage`, first visit from `navigator.language` | Per-device, no schema change, works before sign-in |
| Header on mobile | Two rows: identity, then scrolling tabs | Keeps project name and account reachable; raw project id demoted to the account menu |
| Offline | Cached shell + last-known data + explicit staleness banner | Useful offline without letting anyone trust a stale arm state |
| Service worker | `vite-plugin-pwa` (dev dependency) | Cache versioning and update flows are easy to get subtly wrong by hand |
| Hebrew strings | Written as part of this work | User requested |

## Architecture

### 1. i18n

```
src/i18n/
  en.ts             flat key -> string
  he.ts             same keys, Hebrew
  keys.ts           type Key = keyof typeof en
  I18nProvider.tsx  context: { t, lang, setLang, dir }
  useT.ts           const t = useT()
  language.ts       pure: resolveInitialLanguage(stored, navigatorLangs)
```

- `t(key, vars?)` interpolates `{name}` placeholders.
- A missing key returns the key itself and `console.warn`s in dev — visibly
  wrong rather than a blank screen.
- `he.ts` is typed as `Record<Key, string>`, so a missing translation is a
  **typecheck failure**, not a runtime surprise.
- `I18nProvider` sets `<html lang>` and `<html dir>`; Hebrew implies `rtl`.
- Language persisted in `localStorage` under `alarm.lang`; first visit derives
  from `navigator.languages` (Hebrew if preferred, else English).

**RTL rule:** all CSS uses logical properties — `margin-inline-start`,
`padding-inline`, `inset-inline-end`, `text-align: start`. This is the primary
reason inline styles must go: `marginLeft: "auto"` does not flip, whereas
`margin-inline-start: auto` does.

**Bidi rule:** identifiers and numbers embedded in Hebrew text (rfIds like
`0x2E5B73`, timestamps, project ids) are wrapped in `dir="ltr"` spans, or they
render with their characters reordered.

### 2. Design system

```
src/styles/
  tokens.css      custom properties: colour, spacing, radii, shadow, type scale
  base.css        reset, typography, focus-visible rings
  components.css  .btn .tabs .card .field .table .badge .banner .switch
```

- Colour tokens respect the existing `color-scheme: light dark`.
- `.btn` variants: `primary`, `danger`, `ghost`; sizes `sm`, `md`.
- Existing visual semantics are preserved, converted from inline styles to
  classes: the alarm blink (`alarm-blink` keyframe, with the
  `prefers-reduced-motion` fallback), the green "just seen" dot, armed-profile
  highlighting, and the device-online dot.
- Minimum touch target 44px on interactive controls.

### 3. Layout and navigation

`AppLayout` becomes two rows:

- **Row 1 (identity):** project name · online dot · language flag toggle ·
  account menu (email, project switcher, project id, sign out).
- **Row 2 (nav):** `overflow-x: auto` tab strip with `scroll-snap`, hidden
  scrollbar, **edge fade masks** signalling more content, and the active tab
  scrolled into view on mount and on route change.

The raw project id moves into the account menu — it is a debugging aid, not
everyday UI. `ConfigurePage`'s sub-tabs reuse the same `.tabs` component and
gain proper `role="tab"` / `aria-selected` semantics (they currently use
`disabled` to mark the active tab, which removes it from focus order).

### 4. Operations page

The Sensors table is **removed** — it belongs in Configure. Resulting page:

1. Alarm banner (when an unacknowledged alarm exists)
2. Device card — arm state + profile grid
3. Server card — arm state + profile grid
4. Siren status — reports configuration, not a phantom control

### 5. PWA and fast load

- `vite-plugin-pwa` with `registerType: "prompt"`. An update surfaces a
  "New version available · Reload" toast rather than swapping the app
  underneath a user mid-arm.
- Manifest: standalone display, theme colour, 192/512 + maskable icons
  generated from an SVG shield mark.
- Workbox precaches the shell.
- Firestore offline persistence (`persistentLocalCache`) so sensors, profiles
  and rules render from IndexedDB.
- **Offline banner** driven by `navigator.onLine` *and* Firestore snapshot
  `fromCache` metadata — being "online" does not mean Firebase is reachable.
  Arm/disarm is disabled while offline, since the write cannot reach the
  device and a silently-queued arm is dangerous.
- Route-level `React.lazy` splitting so Operations does not pull in Configure,
  Explore, Members, Settings and the simulator.

## Implementation order

1. Design tokens + component CSS (no visible change yet)
2. i18n provider, `en`/`he`, language switch
3. `AppLayout`: two rows, scrolling tabs, account menu
4. Convert all 12 pages: classes for inline styles, `t()` for literals,
   RTL-safe throughout
5. Operations: drop the sensor list, adopt cards
6. PWA: manifest, service worker, offline banner, Firestore persistence,
   route splitting

## Testing

- The existing 99 web tests must keep passing. `SignInPage.test.tsx` and any
  other render tests need wrapping in `I18nProvider`.
- New unit tests:
  - `t()` — interpolation, missing-key fallback, no-vars case
  - locale parity — every `en` key exists in `he` (belt and braces alongside
    the type constraint)
  - `resolveInitialLanguage` — stored wins, else browser, else English
  - offline-state derivation — `navigator.onLine` false, or snapshot from
    cache, yields stale
- Manual verification required (cannot be automated here): both languages
  rendered on a real narrow viewport, RTL mirroring, and install + offline
  launch on a phone.

## Risks

- **Touches every page.** Conversion is mechanical but broad; the risk is
  visual regression rather than logic breakage. Existing tests cover logic,
  not appearance.
- **Hebrew review.** Strings are written as part of this work; the user should
  read them in context, since alarm-domain wording carries real consequences.
- **Service worker caching during development.** A registered SW on the
  hosting origin caches for the developer too. `registerType: "prompt"` plus
  a hard refresh handles it, but it can confuse a "why isn't my change
  showing" moment.
- **Bundle splitting changes load order.** Route-level lazy loading introduces
  suspense boundaries; each route needs a sensible fallback.
