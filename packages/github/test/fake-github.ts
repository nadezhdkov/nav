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

/** A pull request `GET /repos/:repo/pulls/:n` reads (ADR 0032). */
export type FakePull = {
  title: string;
  body: string | null;
  author: string;
  labels?: string[];
  head_ref: string;
  head_sha: string;
  /** Defaults to the pull request's own repository. */
  head_repo?: string;
  base_ref: string;
  base_sha: string;
  draft?: boolean;
  state?: "open" | "closed";
  merged?: boolean;
  /** The commit a merged pull request left on its base branch. */
  merge_commit_sha?: string;
  closed_at?: string;
};

/** A check run of a commit; `log` is a GitHub Actions job's log. */
export type FakeCheck = { id: number; name: string; conclusion: string | null; /** Defaults to completed. */ status?: string; actions?: boolean; log?: string; output?: { title?: string; summary?: string; text?: string } };

/** A repository as `GET /user/repos` lists it. */
export type FakeUserRepo = { full_name: string; private: boolean; description?: string | null; default_branch?: string; pushed_at?: string; push?: boolean };

export type FakeGitHub = {
  apiUrl: string;
  token: string;
  /** What `GET /user/repos` lists, in this order. */
  userRepos: FakeUserRepo[];
  repos: Map<string, { default_branch: string; issues: Map<number, FakeIssue> }>;
  pulls: { repo: string; number: number; head: string; base: string; title: string; body: string; draft: boolean }[];
  /** Pull requests to read, by `owner/name#N`. */
  pullRequests: Map<string, FakePull>;
  /** `ahead_by` of `GET /repos/:repo/compare/<base>...<head>`, by `owner/name:<base>...<head>`. */
  compares: Map<string, number>;
  /** Check runs by head commit. */
  checks: Map<string, FakeCheck[]>;
  reviews: { repo: string; number: number; id: number; commit_id: string; body: string; event: string; comments: { path: string; line: number; side?: string; body: string }[] }[];
  comments: { repo: string; number: number; id: number; body: string }[];
  requests: { method: string; path: string; authorization: string | undefined; query?: string; status?: number }[];
  /** When set, every request gets a 403 rate-limit answer resetting at this epoch second. */
  rateLimitedUntil?: number;
  close: () => Promise<void>;
};

export async function fakeGitHub(token = "github_pat_fake0123456789"): Promise<FakeGitHub> {
  const fake: Omit<FakeGitHub, "apiUrl" | "close"> = { token, userRepos: [], repos: new Map(), pulls: [], pullRequests: new Map(), compares: new Map(), checks: new Map(), reviews: [], comments: [], requests: [] };
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

      if (req.method === "GET" && path === "/user/repos") {
        const per = Number(query.get("per_page") ?? 30);
        const page = Number(query.get("page") ?? 1);
        const rows = fake.userRepos.slice((page - 1) * per, page * per).map((r) => ({
          full_name: r.full_name,
          name: r.full_name.split("/")[1],
          owner: { login: r.full_name.split("/")[0] },
          private: r.private,
          description: r.description ?? null,
          default_branch: r.default_branch ?? "main",
          pushed_at: r.pushed_at ?? "2026-01-01T00:00:00Z",
          permissions: { admin: false, push: r.push ?? true, pull: true },
        }));
        return send(200, rows);
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
      const pull = /^\/pulls\/(\d+)(\/reviews)?$/.exec(rest);
      if (pull) {
        const n = Number(pull[1]);
        const found = fake.pullRequests.get(`${name}#${n}`);
        if (!found) return send(404, { message: "Not Found" });
        if (req.method === "GET" && !pull[2]) {
          return send(200, {
            number: n,
            html_url: `${base}/pull/${n}`,
            title: found.title,
            body: found.body,
            labels: (found.labels ?? []).map((l) => ({ name: l })),
            user: { login: found.author },
            state: found.state ?? "open",
            draft: found.draft ?? false,
            merged: found.merged ?? false,
            merge_commit_sha: found.merge_commit_sha ?? null,
            merged_at: found.merged ? (found.closed_at ?? "2026-01-02T00:00:00Z") : null,
            closed_at: found.state === "closed" ? (found.closed_at ?? "2026-01-02T00:00:00Z") : null,
            head: { ref: found.head_ref, sha: found.head_sha, repo: { full_name: found.head_repo ?? name } },
            base: { ref: found.base_ref, sha: found.base_sha, repo: { full_name: name } },
          });
        }
        if (req.method === "GET") return send(200, fake.reviews.filter((r) => r.repo === name && r.number === n).map((r) => ({ id: r.id, body: r.body, html_url: `${base}/pull/${n}#pullrequestreview-${r.id}` })));
        if (req.method === "POST") {
          const body = JSON.parse(raw) as { commit_id: string; body: string; event: string; comments?: { path: string; line: number; side?: string; body: string }[] };
          const id = 500 + fake.reviews.length;
          fake.reviews.push({ repo: name, number: n, id, commit_id: body.commit_id, body: body.body, event: body.event, comments: body.comments ?? [] });
          return send(200, { id, html_url: `${base}/pull/${n}#pullrequestreview-${id}` });
        }
      }
      const comments = /^\/issues\/(\d+)\/comments$/.exec(rest);
      if (comments) {
        const n = Number(comments[1]);
        if (req.method === "GET") return send(200, fake.comments.filter((c) => c.repo === name && c.number === n).map((c) => ({ id: c.id, body: c.body, html_url: `${base}/pull/${n}#issuecomment-${c.id}` })));
        const body = JSON.parse(raw) as { body: string };
        const id = 900 + fake.comments.length;
        fake.comments.push({ repo: name, number: n, id, body: body.body });
        return send(201, { id, html_url: `${base}/pull/${n}#issuecomment-${id}` });
      }
      const compare = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest);
      if (req.method === "GET" && compare) {
        const ahead = fake.compares.get(`${name}:${compare[1]}...${compare[2]}`);
        return ahead === undefined ? send(404, { message: "Not Found" }) : send(200, { status: ahead ? "ahead" : "identical", ahead_by: ahead, behind_by: 0 });
      }
      const checkRuns = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest);
      if (req.method === "GET" && checkRuns) {
        const runs = (fake.checks.get(checkRuns[1]!) ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status ?? "completed",
          conclusion: c.conclusion,
          html_url: `${base}/runs/${c.id}`,
          app: { slug: c.actions ? "github-actions" : "other-ci" },
          output: { title: c.output?.title ?? null, summary: c.output?.summary ?? null, text: c.output?.text ?? null },
        }));
        return send(200, { total_count: runs.length, check_runs: runs });
      }
      const jobLogs = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest);
      if (req.method === "GET" && jobLogs) {
        const check = [...fake.checks.values()].flat().find((c) => c.id === Number(jobLogs[1]));
        if (!check?.log) return send(410, { message: "Gone" });
        logged.status = 200;
        return void res.writeHead(200, { "content-type": "text/plain" }).end(check.log);
      }
      if (req.method === "GET" && rest === "/pulls" && query.get("state") === "open" && !query.get("head")) {
        const open = [...fake.pullRequests].filter(([key, p]) => key.startsWith(`${name}#`) && (p.state ?? "open") === "open");
        return send(
          200,
          open.map(([key, p]) => ({
            number: Number(key.split("#")[1]),
            html_url: `${base}/pull/${key.split("#")[1]}`,
            title: p.title,
            draft: p.draft ?? false,
            user: { login: p.author },
            head: { ref: p.head_ref, sha: p.head_sha, repo: { full_name: p.head_repo ?? name } },
          })),
        );
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
