import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/** `make web-dev` proxies the Core API to a running navarchd (ADR 0017). */
const daemon = process.env.NAVARCH_URL ?? "http://127.0.0.1:7420";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": { target: daemon, ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
