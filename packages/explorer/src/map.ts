import type { RepoMap } from "@navarch/contracts";
import { listFiles, readText } from "./files.ts";
import { EXTRACTORS } from "./symbols.ts";

const MANIFESTS = new Set(["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Dockerfile", "Makefile", "pnpm-workspace.yaml", "docker-compose.yml"]);
const NPM_FRAMEWORKS = ["vue", "react", "svelte", "next", "nuxt", "express", "fastify", "vite", "vitest", "jest", "tailwindcss", "typescript", "playwright"];
const PY_FRAMEWORKS = ["django", "fastapi", "flask", "pytest"];
const GO_FRAMEWORKS = ["gin-gonic/gin", "labstack/echo", "gofiber/fiber"];
const RUST_FRAMEWORKS = ["tokio", "axum", "actix-web", "serde"];
const ENTRY = [/^(?:src\/)?main\.\w+$/, /^(?:src\/)?__main__\.py$/, /^cmd\/[^/]+\/main\.go$/, /^main\.go$/];

export async function repoMap(root: string): Promise<RepoMap> {
  const files = await listFiles(root);
  const stats = new Map<string, { files: number; lines: number }>();
  const dirs = new Map<string, number>();
  const manifests: string[] = [];
  const entries = new Set<string>();
  const frameworks = new Set<string>();

  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash > 0) dirs.set(file.slice(0, slash), (dirs.get(file.slice(0, slash)) ?? 0) + 1);
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (MANIFESTS.has(base) && file.split("/").length <= 3) manifests.push(file);
    if (ENTRY.some((re) => re.test(file))) entries.add(file);
    if (file.startsWith(".github/workflows/")) frameworks.add("github actions");
    const ext = EXTRACTORS.find((e) => e.extensions.some((x) => file.toLowerCase().endsWith(x)));
    if (ext) {
      const text = await readText(root, file);
      const entry = stats.get(ext.lang) ?? { files: 0, lines: 0 };
      entry.files += 1;
      entry.lines += text ? text.split("\n").length : 0;
      stats.set(ext.lang, entry);
    }
  }

  if (manifests.includes("pnpm-workspace.yaml")) frameworks.add("pnpm workspaces");
  if (manifests.some((m) => m.endsWith("Dockerfile") || m.endsWith("docker-compose.yml"))) frameworks.add("docker");
  for (const manifest of manifests) {
    const text = await readText(root, manifest);
    if (text === undefined) continue;
    if (manifest.endsWith("package.json")) readPackage(text, manifest, frameworks, entries);
    else if (manifest.endsWith("pyproject.toml") || manifest.endsWith("requirements.txt")) addMatches(text.toLowerCase(), PY_FRAMEWORKS, frameworks);
    else if (manifest.endsWith("go.mod")) addMatches(text, GO_FRAMEWORKS, frameworks, (n) => n.split("/")[1]!);
    else if (manifest.endsWith("Cargo.toml")) addMatches(text, RUST_FRAMEWORKS, frameworks);
  }

  const known = new Set(files);
  return {
    languages: [...stats].map(([lang, s]) => ({ lang, ...s })).sort((a, b) => b.lines - a.lines).slice(0, 8),
    frameworks: [...frameworks].sort(),
    entry_points: [...entries].filter((e) => known.has(e)).sort(),
    manifests: manifests.slice(0, 30),
    directories: [...dirs].map(([path, n]) => ({ path, files: n })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path)).slice(0, 30),
    files: files.length,
  };
}

function addMatches(text: string, names: string[], into: Set<string>, label: (n: string) => string = (n) => n): void {
  for (const name of names) if (text.includes(name)) into.add(label(name));
}

function readPackage(text: string, manifest: string, frameworks: Set<string>, entries: Set<string>): void {
  let pkg: { main?: unknown; bin?: unknown; dependencies?: object; devDependencies?: object };
  try {
    pkg = JSON.parse(text);
  } catch {
    return;
  }
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  for (const name of NPM_FRAMEWORKS) if (deps.has(name)) frameworks.add(name);
  const dir = manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/") + 1) : "";
  const rel = (p: string) => dir + p.replace(/^\.\//, "");
  if (typeof pkg.main === "string") entries.add(rel(pkg.main));
  if (typeof pkg.bin === "string") entries.add(rel(pkg.bin));
  else if (pkg.bin && typeof pkg.bin === "object") for (const v of Object.values(pkg.bin)) if (typeof v === "string") entries.add(rel(v));
}
