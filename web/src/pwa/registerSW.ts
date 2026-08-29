// Service worker registration with an explicit update prompt.
//
// registerType is "prompt", not "autoUpdate": this app arms and disarms an
// alarm, and swapping the running bundle underneath someone mid-action is
// the wrong trade. The user is told a new version exists and chooses when.
//
// The prompt is deliberately a plain DOM banner rather than React state — it
// must work even if the app shell itself failed to hydrate.

import { registerSW } from "virtual:pwa-register";

export function registerServiceWorker(): void {
  // Vite injects the virtual module only for a real build; in dev and under
  // vitest there is no SW to register.
  if (import.meta.env.DEV) return;

  const updateSW = registerSW({
    onNeedRefresh() {
      showUpdateBanner(() => void updateSW(true));
    },
  });
}

function showUpdateBanner(onReload: () => void): void {
  if (document.getElementById("sw-update-banner")) return;

  const bar = document.createElement("div");
  bar.id = "sw-update-banner";
  bar.setAttribute("role", "status");
  bar.className = "banner";
  bar.style.cssText =
    "position:fixed;inset-inline:12px;inset-block-end:12px;z-index:9999;" +
    "justify-content:space-between;box-shadow:var(--shadow-2);" +
    "background:var(--surface);";

  const text = document.createElement("span");
  // Read from the live document so the message matches the chosen language.
  const isHe = document.documentElement.lang === "he";
  text.textContent = isHe ? "קיימת גרסה חדשה." : "A new version is available.";

  const btn = document.createElement("button");
  btn.className = "btn btn--primary btn--sm";
  btn.textContent = isHe ? "רענון" : "Reload";
  btn.addEventListener("click", onReload);

  bar.append(text, btn);
  document.body.appendChild(bar);
}
