import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import MarkdownIt from "markdown-it";
import { defineConfig, type Plugin } from "vite";

/**
 * The public site (landing, docs, download), a static Vue SPA. `SITE_BASE` is the path it is
 * served under: `/nav/` on GitHub Pages, `/` locally.
 */
const base = process.env.SITE_BASE ?? "/";
const docsDir = fileURLToPath(new URL("./src/docs", import.meta.url));

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/** Renders `src/docs/*.md` at build time into `{ html, title, headings }`, so no parser ships. */
function markdownDocs(): Plugin {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true });
  return {
    name: "navarch-site-markdown",
    transform(source, id) {
      if (!id.endsWith(".md")) return;
      const env: { headings: { level: number; id: string; text: string }[] } = { headings: [] };
      const tokens = md.parse(source, env);
      let title = "";
      tokens.forEach((token, i) => {
        if (token.type === "heading_open") {
          const text = tokens[i + 1]?.content ?? "";
          const level = Number(token.tag.slice(1));
          if (level === 1 && !title) title = text;
          const slug = slugify(text);
          token.attrSet("id", slug);
          if (level === 2 || level === 3) env.headings.push({ level, id: slug, text });
        }
        // Site links are written from the root (`/docs/agents`); they get the base path here.
        if (token.type === "inline") {
          for (const child of token.children ?? []) {
            const href = child.attrGet("href");
            if (child.type !== "link_open" || !href) continue;
            if (href.startsWith("/")) child.attrSet("href", base.replace(/\/$/, "") + href);
            else if (/^https?:/.test(href)) {
              child.attrSet("target", "_blank");
              child.attrSet("rel", "noopener");
            }
          }
        }
      });
      const html = md.renderer.render(tokens, md.options, env);
      return { code: `export default ${JSON.stringify({ html, title, headings: env.headings })};`, map: null };
    },
  };
}

/** GitHub Pages has no SPA fallback: every route gets its own copy of index.html, plus 404.html. */
function routeCopies(): Plugin {
  let outDir = "dist";
  return {
    name: "navarch-site-routes",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const index = join(outDir, "index.html");
      const docs = readdirSync(docsDir).filter((f) => f.endsWith(".md")).map((f) => `docs/${f.slice(0, -3)}`);
      for (const route of ["download", "docs", ...docs]) {
        mkdirSync(join(outDir, route), { recursive: true });
        copyFileSync(index, join(outDir, route, "index.html"));
      }
      copyFileSync(index, join(outDir, "404.html"));
    },
  };
}

export default defineConfig({
  base,
  plugins: [markdownDocs(), vue(), tailwindcss(), routeCopies()],
  server: { host: "127.0.0.1", fs: { allow: [".."] } },
  build: { outDir: "dist", emptyOutDir: true },
});
