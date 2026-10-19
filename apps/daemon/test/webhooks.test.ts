import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RelayServer } from "../../relay/src/index.ts";
import { fakeClaude } from "../../../packages/adapters/claude-code/test/fake.ts";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { Vault } from "../src/vault/vault.ts";
import { WebhookService } from "../src/webhooks/service.ts";

const SECRET = "s3cret-for-tests-only";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function service(opts: { secret?: string | null; repos?: string[] } = {}) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const svc = new WebhookService({
    store: {
      append: (e) => {
        events.push(...(e as unknown as typeof events));
        return [];
      },
      listProjects: () => (opts.repos ?? ["acme/app"]).map((repo, i) => ({ id: `prj_${i}`, name: repo, repo, path: `/x/${i}`, added_at: "", removed_at: null, sync_cursor: null, synced_at: null })),
    },
    vault: {
      get: async () => {
        if (secret === null) throw new Error("not set");
        return secret;
      },
      has: async () => secret !== null,
    },
    sync: { inbox: async (id) => void calls.push(`inbox:${id}`), pullRequests: async () => void calls.push("prs"), ci: async () => void calls.push("ci") },
    debounceMs: 5,
  });
  const deliver = (event: string, payload: object, extra: { delivery?: string; signature?: string } = {}) => {
    const body = JSON.stringify(payload);
    return svc.receive({ "x-github-event": event, "x-github-delivery": extra.delivery ?? crypto.randomUUID(), "x-hub-signature-256": extra.signature ?? sign(body) }, Buffer.from(body));
  };
  const settle = () => new Promise((r) => setTimeout(r, 40));
  return { svc, events, calls, deliver, settle };
}

describe("WebhookService", () => {
  it("answers 503 until the secret is stored, and 401 for a bad or missing signature", async () => {
    expect((await service({ secret: null }).deliver("ping", {})).status).toBe(503);
    const t = service();
    expect((await t.deliver("ping", {}, { signature: sign("{}", "other") })).status).toBe(401);
    expect((await t.svc.receive({ "x-github-event": "ping" }, Buffer.from("{}"))).status).toBe(401);
    expect((await t.svc.receive({ "x-hub-signature-256": "sha256=zz" }, Buffer.from("{}"))).status).toBe(401);
    expect((await t.svc.status()).rejected).toBe(3);
    expect(t.events).toEqual([]);
  });

  it("answers a signed ping and ignores events and repositories it does not follow", async () => {
    const t = service();
    expect(await t.deliver("ping", { zen: "x" })).toEqual({ status: 200, message: "pong" });
    expect((await t.deliver("push", { repository: { full_name: "acme/app" } })).message).toBe("ignored");
    expect((await t.deliver("issues", { action: "opened", repository: { full_name: "someone/else" } })).message).toBe("ignored");
    expect((await t.deliver("issues", { action: "opened" })).message).toBe("ignored");
    await t.settle();
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it("an issue event syncs that project's Inbox, in the repository's own case", async () => {
    const t = service();
    expect((await t.deliver("issues", { action: "opened", repository: { full_name: "ACME/App" } })).status).toBe(202);
    await t.settle();
    expect(t.calls).toEqual(["inbox:prj_0"]);
    expect(t.events.map((e) => [e.type, e.payload.event, e.payload.repo])).toEqual([["webhook.received", "issues", "acme/app"]]);
  });

  it("a burst is read once, and only the watchers its events ask for", async () => {
    const t = service();
    const repository = { full_name: "acme/app" };
    await t.deliver("check_suite", { action: "completed", repository });
    await t.deliver("check_run", { action: "completed", repository });
    await t.deliver("pull_request", { action: "closed", repository });
    await t.deliver("check_run", { action: "created", repository }); // not finished: no read
    await t.settle();
    expect([...t.calls].sort()).toEqual(["ci", "prs"]);
    expect((await t.svc.status()).received).toBe(3);
  });

  it("a delivery id is used once, so a replay does nothing", async () => {
    const t = service();
    const payload = { action: "opened", repository: { full_name: "acme/app" } };
    expect((await t.deliver("issues", payload, { delivery: "11111111-aaaa" })).status).toBe(202);
    expect((await t.deliver("issues", payload, { delivery: "11111111-aaaa" })).message).toBe("duplicate");
    await t.settle();
    expect(t.calls).toEqual(["inbox:prj_0"]);
  });

  it("refuses a body over 1 MiB and bad JSON", async () => {
    const t = service();
    expect((await t.svc.receive({}, new Uint8Array(1024 * 1024 + 1))).status).toBe(413);
    const body = "not json";
    expect((await t.svc.receive({ "x-github-event": "issues", "x-github-delivery": "22222222-bbbb", "x-hub-signature-256": sign(body) }, Buffer.from(body))).status).toBe(400);
  });
});

describe("webhooks through the relay", () => {
  const relays: RelayServer[] = [];
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.stop().catch(() => {});
    for (const r of relays.splice(0)) await r.stop().catch(() => {});
  });

  async function start(secret: string | undefined) {
    const relay = await startRelay({ port: 0, hookTimeoutMs: 1_500 });
    relays.push(relay);
    const daemon = new Daemon({
      home: tempHome(),
      config: Config.parse({ daemon: { port: 0, remote: { mode: "relay", relay_url: relay.url } }, routing: { enabled: false }, inbox: { poll_minutes: 0 } }),
      adapters: { "claude-code": fakeClaude("edit").options },
      vault: new Vault({ command: "false", env: secret ? { NAVARCH_SECRET_GITHUB_WEBHOOK_SECRET: secret } : {} }),
    });
    await daemon.start();
    daemons.push(daemon);
    const end = Date.now() + 8_000;
    while (!daemon.relay?.connected) {
      if (Date.now() > end) throw new Error("relay did not connect");
      await new Promise((r) => setTimeout(r, 25));
    }
    const status = await daemon.webhookStatus();
    const post = (body: string, headers: Record<string, string>, url = status.url!) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    return { relay, daemon, status, post };
  }

  it("the daemon checks the signature and the relay passes its answer to GitHub", async () => {
    const t = await start(SECRET);
    expect(t.status.url).toMatch(/\/w\/[A-Za-z0-9_-]{16,}$/);
    expect(t.status).toMatchObject({ configured: true, reachable: true });
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const headers = { "x-github-event": "ping", "x-github-delivery": "33333333-cccc" };
    const ok = await t.post(body, { ...headers, "x-hub-signature-256": sign(body) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ message: "pong" });
    expect((await t.post(body, { ...headers, "x-hub-signature-256": sign(body, "wrong") })).status).toBe(401);
    expect((await t.post(body, headers)).status).toBe(401);
    expect(await t.daemon.webhookStatus()).toMatchObject({ rejected: 2 });
  });

  it("answers 503 when the secret is not stored, and when the daemon is offline", async () => {
    const t = await start(undefined);
    expect(t.status.configured).toBe(false);
    const body = "{}";
    const res = await t.post(body, { "x-github-event": "ping", "x-hub-signature-256": sign(body) });
    expect(res.status).toBe(503);
    await t.daemon.stop();
    expect((await t.post(body, {})).status).toBe(503);
    expect((await t.post(body, {}, `${t.relay.url}/w/not-a-registered-id-0000`)).status).toBe(503);
  });

  it("the relay refuses a body over its limit", async () => {
    const relay = await startRelay({ port: 0, maxHookBytes: 1024 });
    relays.push(relay);
    const res = await fetch(`${relay.url}/w/abcdefghijklmnopqrstuvwx`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(2048) });
    expect(res.status).toBe(413);
  });
});
