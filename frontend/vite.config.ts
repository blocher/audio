import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Files from public/ that the app shell needs offline.
const PUBLIC_PRECACHE = [
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/apple-touch-icon.png",
];

/**
 * Writes dist/sw.js from pwa/sw.js with the build's precache list and a version derived from it.
 * Fonts outside the Latin subset are left to runtime caching so the first install stays small.
 */
function pwaPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "audio-pwa",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle(_options, bundle) {
      const built = Object.keys(bundle)
        .filter((file) => file !== "index.html" && !file.endsWith(".map"))
        .filter((file) => !file.endsWith(".woff2") || /-latin-(?!ext)/.test(file))
        .map((file) => `/${file}`);
      const precache = ["/index.html", ...built, ...PUBLIC_PRECACHE];
      const html = readFileSync(join(outDir, "index.html"));
      const version = createHash("sha256").update(html).update(precache.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./pwa/sw.js", import.meta.url), "utf8")
        .replace("__PWA_VERSION__", version)
        .replace("__PWA_PRECACHE__", JSON.stringify(precache, null, 2));
      writeFileSync(join(outDir, "sw.js"), source);
    },
  };
}

export default defineConfig({
  plugins: [react(), pwaPlugin()],
  server: {
    port: 5182,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.AUDIO_BACKEND_PORT ?? 8011}`, changeOrigin: false },
    },
  },
});
