import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import websocket from "@fastify/websocket";
import {
  ApprovalStatus,
  CreateRunRequest,
  DecideApprovalRequest,
  StreamClientMessage,
  type StreamServerMessage,
  type VectrEvent,
} from "@vectr/contracts";
import { z } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Daemon } from "../daemon.ts";
import { OrchestratorError } from "../orchestrator/orchestrator.ts";

/** Core API, spec §9.1. Every request needs the local bearer token from `~/.vectr/token`. */
export async function buildServer(daemon: Daemon, token: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const query = (req.query as { token?: string } | undefined)?.token ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : query;
    if (!safeEqual(given, token)) {
      return reply.code(401).send({ error: "unauthorized", message: "missing or invalid token" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof OrchestratorError) {
      const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "github_error" ? 502 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: status >= 500 ? "internal" : "bad_request", message: (err as Error).message });
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
    const files = (await readdir(dir)).filter((f) => f.endsWith(".log")).sort();
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

    const offEvent = daemon.store.subscribe((event: VectrEvent) => {
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

function viaOf(headers: Record<string, unknown>): "cli" | "web" | "mobile" | "api" {
  const via = headers["x-vectr-client"];
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
