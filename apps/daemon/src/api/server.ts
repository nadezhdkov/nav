import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  FlowRevisionRequest,
  SaveFlowDraftRequest,
  SimulationRequest,
  ValidateFlowRequest,
  ApprovalStatus,
  SymbolKind,
  ConciergeMessageRequest,
  CreateConversationRequest,
  CreateRunRequest,
  DecideApprovalRequest,
  DecideProposalRequest,
  StreamClientMessage,
  WebExchangeRequest,
  PairDeviceRequest,
  PushSubscriptionRequest,
  RefreshDeviceRequest,
  type Actor,
  type DeviceSession,
  type PushKey,
  type StopResult,
  type StreamServerMessage,
  type WebCode,
  type WorktreeStatus,
  type WebExchangeResponse,
  type NavarchEvent,
  FleetWindow,
  SendRunMessage,
  CloneRepoRequest,
  CreateProjectRequest,
  DismissItemRequest,
  FixCiFailureRequest,
  CiFailureStatus,
  StartInboxRequest,
  SyncInboxRequest,
  SetAwayRequest,
  AddPrincipleRequest,
  SetBudgetRequest,
  WorkItemStatus,
  type SpecAddendumRunView,
  type SpecRunView,
  type SyncInboxResult,
} from "@navarch/contracts";
import { findSymbols, indexSymbols, repoMap, searchText } from "@navarch/explorer";
import { compileContext, searchSpecs } from "@navarch/knowledge";
import { worktreeFileDiff, worktreeStatus } from "@navarch/runner";
import { FlowStudioError } from "../flows/library.ts";
import { z } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Daemon } from "../daemon.ts";
import { OrchestratorError } from "../orchestrator/orchestrator.ts";
import { ownsWorktree } from "../orchestrator/worktrees.ts";
import { ConciergeError } from "../concierge/service.ts";
import { DeviceError } from "../devices/devices.ts";
import { InboxError } from "../inbox/service.ts";
import { isRunName } from "../orchestrator/names.ts";
import { AwayError } from "../away/service.ts";
import { PrinciplesError } from "../principles/service.ts";
import { BudgetError } from "../budgets/budgets.ts";
import { CiError } from "../github/ci.ts";

/** Core API, spec §9.1. Every request needs the local bearer token from `~/.navarch/token`. */
export async function buildServer(daemon: Daemon, token: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const callers = new WeakMap<FastifyRequest, Caller>();
  const callerOf = (req: FastifyRequest): Caller => callers.get(req) ?? { kind: "local" };
  const actorOf = (req: FastifyRequest): Actor => {
    const caller = callerOf(req);
    return caller.kind === "device" ? { kind: "user", via: "mobile", device_id: caller.deviceId } : { kind: "user", via: viaOf(req.headers) };
  };
  await app.register(websocket);

  // Who is calling: the local token (CLI, desktop UI) or a paired device's access token (ADR 0020).
  // `tailscale serve` makes remote requests look local, so the source address proves nothing.
  app.addHook("onRequest", async (req, reply) => {
    // The Web UI's static files are public; the token reaches the SPA in the URL fragment (ADR 0017).
    if (!isApi(req.url) || PUBLIC_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) return;
    const header = req.headers.authorization ?? "";
    const query = (req.query as { token?: string } | undefined)?.token ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : query;
    if (safeEqual(given, token)) {
      callers.set(req, { kind: "local" });
      return;
    }
    const deviceId = daemon.devices.authenticate(given);
    if (!deviceId) return reply.code(401).send({ error: "unauthorized", message: "missing or invalid token" });
    if (!DEVICE_ROUTES.has(`${req.method} ${req.routeOptions.url}`)) {
      return reply.code(403).send({ error: "forbidden", message: "not available from a paired device; use the desktop" });
    }
    callers.set(req, { kind: "device", deviceId });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PrinciplesError) {
      const status = err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ConciergeError) {
      const status = err.code === "not_found" ? 404 : err.code === "unavailable" ? 503 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof FlowStudioError) {
      const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "forbidden" ? 403 : 400;
      return reply.code(status).send({ error: err.code, message: err.message, ...(err.problems.length ? { problems: err.problems } : {}) });
    }
    if (err instanceof CiError) return reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.code, message: err.message });
    if (err instanceof BudgetError) return reply.code(404).send({ error: err.code, message: err.message });
    if (err instanceof InboxError) {
      const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "forbidden" ? 403 : err.code === "github_error" ? 502 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof DeviceError) {
      const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 401;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof OrchestratorError) {
      const status =
        err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "forbidden" || err.code === "push_denied" ? 403 : err.code === "github_error" ? 502 : 400;
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

  // Remote access and paired devices (ADR 0020). Pairing and the device list stay on the desktop.
  // A run's codename works wherever its id does (ADR 0027): `/api/v1/runs/brave-frigate/…`.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.routeOptions.url?.startsWith("/api/v1/runs/:id")) return;
    const params = req.params as { id: string };
    if (!isRunName(params.id)) return;
    const id = daemon.store.runIdByName(params.id);
    if (!id) return reply.code(404).send({ error: "not_found", message: `no run named ${params.id}` });
    params.id = id;
  });

  app.get("/api/v1/remote", async () => daemon.remoteStatus());

  app.post("/api/v1/devices/pairings", async (_req, reply) => {
    const remote = await daemon.remoteStatus();
    if (remote.mode === "off" || !remote.url) {
      return reply.code(409).send({ error: "conflict", message: "remote access is off or no tailnet URL is known; see `navarch remote status`" });
    }
    return reply.code(201).send(daemon.devices.createPairing(remote.url));
  });

  app.post("/api/v1/devices/pair", async (req, reply) => {
    const parsed = PairDeviceRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const session: DeviceSession = daemon.devices.pair(parsed.data.code, parsed.data.name);
    return reply.code(201).send(session);
  });

  app.post("/api/v1/devices/refresh", async (req, reply) => {
    const parsed = RefreshDeviceRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const session: DeviceSession = daemon.devices.refresh(parsed.data.refresh_token);
    return session;
  });

  app.get("/api/v1/devices", async () => daemon.devices.list());

  app.get("/api/v1/devices/me", async (req, reply) => {
    const caller = callerOf(req);
    if (caller.kind !== "device") return badRequest(reply, "only a paired device has a device of its own");
    return daemon.devices.get(caller.deviceId);
  });

  app.delete("/api/v1/devices/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const caller = callerOf(req);
    if (caller.kind === "device" && caller.deviceId !== id) return forbidden(reply, "a device can only revoke itself");
    return daemon.devices.revoke(id, actorOf(req), caller.kind === "device" ? "signed out on the device" : "revoked by the user");
  });

  app.get("/api/v1/push/key", async () => {
    const body: PushKey = { public_key: daemon.notifier.publicKey };
    return body;
  });

  app.put("/api/v1/push/subscription", async (req, reply) => {
    const caller = callerOf(req);
    if (caller.kind !== "device") return badRequest(reply, "push subscriptions belong to paired devices");
    const parsed = PushSubscriptionRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const refused = daemon.notifier.checkEndpoint(parsed.data.endpoint);
    if (refused) return badRequest(reply, refused);
    daemon.devices.setSubscription(caller.deviceId, parsed.data, actorOf(req));
    return reply.code(204).send();
  });

  app.delete("/api/v1/push/subscription", async (req, reply) => {
    const caller = callerOf(req);
    if (caller.kind !== "device") return badRequest(reply, "push subscriptions belong to paired devices");
    daemon.devices.clearSubscription(caller.deviceId, actorOf(req));
    return reply.code(204).send();
  });

  app.get("/api/v1/repos", async () => daemon.store.listRepos());

  // Projects and the Inbox (ADR 0021).
  app.get("/api/v1/projects", async () => daemon.inbox.listProjects());

  app.post("/api/v1/projects", async (req, reply) => {
    const parsed = CreateProjectRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return reply.code(201).send(await daemon.inbox.addProject(parsed.data, actorOf(req)));
  });

  // Repository exploration (ADR 0042): read-only, from the project's clone.
  const explore = async <T>(req: { params: unknown }, reply: FastifyReply, fn: (root: string) => Promise<T>) => {
    const project = daemon.store.getProject((req.params as { id: string }).id);
    return project ? fn(project.path) : notFound(reply, "project");
  };
  app.get("/api/v1/projects/:id/map", (req, reply) => explore(req, reply, (root) => repoMap(root)));
  app.get("/api/v1/projects/:id/symbols", (req, reply) => {
    const q = req.query as { q?: string; kind?: string };
    const kind = q.kind === undefined ? undefined : SymbolKind.safeParse(q.kind);
    if (!q.q) return badRequest(reply, "q is required");
    if (kind && !kind.success) return badRequest(reply, `kind must be one of ${SymbolKind.options.join(", ")}`);
    return explore(req, reply, async (root) => findSymbols(await indexSymbols(root), q.q!, kind?.data ? { kind: kind.data } : {}));
  });
  app.get("/api/v1/projects/:id/search", (req, reply) => {
    const q = (req.query as { q?: string }).q;
    if (!q) return badRequest(reply, "q is required");
    return explore(req, reply, (root) => searchText(root, q));
  });

  // What the MCP server serves besides the above (ADR 0046): the compiled context of a goal and the project's specs.
  app.get("/api/v1/projects/:id/context", (req, reply) => {
    const task = (req.query as { task?: string }).task;
    if (!task) return badRequest(reply, "task is required");
    return explore(req, reply, async (root) => (await compileContext({ root, task })) ?? { text: "", sources: [], chars: 0, est_tokens: 0, max_tokens: 4000, ms: 0 });
  });
  app.get("/api/v1/projects/:id/specs", (req, reply) => {
    const q = (req.query as { q?: string }).q;
    if (!q) return badRequest(reply, "q is required");
    return explore(req, reply, (root) => searchSpecs(root, q));
  });

  // Project rules (ADR 0047): devices may read them; only the desktop and the CLI change them.
  app.get("/api/v1/projects/:id/principles", async (req) => daemon.principles.view((req.params as { id: string }).id));

  app.post("/api/v1/projects/:id/principles", async (req, reply) => {
    if (callerOf(req).kind === "device") return forbidden(reply, "a paired device cannot change a project's rules");
    const parsed = AddPrincipleRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return reply.code(201).send(daemon.principles.add((req.params as { id: string }).id, parsed.data, actorOf(req)));
  });

  app.delete("/api/v1/projects/:id/principles/:principle", async (req, reply) => {
    if (callerOf(req).kind === "device") return forbidden(reply, "a paired device cannot change a project's rules");
    const params = req.params as { id: string; principle: string };
    daemon.principles.remove(params.id, params.principle, actorOf(req));
    return reply.code(204).send();
  });

  // GitHub repositories for New run (ADR 0026): desktop only, never paired devices.
  app.get("/api/v1/github/repos", async (req) => daemon.inbox.listGitHubRepos(Boolean((req.query as { refresh?: string }).refresh)));

  app.post("/api/v1/github/repos/clone", async (req, reply) => {
    const parsed = CloneRepoRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    const { project, created } = await daemon.inbox.cloneProject(parsed.data, actorOf(req));
    return reply.code(created ? 201 : 200).send(project);
  });

  app.delete("/api/v1/projects/:id", async (req, reply) => {
    daemon.inbox.removeProject((req.params as { id: string }).id, actorOf(req));
    return reply.code(204).send();
  });

  app.get("/api/v1/inbox", async (req, reply) => {
    const q = req.query as { project?: string; status?: string };
    const status = q.status ? z.array(WorkItemStatus).safeParse(q.status.split(",")) : undefined;
    if (status && !status.success) return badRequest(reply, "status must be a comma-separated list of new, triaged, in_run, done, dismissed, closed");
    return daemon.inbox.list({ ...(q.project ? { projectId: q.project } : {}), ...(status?.data ? { status: status.data } : {}) });
  });

  app.get("/api/v1/inbox/:id", async (req) => daemon.inbox.get((req.params as { id: string }).id));

  app.post("/api/v1/inbox/sync", async (req, reply) => {
    const parsed = SyncInboxRequest.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    // A sync also reads what became of Navarch's open pull requests (ADR 0037) and their failing checks (ADR 0041).
    const [results] = await Promise.all([daemon.inbox.sync(parsed.data.project_id, actorOf(req)), daemon.prs.check(), daemon.ci.check()]);
    const result: SyncInboxResult = { results };
    return result;
  });

  app.post("/api/v1/inbox/start", async (req, reply) => {
    const parsed = StartInboxRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    // A phone starts runs with the daemon's defaults, as for prompt runs (ADR 0020, 0021).
    if (callerOf(req).kind === "device" && (parsed.data.flow || parsed.data.budget)) return forbidden(reply, "a paired device cannot set flow or budget");
    return daemon.inbox.startRuns(parsed.data, actorOf(req));
  });

  app.post("/api/v1/inbox/:id/dismiss", async (req, reply) => {
    const parsed = DismissItemRequest.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return daemon.inbox.dismiss((req.params as { id: string }).id, parsed.data.reason, actorOf(req));
  });

  app.post("/api/v1/inbox/:id/restore", async (req) => daemon.inbox.restore((req.params as { id: string }).id, actorOf(req)));

  // CI failures noticed on open pull requests (ADR 0041). A phone may read them; starting a fix is desktop only.
  app.get("/api/v1/ci/failures", async (req, reply) => {
    const status = (req.query as { status?: string }).status;
    const parsed = status ? CiFailureStatus.safeParse(status) : undefined;
    if (parsed && !parsed.success) return badRequest(reply, "status must be open, started, dismissed or resolved");
    return daemon.ci.list(parsed?.data ?? (status === undefined ? "open" : undefined));
  });

  app.post("/api/v1/ci/failures/:id/fix", async (req, reply) => {
    const parsed = FixCiFailureRequest.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return daemon.ci.fix((req.params as { id: string }).id, parsed.data, actorOf(req));
  });

  app.post("/api/v1/ci/failures/:id/dismiss", async (req) => daemon.ci.dismiss((req.params as { id: string }).id, actorOf(req)));

  app.get("/api/v1/quotas", async () => daemon.store.quotas());

  // Budgets and observed metrics (ADR 0023). Devices may read them; only the user sets budgets.
  app.get("/api/v1/usage", async (req, reply) => {
    const q = req.query as { days?: string; profile?: string };
    const days = q.days === undefined ? 30 : Number(q.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) return badRequest(reply, "days must be a whole number from 1 to 90");
    return daemon.usage({ days, ...(q.profile ? { profile: q.profile } : {}) });
  });

  // The cost and quality panels (ADR 0037); devices may read them too.
  app.get("/api/v1/metrics", async (req, reply) => {
    const q = req.query as { days?: string };
    const days = q.days === undefined ? 30 : Number(q.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) return badRequest(reply, "days must be a whole number from 1 to 365");
    return daemon.metrics({ days });
  });

  // Specs written by reverse-spec runs, with their coverage (ADR 0045); devices may read them.
  app.get("/api/v1/specs", async (): Promise<SpecRunView[]> =>
    daemon.store.eventsOfType("spec.generated", 20).map((e) => ({
      ...(e.payload as NavarchEvent<"spec.generated">["payload"]),
      run_id: e.run_id ?? "",
      run_name: e.run_id ? (daemon.store.getRun(e.run_id)?.name ?? null) : null,
      ts: e.ts,
    })),
  );

  // Addenda written by spec-sync runs (ADR 0053); devices may read them too.
  app.get("/api/v1/specs/addenda", async (): Promise<SpecAddendumRunView[]> =>
    daemon.store.eventsOfType("spec.addendum.written", 20).map((e) => ({
      ...(e.payload as NavarchEvent<"spec.addendum.written">["payload"]),
      run_id: e.run_id ?? "",
      run_name: e.run_id ? (daemon.store.getRun(e.run_id)?.name ?? null) : null,
      ts: e.ts,
    })),
  );

  // Away mode (ADR 0039): paired phones may read it, to show the banner; only the desktop and the CLI change it.
  app.get("/api/v1/away", async () => daemon.away.view());

  app.put("/api/v1/away", async (req, reply) => {
    if (callerOf(req).kind === "device") return forbidden(reply, "a paired device cannot change Away mode");
    const parsed = SetAwayRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    try {
      return daemon.away.set(parsed.data, actorOf(req));
    } catch (err) {
      if (err instanceof AwayError) return err.code === "forbidden" ? forbidden(reply, err.message) : badRequest(reply, err.message);
      throw err;
    }
  });

  app.get("/api/v1/budgets", async () => daemon.budgets.views());

  app.put("/api/v1/budgets", async (req, reply) => {
    if (callerOf(req).kind === "device") return forbidden(reply, "a paired device cannot set budgets");
    const parsed = SetBudgetRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    daemon.setBudget(parsed.data, actorOf(req));
    return daemon.budgets.views();
  });

  // Flow Studio (ADR 0033): desktop only, never in DEVICE_ROUTES.
  app.get("/api/v1/flows", async () => daemon.flows.list());
  app.get("/api/v1/flows/catalog", async () => daemon.flows.catalog());

  app.post("/api/v1/flows/validate", async (req, reply) => {
    const parsed = ValidateFlowRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return { problems: daemon.flows.check(parsed.data.yaml, parsed.data.name).problems };
  });

  app.post("/api/v1/flows/simulate", async (req, reply) => {
    const parsed = SimulationRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return daemon.flows.simulate(parsed.data);
  });

  app.get("/api/v1/flows/:name", async (req) => daemon.flows.detail((req.params as { name: string }).name));

  app.get("/api/v1/flows/:name/versions/:version", async (req, reply) => {
    const { name, version } = req.params as { name: string; version: string };
    if (!/^[1-9]\d*$/.test(version)) return badRequest(reply, "version must be a positive whole number");
    return { name, version: Number(version), yaml: daemon.flows.versionYaml(name, Number(version)) };
  });

  app.put("/api/v1/flows/:name/draft", async (req, reply) => {
    const parsed = SaveFlowDraftRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return daemon.flows.saveDraft((req.params as { name: string }).name, parsed.data, actorOf(req));
  });

  app.delete("/api/v1/flows/:name/draft", async (req, reply) => {
    const parsed = FlowRevisionRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return { flow: daemon.flows.discardDraft((req.params as { name: string }).name, parsed.data.revision, actorOf(req)) };
  });

  app.post("/api/v1/flows/:name/publish", async (req, reply) => {
    const parsed = FlowRevisionRequest.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, z.prettifyError(parsed.error));
    return daemon.flows.publish((req.params as { name: string }).name, parsed.data.revision, actorOf(req));
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
    if (callerOf(req).kind === "device") {
      // A phone starts prompt runs in known repositories only, with the daemon's defaults: no
      // commands, setup steps, adapters or budgets it could widen (ADR 0020).
      const extra = Object.keys(parsed.data).filter((k) => k !== "repo_path" && k !== "prompt");
      if (extra.length || parsed.data.issue) return forbidden(reply, `a paired device cannot set ${extra.join(", ") || "issue"}`);
      const known = [...daemon.store.listRepos().map((r) => r.path), ...daemon.store.listProjects().map((p) => p.path)];
      if (!known.includes(parsed.data.repo_path)) {
        return forbidden(reply, "a paired device can start runs only in registered projects or repositories of earlier runs");
      }
    }
    const run = await daemon.orchestrator.startRun(parsed.data, actorOf(req));
    return reply.code(201).send(run);
  });

  app.get("/api/v1/runs/:id", async (req, reply) => {
    const run = daemon.store.getRunDetail((req.params as { id: string }).id);
    return run ?? notFound(reply, "run");
  });

  app.post("/api/v1/runs/:id/cancel", async (req) => {
    const id = (req.params as { id: string }).id;
    return daemon.orchestrator.cancelRun(id, actorOf(req), (taskId) =>
      daemon.scheduler.requestCancel(taskId),
    );
  });

  app.post("/api/v1/runs/:id/resume", async (req) => {
    const id = (req.params as { id: string }).id;
    return daemon.orchestrator.resumeRun(id, actorOf(req));
  });

  app.post("/api/v1/runs/:id/pause", async (req) => {
    const id = (req.params as { id: string }).id;
    return daemon.pauseRun(id, actorOf(req));
  });

  // The kill switch (spec §6.12.4): pauses every active run; nothing is cancelled.
  app.post("/api/v1/stop", async (req) => {
    const body: StopResult = { paused: daemon.stopAll(actorOf(req)) };
    return body;
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
    const message = daemon.sendRunMessage(id, parsed.data, actorOf(req));
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
    return daemon.orchestrator.decideApproval(id, parsed.data.decision, parsed.data.reason, actorOf(req), parsed.data.choice);
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

  // The run's worktree, read-only (slice 10): changed files since the base commit, and one file's
  // diff. Only a path already in the status list reaches git, after `--`. With `task`, that task's
  // worktree: a parallel team member's own, measured from where it forked (ADR 0029).
  const worktreeOf = async (runId: string, taskId?: string): Promise<WorktreeStatus | "no_task" | undefined> => {
    const run = daemon.store.getRun(runId);
    if (!run) return undefined;
    const records = daemon.store.taskRecordsOfRun(run.id);
    const named = taskId === undefined ? undefined : records.find((t) => t.id === taskId);
    if (taskId !== undefined && !named) return "no_task";
    const task = named?.sandbox_path ? named : records.find((t) => t.sandbox_path && !ownsWorktree(t)) ?? records.filter((t) => t.sandbox_path).at(-1);
    const path = task?.sandbox_path ?? null;
    const forked = task && ownsWorktree(task)
      ? (daemon.store.events({ runId: run.id }).filter((e) => e.type === "sandbox.created" && e.task_id === task.id).at(-1)?.payload as { base_commit?: string } | undefined)?.base_commit
      : undefined;
    const baseCommit = forked ?? run.base_commit;
    const empty = { files: [], totals: { files: 0, added: 0, removed: 0 } };
    const base = { run_id: run.id, branch: task?.branch ?? null, path, base_commit: baseCommit };
    if (!path || !existsSync(join(path, ".git"))) return { ...base, exists: false, ...empty };
    return { ...base, exists: true, ...(await worktreeStatus(path, baseCommit)) };
  };

  app.get("/api/v1/runs/:id/worktree", async (req, reply) => {
    const status = await worktreeOf((req.params as { id: string }).id, (req.query as { task?: string }).task);
    if (status === "no_task") return notFound(reply, "task");
    return status ?? notFound(reply, "run");
  });

  app.get("/api/v1/runs/:id/worktree/diff", async (req, reply) => {
    const status = await worktreeOf((req.params as { id: string }).id, (req.query as { task?: string }).task);
    if (status === "no_task") return notFound(reply, "task");
    if (!status) return notFound(reply, "run");
    const wanted = (req.query as { path?: string }).path;
    const file = status.files.find((f) => f.path === wanted);
    if (!file || !status.path) return notFound(reply, "file");
    return reply.type("text/plain").send(await worktreeFileDiff(status.path, status.base_commit, file));
  });

  app.get("/api/v1/artifacts/:id", async (req, reply) => {
    const artifact = daemon.store.getArtifact((req.params as { id: string }).id);
    if (!artifact) return notFound(reply, "artifact");
    return reply.type("text/plain").send(readFileSync(artifact.uri, "utf8"));
  });

  app.get("/api/v1/stream", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && origin !== daemon.remoteOrigin()) {
      socket.close(1008, "origin not allowed");
      return;
    }
    // A device's stream ends when the device is revoked; the client reconnects with a fresh token.
    const caller = callerOf(req);
    const offRevoked =
      caller.kind === "device"
        ? daemon.store.subscribe((event) => {
            if (event.type === "device.revoked" && (event.payload as { device_id: string }).device_id === caller.deviceId) socket.close(4401, "device revoked");
          })
        : () => {};
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
      offRevoked();
      offEvent();
      offLog();
    });
  });

  return app;
}

const WEB_CODE_TTL_MS = 60_000;

type Caller = { kind: "local" } | { kind: "device"; deviceId: string };

/** Routes whose credential is in the body: a sign-in code, a pairing code or a refresh token. */
const PUBLIC_ROUTES = new Set(["POST /api/v1/web/exchange", "POST /api/v1/devices/pair", "POST /api/v1/devices/refresh"]);

/**
 * What a paired device may call (ADR 0020). An allowlist, so a new route stays desktop-only until
 * it is added here. Secrets, pairing, sign-in codes, other devices and the concierge are not.
 */
const DEVICE_ROUTES = new Set([
  "GET /api/v1/health",
  "GET /api/v1/runs",
  "POST /api/v1/runs",
  "GET /api/v1/runs/:id",
  "POST /api/v1/runs/:id/cancel",
  "POST /api/v1/runs/:id/pause",
  "POST /api/v1/runs/:id/resume",
  "GET /api/v1/runs/:id/messages",
  "POST /api/v1/runs/:id/messages",
  "GET /api/v1/runs/:id/events",
  "GET /api/v1/runs/:id/logs",
  "GET /api/v1/runs/:id/worktree",
  "GET /api/v1/runs/:id/worktree/diff",
  "GET /api/v1/fleet",
  "GET /api/v1/approvals",
  "POST /api/v1/approvals/:id",
  "GET /api/v1/artifacts/:id",
  "GET /api/v1/stream",
  "GET /api/v1/repos",
  "GET /api/v1/projects",
  "GET /api/v1/projects/:id/map",
  "GET /api/v1/projects/:id/symbols",
  "GET /api/v1/projects/:id/search",
  "GET /api/v1/projects/:id/context",
  "GET /api/v1/projects/:id/specs",
  "GET /api/v1/projects/:id/principles",
  "GET /api/v1/inbox",
  "GET /api/v1/ci/failures",
  "GET /api/v1/inbox/:id",
  "POST /api/v1/inbox/sync",
  "POST /api/v1/inbox/start",
  "POST /api/v1/inbox/:id/dismiss",
  "POST /api/v1/inbox/:id/restore",
  "GET /api/v1/quotas",
  "GET /api/v1/usage",
  "GET /api/v1/metrics",
  "GET /api/v1/specs",
  "GET /api/v1/specs/addenda",
  "GET /api/v1/budgets",
  "GET /api/v1/away",
  "POST /api/v1/stop",
  "GET /api/v1/devices/me",
  "DELETE /api/v1/devices/:id",
  "GET /api/v1/push/key",
  "PUT /api/v1/push/subscription",
  "DELETE /api/v1/push/subscription",
]);

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
        // Only hashed build files are immutable; the page, the service worker and the manifest must update.
        const fixedName = path.endsWith(".html") || path.endsWith("sw.js") || path.endsWith(".webmanifest") || path.includes("/icons/");
        reply.header("cache-control", fixedName ? "no-cache" : "public, max-age=31536000, immutable");
        if (path.endsWith(".webmanifest")) reply.header("content-type", "application/manifest+json");
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

function forbidden(reply: FastifyReply, message: string) {
  return reply.code(403).send({ error: "forbidden", message });
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: "bad_request", message });
}

function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: "not_found", message: `${what} not found` });
}
