import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A small stateful GitHub REST API: repositories, issues and pull requests, with token checks. */

export type FakeIssue = { title: string; body: string | null; labels: string[]; author: string; pull_request?: boolean };

export type FakeGitHub = {
  apiUrl: string;
  token: string;
  repos: Map<string, { default_branch: string; issues: Map<number, FakeIssue> }>;
  pulls: { repo: string; number: number; head: string; base: string; title: string; body: string; draft: boolean }[];
  requests: { method: string; path: string; authorization: string | undefined }[];
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
      fake.requests.push({ method: req.method ?? "", path, authorization: req.headers.authorization });
      const send = (status: number, body: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.headers.authorization !== `Bearer ${fake.token}`) return send(401, { message: "Bad credentials" });

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
