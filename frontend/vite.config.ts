import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5182,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.AUDIO_BACKEND_PORT ?? 8011}`, changeOrigin: false },
    },
  },
});
