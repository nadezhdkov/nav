import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  ApprovalStatus,
  ConciergeMessageRequest,
  CreateConversationRequest,
  CreateRunRequest,
  DecideApprovalRequest,
  DecideProposalRequest,
  StreamClientMessage,
  WebExchangeRequest,
  type StreamServerMessage,
  type WebCode,
  type WebExchangeResponse,
  type NavarchEvent,
  FleetWindow,
  SendRunMessage,
} from "@navarch/contracts";
import { z } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Daemon } from "../daemon.ts";
import { OrchestratorError } from "../orchestrator/orchestrator.ts";
import { ConciergeError } from "../concierge/service.ts";

/** Core API, spec §9.1. Every request needs the local bearer token from `~/.navarch/token`. */
export async function buildServer(daemon: Daemon, token: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    // The Web UI's static files are public; the token reaches the SPA in the URL fragment (ADR 0017).
    if (!isApi(req.url) || req.url === "/api/v1/web/exchange") return;
    const header = req.headers.authorization ?? "";
    const query = (req.query as { token?: string } | undefined)?.token ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : query;
    if (!safeEqual(given, token)) {
      return reply.code(401).send({ error: "unauthorized", message: "missing or invalid token" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConciergeError) {
      const status = err.code === "not_found" ? 404 : err.code === "unavailable" ? 503 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof OrchestratorError) {
      const status =
        err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "forbidden" ? 403 : err.code === "github_error" ? 502 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: status >= 500 ? "internal" : "bad_request", message: (err as Error).message });
  });

  await serveWeb(app, daemon.config.daemon.web_dir ?? DEFAULT_WEB_DIR);

  // `navarch web` opens the UI with a single-use code instead of the token, so the token never
  // shows up in a browser's command line (ADR 0017).
  const codes = new Map<string, number>();
  app.post("/api/v1/web/codes", async (_req, reply) => {
    const now = Date.now();
    for (const [c, expires] of codes) if (expires <= now) codes.delete(c);
    const code = randomBytes(32).toString("base64url");
    codes.set(code, now + WEB_CODE_TTL_MS);
    const body: WebCode = { code, expires_at: new Date(now + WEB_CODE_TTL_MS).toISOString() };
    return reply.code(201).send(body);
  });

  app.post("/api/v1/web/exchange", async (req, reply) => {
    const parsed = WebExchangeRequest.safeParse(req.body);
    const code = parsed.success ? parsed.data.code : undefined;
    const expires = code === undefined ? undefined : codes.get(code);
    if (code !== undefined) codes.delete(code);
    if (expires === undefined || expires <= Date.now()) {
      return reply.code(401).send({ error: "unauthorized", message: "unknown or expired code; run `navarch web` again" });
    }
    const body: WebExchangeResponse = { token };
    return body;
  });

  app.get("/api/v1/health", async () => ({
    ok: true,
    running_tasks: daemon.scheduler.runningCount,
    pid: process.pid,
  }));

  app.get("/api/v1/runs", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    return daemon.store.listRuns(Number.isFinite(limit) ? limit : 50);
  });

  app.post("/api/v1/runs", async (req, reply) => {
    const parsed = CreateRunRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const run = await daemon.orchestrator.startRun(parsed.data, { kind: "user", via: viaOf(req.headers) });
    return reply.code(201).send(run);
  });

  app.get("/api/v1/runs/:id", async (req, reply) => {
    const run = daemon.store.getRunDetail((req.params as { id: string }).id);
    return run ?? notFound(reply, "run");
  });

  app.post("/api/v1/runs/:id/cancel", async (req) => {
    const id = (req.params as { id: string }).id;
    return daemon.orchestrator.cancelRun(id, { kind: "user", via: viaOf(req.headers) }, (taskId) =>
      daemon.scheduler.requestCancel(taskId),
    );
  });

  app.post("/api/v1/runs/:id/resume", async (req) => {
    const id = (req.params as { id: string }).id;
    return daemon.orchestrator.resumeRun(id, { kind: "user", via: viaOf(req.headers) });
  });

  app.get("/api/v1/runs/:id/messages", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!daemon.store.getRun(id)) return notFound(reply, "run");
    return daemon.store.listMessages(id);
  });

  app.post("/api/v1/runs/:id/messages", async (req, reply) => {
    const parsed = SendRunMessage.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const id = (req.params as { id: string }).id;
    const message = daemon.sendRunMessage(id, parsed.data, { kind: "user", via: viaOf(req.headers) });
    return reply.code(201).send(message);
  });

  app.get("/api/v1/fleet", async (req, reply) => {
    const parsed = FleetWindow.safeParse((req.query as { window?: string }).window ?? "active");
    if (!parsed.success) return badRequest(reply, "window must be active or 24h");
    return daemon.store.fleet(parsed.data, (adapter) => daemon.resumable(adapter));
  });

  app.get("/api/v1/approvals", async (req, reply) => {
    const status = (req.query as { status?: string }).status;
    if (status === undefined) return daemon.store.listApprovals();
    const parsed = ApprovalStatus.safeParse(status);
    if (!parsed.success) return badRequest(reply, `unknown status ${status}`);
    return daemon.store.listApprovals(parsed.data);
  });

  app.post("/api/v1/approvals/:id", async (req, reply) => {
    const parsed = DecideApprovalRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const id = (req.params as { id: string }).id;
    return daemon.orchestrator.decideApproval(id, parsed.data.decision, parsed.data.reason, { kind: "user", via: viaOf(req.headers) });
  });

  // Concierge (ADR 0016): act tools only propose; a proposal runs when the operator decides it here.
  app.post("/api/v1/concierge/conversations", async (req, reply) => {
    const parsed = CreateConversationRequest.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return reply.code(201).send(daemon.concierge.create(parsed.data.cwd, viaOf(req.headers)));
  });

  app.post("/api/v1/concierge/conversations/:id/messages", async (req, reply) => {
    const parsed = ConciergeMessageRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return daemon.concierge.send((req.params as { id: string }).id, parsed.data.text, viaOf(req.headers));
  });

  app.post("/api/v1/concierge/conversations/:id/proposals/:pid", async (req, reply) => {
    const parsed = DecideProposalRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const { id, pid } = req.params as { id: string; pid: string };
    return daemon.concierge.decide(id, pid, parsed.data.decision, viaOf(req.headers));
  });

  // Secrets are write-only through the API (ADR 0007): values are never returned.
  app.get("/api/v1/secrets/:name", async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    try {
      return { name, set: await daemon.vault.has(name) };
    } catch (err) {
      return badRequest(reply, (err as Error).message);
    }
  });

  app.put("/api/v1/secrets/:name", async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string") return badRequest(reply, "expected { value: string }");
    try {
      await daemon.vault.set(name, value.trim());
    } catch (err) {
      return badRequest(reply, (err as Error).message);
    }
    return { name, set: true };
  });

  app.get("/api/v1/runs/:id/events", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!daemon.store.getRun(id)) return notFound(reply, "run");
    const after = Number((req.query as { after?: string }).after ?? 0);
    return daemon.store.events({ runId: id, afterSeq: Number.isFinite(after) ? after : 0 });
  });

  app.get("/api/v1/runs/:id/logs", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!daemon.store.getRun(id)) return notFound(reply, "run");
    const dir = join(daemon.home, "logs", id);
    if (!existsSync(dir)) return reply.type("text/plain").send("");
    const taskId = (req.query as { task?: string }).task;
    if (taskId !== undefined && daemon.store.getTask(taskId)?.run_id !== id) return notFound(reply, "task");
    const files = (await readdir(dir)).filter((f) => (taskId === undefined ? f.endsWith(".log") : f === `${taskId}.log`)).sort();
    const parts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
    return reply.type("text/plain").send(parts.join(""));
  });

  app.get("/api/v1/artifacts/:id", async (req, reply) => {
    const artifact = daemon.store.getArtifact((req.params as { id: string }).id);
    if (!artifact) return notFound(reply, "artifact");
    return reply.type("text/plain").send(readFileSync(artifact.uri, "utf8"));
  });

  app.get("/api/v1/stream", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }
    const topics = new Set<string>();
    const send = (msg: StreamServerMessage) => socket.send(JSON.stringify(msg));
    const matches = (runId: string | null) => topics.has("*") || topics.has("runs") || (runId !== null && topics.has(`run:${runId}`));

    const offEvent = daemon.store.subscribe((event: NavarchEvent) => {
      if (matches(event.run_id)) send({ kind: "event", event });
    });
    const offLog = daemon.onLog((runId, taskId, line) => {
      if (topics.has("*") || topics.has(`run:${runId}`)) send({ kind: "log", run_id: runId, task_id: taskId, line });
    });

    socket.on("message", (raw: Buffer) => {
      let msg: StreamClientMessage;
      try {
        msg = StreamClientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        send({ kind: "error", message: "invalid message" });
        return;
      }
      for (const t of msg.subscribe ?? []) topics.add(t);
      for (const t of msg.unsubscribe ?? []) topics.delete(t);
      send({ kind: "subscribed", topics: [...topics] });
    });
    socket.on("close", () => {
      offEvent();
      offLog();
    });
  });

  return app;
}

const WEB_CODE_TTL_MS = 60_000;

const DEFAULT_WEB_DIR = resolve(import.meta.dirname, "../../../web/dist");

/** Same-origin only: no inline scripts, no eval, no framing. Vue sets styles through the CSSOM. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function isApi(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
}

/** Serves the Vite build at `/` with an SPA fallback for client routes (ADR 0017). */
async function serveWeb(app: FastifyInstance, dir: string): Promise<void> {
  const built = existsSync(join(dir, "index.html"));
  app.addHook("onSend", async (req, reply, payload) => {
    if (!isApi(req.url)) {
      reply.header("content-security-policy", CSP);
      reply.header("x-content-type-options", "nosniff");
      reply.header("referrer-policy", "no-referrer");
    }
    return payload;
  });
  // `wildcard` resolves files per request, so a rebuild is served without restarting the daemon.
  if (built) {
    await app.register(fastifyStatic, {
      root: dir,
      prefix: "/",
      wildcard: true,
      index: "index.html",
      setHeaders: (reply, path) => {
        reply.header("cache-control", path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable");
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (isApi(req.url) || req.method !== "GET" || path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) {
      return notFound(reply, "route");
    }
    if (!built) {
      return reply
        .code(503)
        .type("text/plain")
        .send(`The Web UI is not built. Run \`make web-build\` in the Navarch checkout (looked in ${dir}).`);
    }
    return reply.type("text/html").header("cache-control", "no-cache").sendFile("index.html");
  });
}

function viaOf(headers: Record<string, unknown>): "cli" | "web" | "mobile" | "api" {
  const via = headers["x-navarch-client"];
  return via === "cli" || via === "web" || via === "mobile" ? via : "api";
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: "bad_request", message });
}

function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: "not_found", message: `${what} not found` });
}
