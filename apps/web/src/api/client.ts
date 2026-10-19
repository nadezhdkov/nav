import type {
  AwayView,
  CiFailureView,
  SetAwayRequest,
  RunAttachment,
  GitHubRepoView,
  ApprovalStatus,
  ApprovalView,
  DevicePairing,
  DeviceView,
  Locale,
  PushKey,
  RemoteStatus,
  RepoView,
  StopResult,
  FleetView,
  FleetWindow,
  NavarchEvent,
  RunDetail,
  RunMessage,
  RunView,
  WebExchangeResponse,
  WorktreeStatus,
  InboxItemDetail,
  InboxView,
  AddProjectResult,
  ProjectView,
  QuotaView,
  BudgetView,
  SetBudgetRequest,
  UsageView,
  MetricsView,
  PrinciplesView,
  PrincipleView,
  SpecRunView,
  SpecAddendumRunView,
  StartInboxResult,
  SyncInboxResult,
  WorkItemStatus,
  FlowCatalogView,
  FlowDetail,
  FlowSummary,
  SimulationRequest,
  SimulationResult,
  ValidateFlowResponse,
} from "@navarch/contracts";
import { ref } from "vue";
import { bearer, forgetDevice, GATEWAY, isDevice, refresh } from "./session.ts";
import { clearToken, getToken, setToken } from "./token.ts";

/** Core API client (spec §9.1). The SPA talks to nothing else (architecture rule 1). */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * False while the daemon cannot be reached: no network, Tailscale off on this phone, or the daemon
 * down behind `tailscale serve`. Views then say so instead of showing empty lists (go/no-go F2).
 */
export const reachable = ref(true);

const unreachable = (detail: string) => {
  reachable.value = false;
  return new ApiError(0, "unreachable", `Navarch is not reachable: ${detail}`);
};

/** False once the daemon refused the token; the app then shows the sign-in or pairing screen. */
export const authorized = ref(getToken() !== null || isDevice.value);

/** A pairing code from `#pair=…` (the desktop's QR code), waiting for the device's name. */
export const pendingPair = ref<string | null>(null);

/** Who this browser is to the daemon: the desktop (local token) or a paired phone. */
export const client = () => (isDevice.value && !getToken() ? "mobile" : "web");

/**
 * Reads `#code=…` (from `navarch web`) or `#token=…` from the address, then removes it. The
 * fragment never reaches the server; a code is single-use and trades for the token (ADR 0017).
 */
export async function signInFromFragment(location: Location = window.location, history: History = window.history): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("code");
  const token = params.get("token");
  const pair = params.get("pair");
  if (!code && !token && !pair) return;
  params.delete("code");
  params.delete("token");
  params.delete("pair");
  const rest = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  if (pair) {
    pendingPair.value = pair;
    return;
  }
  if (token) {
    setToken(token);
    authorized.value = true;
    return;
  }
  const res = await fetch("/api/v1/web/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", "x-navarch-client": "web" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) return;
  setToken(((await res.json()) as WebExchangeResponse).token);
  authorized.value = true;
}

async function request<T>(method: string, path: string, body?: unknown, as: "json" | "text" = "json", retried = false): Promise<T> {
  let token: string | null;
  let res: Response;
  try {
    token = await bearer();
    if (!token) {
      authorized.value = false;
      throw new ApiError(401, "unauthorized", "no token");
    }
    res = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-navarch-client": client(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw unreachable((err as Error).message);
  }
  if (GATEWAY.has(res.status)) throw unreachable(`the daemon did not answer (${res.status})`);
  reachable.value = true;
  if (res.status === 401) {
    // A device's access token may have just expired or been signed by an old key: refresh once.
    if (isDevice.value && !getToken() && !retried && (await refresh().catch((err: Error) => Promise.reject(unreachable(err.message))))) {
      return request<T>(method, path, body, as, true);
    }
    if (getToken()) clearToken();
    else forgetDevice();
    authorized.value = false;
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "error", err.message ?? res.statusText);
  }
  authorized.value = true;
  if (res.status === 204) return undefined as T;
  return (as === "text" ? await res.text() : await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("GET", "/api/v1/health"),
  runs: (limit = 100) => request<RunView[]>("GET", `/api/v1/runs?limit=${limit}`),
  run: (id: string) => request<RunDetail>("GET", `/api/v1/runs/${encodeURIComponent(id)}`),
  runEvents: (id: string, after = 0) => request<NavarchEvent[]>("GET", `/api/v1/runs/${encodeURIComponent(id)}/events?after=${after}`),
  runLogs: (id: string) => request<string>("GET", `/api/v1/runs/${encodeURIComponent(id)}/logs`, undefined, "text"),
  artifact: (id: string) => request<string>("GET", `/api/v1/artifacts/${encodeURIComponent(id)}`, undefined, "text"),
  cancel: (id: string) => request<unknown>("POST", `/api/v1/runs/${encodeURIComponent(id)}/cancel`),
  resume: (id: string) => request<unknown>("POST", `/api/v1/runs/${encodeURIComponent(id)}/resume`),
  approvals: (status?: ApprovalStatus) =>
    request<ApprovalView[]>("GET", `/api/v1/approvals${status ? `?status=${status}` : ""}`),
  fleet: (window: FleetWindow = "active") => request<FleetView>("GET", `/api/v1/fleet?window=${window}`),
  taskLogs: (runId: string, taskId: string) =>
    request<string>("GET", `/api/v1/runs/${encodeURIComponent(runId)}/logs?task=${encodeURIComponent(taskId)}`, undefined, "text"),
  /** With `taskId`, that task's worktree: a parallel team member works in its own (ADR 0029). */
  worktree: (runId: string, taskId?: string) =>
    request<WorktreeStatus>("GET", `/api/v1/runs/${encodeURIComponent(runId)}/worktree${taskId ? `?task=${encodeURIComponent(taskId)}` : ""}`),
  worktreeDiff: (runId: string, path: string, taskId?: string) =>
    request<string>("GET", `/api/v1/runs/${encodeURIComponent(runId)}/worktree/diff?path=${encodeURIComponent(path)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ""}`, undefined, "text"),
  messages: (runId: string) => request<RunMessage[]>("GET", `/api/v1/runs/${encodeURIComponent(runId)}/messages`),
  sendMessage: (runId: string, body: { text: string; task_id?: string; delivery: "next" | "now" }) =>
    request<RunMessage>("POST", `/api/v1/runs/${encodeURIComponent(runId)}/messages`, body),
  decide: (id: string, decision: "approve" | "reject", reason?: string, choice?: string) =>
    request<unknown>("POST", `/api/v1/approvals/${encodeURIComponent(id)}`, { decision, ...(reason ? { reason } : {}), ...(choice ? { choice } : {}) }),
  pause: (id: string) => request<RunView>("POST", `/api/v1/runs/${encodeURIComponent(id)}/pause`),
  stopAll: () => request<StopResult>("POST", "/api/v1/stop"),
  startRun: (body: { repo_path: string; prompt: string; flow?: string; budget?: number; params?: Record<string, number | string | boolean>; attachments?: RunAttachment[] }) =>
    request<RunView>("POST", "/api/v1/runs", body),
  repos: () => request<RepoView[]>("GET", "/api/v1/repos"),
  remote: () => request<RemoteStatus>("GET", "/api/v1/remote"),
  devices: () => request<DeviceView[]>("GET", "/api/v1/devices"),
  me: () => request<DeviceView>("GET", "/api/v1/devices/me"),
  pairing: () => request<DevicePairing>("POST", "/api/v1/devices/pairings"),
  revokeDevice: (id: string) => request<DeviceView>("DELETE", `/api/v1/devices/${encodeURIComponent(id)}`),
  pushKey: () => request<PushKey>("GET", "/api/v1/push/key"),
  subscribePush: (sub: PushSubscriptionJSON, locale: Locale) =>
    request<void>("PUT", "/api/v1/push/subscription", { endpoint: sub.endpoint, keys: sub.keys, locale }),
  unsubscribePush: () => request<void>("DELETE", "/api/v1/push/subscription"),
  projects: () => request<ProjectView[]>("GET", "/api/v1/projects"),
  githubRepos: () => request<GitHubRepoView[]>("GET", "/api/v1/github/repos"),
  cloneRepo: (repo: string) => request<AddProjectResult>("POST", "/api/v1/github/repos/clone", { repo }),
  ciFailures: () => request<CiFailureView[]>("GET", "/api/v1/ci/failures"),
  fixCiFailure: (id: string, budget?: number) => request<{ failure: CiFailureView; run: RunView }>("POST", `/api/v1/ci/failures/${encodeURIComponent(id)}/fix`, budget ? { budget } : {}),
  dismissCiFailure: (id: string) => request<CiFailureView>("POST", `/api/v1/ci/failures/${encodeURIComponent(id)}/dismiss`, {}),
  inbox: (status?: WorkItemStatus[]) => request<InboxView>("GET", `/api/v1/inbox${status?.length ? `?status=${status.join(",")}` : ""}`),
  inboxItem: (id: string) => request<InboxItemDetail>("GET", `/api/v1/inbox/${encodeURIComponent(id)}`),
  syncInbox: (projectId?: string) => request<SyncInboxResult>("POST", "/api/v1/inbox/sync", projectId ? { project_id: projectId } : {}),
  startInbox: (body: { item_ids: string[]; flow?: string; budget?: number }) => request<StartInboxResult>("POST", "/api/v1/inbox/start", body),
  dismissItem: (id: string, reason?: string) => request<InboxItemDetail>("POST", `/api/v1/inbox/${encodeURIComponent(id)}/dismiss`, reason ? { reason } : {}),
  restoreItem: (id: string) => request<InboxItemDetail>("POST", `/api/v1/inbox/${encodeURIComponent(id)}/restore`, {}),
  quotas: () => request<QuotaView[]>("GET", "/api/v1/quotas"),
  metrics: (days = 30) => request<MetricsView>("GET", `/api/v1/metrics?days=${days}`),
  usage: (days = 30, profile?: string) =>
    request<UsageView>("GET", `/api/v1/usage?days=${days}${profile ? `&profile=${encodeURIComponent(profile)}` : ""}`),
  specs: () => request<SpecRunView[]>("GET", "/api/v1/specs"),
  specAddenda: () => request<SpecAddendumRunView[]>("GET", "/api/v1/specs/addenda"),
  principles: (project: string) => request<PrinciplesView>("GET", `/api/v1/projects/${encodeURIComponent(project)}/principles`),
  acceptProposal: (project: string, proposal: string) => request<PrincipleView>("POST", `/api/v1/projects/${encodeURIComponent(project)}/principles/proposals/${encodeURIComponent(proposal)}/accept`, {}),
  dismissProposal: (project: string, proposal: string) => request<void>("POST", `/api/v1/projects/${encodeURIComponent(project)}/principles/proposals/${encodeURIComponent(proposal)}/dismiss`, {}),
  away: () => request<AwayView>("GET", "/api/v1/away"),
  setAway: (body: SetAwayRequest) => request<AwayView>("PUT", "/api/v1/away", body),
  setBudget: (body: SetBudgetRequest) => request<BudgetView[]>("PUT", "/api/v1/budgets", body),
  // Flow Studio (ADR 0033)
  flows: () => request<FlowSummary[]>("GET", "/api/v1/flows"),
  flowCatalog: () => request<FlowCatalogView>("GET", "/api/v1/flows/catalog"),
  flow: (name: string) => request<FlowDetail>("GET", `/api/v1/flows/${encodeURIComponent(name)}`),
  flowVersion: (name: string, version: number) => request<{ yaml: string }>("GET", `/api/v1/flows/${encodeURIComponent(name)}/versions/${version}`),
  saveFlowDraft: (name: string, yaml: string, revision: number | null) => request<FlowDetail>("PUT", `/api/v1/flows/${encodeURIComponent(name)}/draft`, { yaml, revision }),
  discardFlowDraft: (name: string, revision: number) => request<{ flow: FlowDetail | null }>("DELETE", `/api/v1/flows/${encodeURIComponent(name)}/draft`, { revision }),
  publishFlow: (name: string, revision: number) => request<FlowDetail>("POST", `/api/v1/flows/${encodeURIComponent(name)}/publish`, { revision }),
  validateFlow: (yaml: string, name?: string) => request<ValidateFlowResponse>("POST", "/api/v1/flows/validate", { yaml, ...(name ? { name } : {}) }),
  simulateFlow: (body: SimulationRequest) => request<SimulationResult>("POST", "/api/v1/flows/simulate", body),
};
