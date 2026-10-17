import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SearchHit } from "@navarch/contracts";
import { listFiles, readText } from "./files.ts";

const run = promisify(execFile);

export const MAX_HITS = 100;
const MAX_TEXT = 200;

/** Literal, case-sensitive search over the files git sees; ripgrep when installed, else a Node scan with the same hits. */
export async function searchText(root: string, query: string, opts: { ripgrep?: boolean } = {}): Promise<SearchHit[]> {
  if (!query) return [];
  const files = await listFiles(root);
  const allowed = new Set(files);
  const hits = (opts.ripgrep ?? true) ? await withRipgrep(root, query, allowed) : undefined;
  const found = hits ?? (await scan(root, query, files));
  found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return found.slice(0, MAX_HITS);
}

const cut = (text: string): string => text.trim().slice(0, MAX_TEXT);

async function withRipgrep(root: string, query: string, allowed: Set<string>): Promise<SearchHit[] | undefined> {
  try {
    const { stdout } = await run("rg", ["--json", "--fixed-strings", "--hidden", "--glob", "!.git", "--max-filesize", "512K", "-e", query, "."], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    return parseRipgrep(stdout, allowed);
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    if (e.code === 1) return []; // no matches
    if (e.code === 2 && typeof e.stdout === "string") return parseRipgrep(e.stdout, allowed); // some files unreadable
    return undefined; // not installed or failed
  }
}

function parseRipgrep(stdout: string, allowed: Set<string>): SearchHit[] {
  const out: SearchHit[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.startsWith("{")) continue;
    const msg = JSON.parse(raw) as { type: string; data: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    if (msg.type !== "match") continue;
    const file = msg.data.path?.text?.replace(/^\.\//, "");
    const text = msg.data.lines?.text;
    if (!file || text === undefined || !msg.data.line_number || !allowed.has(file) || text.includes("\0")) continue;
    out.push({ file, line: msg.data.line_number, text: cut(text) });
  }
  return out;
}

async function scan(root: string, query: string, files: string[]): Promise<SearchHit[]> {
  const out: SearchHit[] = [];
  for (const file of files) {
    const text = await readText(root, file);
    if (text === undefined || !text.includes(query)) continue;
    text.split("\n").forEach((line, i) => {
      if (line.includes(query)) out.push({ file, line: i + 1, text: cut(line) });
    });
  }
  return out;
}
