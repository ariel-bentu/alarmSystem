/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Not autoUpdate: this app arms an alarm, and swapping the bundle
      // underneath a user mid-action is the wrong trade. See pwa/registerSW.ts.
      registerType: "prompt",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Alarm System",
        short_name: "Alarm",
        description: "Home alarm control: arm, disarm, and review events.",
        theme_color: "#0f1115",
        background_color: "#0f1115",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache the SHELL ONLY — not every chunk. The old pattern here was
        // `**/*.{js,css,html,svg,png,woff2}`, which swept in all 31 emitted
        // files (1.1MB), including the 391KB Firestore chunk, the 166KB RTDB
        // chunk and every lazy route. That undid the lazy splitting below: the
        // service worker eagerly installed chunks a signed-out visitor never
        // loads. Narrowing it took the precache to 17 entries / 448KB.
        //
        // This buys install bandwidth, NOT load time. A large `blocked` figure
        // on the navigation entry of a HAR looks like a stall but is not one:
        // that entry's startedDateTime is when the request object was created,
        // which can precede the page's own start marker by however long the tab
        // sat idle with devtools open. The page timeline is the honest source —
        // it reported onLoad ~60ms both before and after this change. Measured
        // directly, the service worker costs 1-17ms on a controlled navigation.
        //
        // What stays precached is exactly what the first paint needs: the HTML,
        // the CSS, the fonts, the icons, and the three eager chunks. Those are
        // matched by name because Vite's manualChunks pins their prefixes;
        // everything else under /assets is a lazy chunk and is handled by the
        // runtime route instead.
        globPatterns: [
          "index.html",
          "manifest.webmanifest",
          "assets/index-*.css",
          "assets/index-*.js",
          "assets/react-*.js",
          "assets/firebase-app-*.js",
          "fonts/*.woff2",
          "icons/*.png",
          "apple-touch-icon.png",
        ],
        // Lazy route chunks and the on-demand Firestore/RTDB SDK.
        //
        // CacheFirst, NOT StaleWhileRevalidate. Every filename here carries a
        // Vite content hash, so a given URL can never change contents and
        // there is nothing a revalidation could discover. SWR was measured
        // re-downloading 130KB on EVERY warm load — Workbox's background
        // revalidation issues an unconditional `cache-control: no-cache`
        // fetch with no If-None-Match, so the server returns a full 200 body
        // rather than a 304, and the HTTP cache is bypassed entirely. The
        // page was not slowed (the cached copy is served immediately), but on
        // a phone that is 130KB of cellular data per app open, for bytes that
        // are by construction identical to what is already stored.
        //
        // Staleness is not a risk: a deploy emits NEW hashed filenames, which
        // the freshly-installed index.html requests and this route then
        // fetches for the first time. cleanupOutdatedCaches() and the entry
        // cap below retire the superseded ones.
        runtimeCaching: [
          {
            urlPattern: /^.*\/assets\/.*\.js$/,
            handler: "CacheFirst",
            options: {
              cacheName: "lazy-chunks",
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
              // Opaque responses would silently poison a CacheFirst store;
              // these are same-origin, so only a real 200 is cacheable.
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        // SPA fallback, matching the Firebase Hosting rewrite.
        navigateFallback: "/index.html",
        // Firebase endpoints must never be served from the precache — stale
        // alarm state is worse than no alarm state.
        navigateFallbackDenylist: [/^\/__/, /firestore\.googleapis\.com/],
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        // A service worker in dev caches the developer's own edits and makes
        // "why isn't my change showing" a recurring puzzle.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    rollupOptions: {
      output: {
        // Only app+auth are grouped. Firestore, RTDB and Functions are
        // deliberately absent: naming them here would fuse them into one
        // always-loaded chunk and undo the lazy accessors in lib/firebase.ts,
        // no matter what the import graph says. Left alone, Rollup emits each
        // as its own async chunk behind the dynamic import that needs it.
        //
        // app+auth stay grouped because resolving auth state blocks the first
        // paint, and they change far less often than app code — so keeping
        // them in one chunk means a deploy does not invalidate them.
        manualChunks: {
          "firebase-app": ["firebase/app", "firebase/auth"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
