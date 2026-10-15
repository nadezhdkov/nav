import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A small stateful GitHub REST API: repositories, issues and pull requests, with token checks. */

export type FakeIssue = {
  title: string;
  body: string | null;
  labels: string[];
  author: string;
  pull_request?: boolean;
  state?: "open" | "closed";
  /** ISO 8601; defaults to 2026-01-01. */
  updated_at?: string;
};

export type FakeGitHub = {
  apiUrl: string;
  token: string;
  repos: Map<string, { default_branch: string; issues: Map<number, FakeIssue> }>;
  pulls: { repo: string; number: number; head: string; base: string; title: string; body: string; draft: boolean }[];
  requests: { method: string; path: string; authorization: string | undefined; query?: string; status?: number }[];
  /** When set, every request gets a 403 rate-limit answer resetting at this epoch second. */
  rateLimitedUntil?: number;
  close: () => Promise<void>;
};

export async function fakeGitHub(token = "github_pat_fake0123456789"): Promise<FakeGitHub> {
  const fake: Omit<FakeGitHub, "apiUrl" | "close"> = { token, repos: new Map(), pulls: [], requests: [] };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const [path = "", search = ""] = (req.url ?? "").split("?");
      const query = new URLSearchParams(search);
      const logged: FakeGitHub["requests"][number] = { method: req.method ?? "", path, authorization: req.headers.authorization, query: search };
      fake.requests.push(logged);
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        logged.status = status;
        res.writeHead(status, { "content-type": "application/json", ...headers }).end(status === 304 ? undefined : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${fake.token}`) return send(401, { message: "Bad credentials" });
      if (fake.rateLimitedUntil) {
        return send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(fake.rateLimitedUntil) });
      }

      const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
      const repo = repoMatch && fake.repos.get(repoMatch[1]!);
      if (!repoMatch || !repo) return send(404, { message: "Not Found" });
      const name = repoMatch[1]!;
      const rest = repoMatch[2] ?? "";
      const base = `https://github.com/${name}`;

      if (req.method === "GET" && rest === "") return send(200, { full_name: name, default_branch: repo.default_branch });
      const issue = /^\/issues\/(\d+)$/.exec(rest);
      if (req.method === "GET" && issue) {
        const n = Number(issue[1]);
        const found = repo.issues.get(n);
        if (!found) return send(404, { message: "Not Found" });
        return send(200, {
          number: n,
          html_url: `${base}/issues/${n}`,
          title: found.title,
          body: found.body,
          labels: found.labels.map((l) => ({ name: l })),
          user: { login: found.author },
          ...(found.pull_request ? { pull_request: { url: `${base}/pull/${n}` } } : {}),
        });
      }
      if (req.method === "GET" && rest === "/issues") {
        const state = query.get("state") ?? "open";
        const since = query.get("since");
        const perPage = Number(query.get("per_page") ?? 30);
        const page = Number(query.get("page") ?? 1);
        const all = [...repo.issues.entries()]
          .map(([n, i]) => ({ n, i, updated: i.updated_at ?? "2026-01-01T00:00:00Z", st: i.state ?? "open" }))
          .filter((x) => (state === "all" || x.st === state) && (!since || x.updated >= since))
          .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : b.n - a.n));
        const rows = all.slice((page - 1) * perPage, page * perPage).map(({ n, i, updated, st }) => ({
          number: n,
          html_url: `${base}/issues/${n}`,
          title: i.title,
          body: i.body,
          labels: i.labels.map((l) => ({ name: l })),
          user: { login: i.author },
          state: st,
          updated_at: updated,
          ...(i.pull_request ? { pull_request: { url: `${base}/pull/${n}` } } : {}),
        }));
        const etag = `"${createHash("sha1").update(JSON.stringify(rows)).digest("hex")}"`;
        if (req.headers["if-none-match"] === etag) return send(304, undefined, { etag });
        return send(200, rows, { etag });
      }
      if (req.method === "GET" && rest === "/pulls") {
        const head = query.get("head")?.split(":")[1];
        return send(
          200,
          fake.pulls.filter((p) => p.repo === name && (!head || p.head === head)).map((p) => ({ number: p.number, html_url: `${base}/pull/${p.number}` })),
        );
      }
      if (req.method === "POST" && rest === "/pulls") {
        const body = JSON.parse(raw) as { head: string; base: string; title: string; body: string; draft?: boolean };
        if (fake.pulls.some((p) => p.repo === name && p.head === body.head)) {
          return send(422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for ${body.head}.` }] });
        }
        const number = 100 + fake.pulls.length;
        fake.pulls.push({ repo: name, number, head: body.head, base: body.base, title: body.title, body: body.body, draft: body.draft ?? false });
        return send(201, { number, html_url: `${base}/pull/${number}`, draft: body.draft ?? false });
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    apiUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
