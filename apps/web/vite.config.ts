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
  experimental: {
    // Files the scripts load by name (module preloads) go under the relay prefix when the app was reached
    // through a relay (ADR 0067): the phone's worker adds a `<meta name="navarch-base">`. Elsewhere it is empty.
    renderBuiltUrl(filename, { hostType }) {
      if (hostType !== "js") return undefined;
      return { runtime: `((document.querySelector('meta[name="navarch-base"]')?.getAttribute("content")) || "") + ${JSON.stringify(`/${filename}`)}` };
    },
  },
});
