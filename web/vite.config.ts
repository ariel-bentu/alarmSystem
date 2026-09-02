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
        // Precache the shell so the app opens instantly and offline.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
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
