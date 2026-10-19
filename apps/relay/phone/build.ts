import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

/**
 * Builds what the relay serves to a phone (ADR 0067): the loader page's script and the service worker,
 * each as one plain script (service workers and the loader need no module system), next to the page and
 * its stylesheet. Output goes to `apps/relay/dist`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../dist");

for (const entry of ["loader", "sw"] as const) {
  await build({
    configFile: false,
    logLevel: "warn",
    root: here,
    build: {
      outDir: out,
      emptyOutDir: entry === "loader",
      target: "es2022",
      minify: true,
      sourcemap: false,
      lib: { entry: resolve(here, `${entry}.ts`), formats: ["iife"], name: `navarch_${entry}`, fileName: () => `${entry}.js` },
    },
  });
}
mkdirSync(out, { recursive: true });
for (const file of ["index.html", "loader.css"]) copyFileSync(resolve(here, file), resolve(out, file));
console.log(`phone loader built in ${out}`);
