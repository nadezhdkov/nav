import type {
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
} from "@navarch/contracts";
import { ref } from "vue";
import { bearer, forgetDevice, isDevice, refresh } from "./session.ts";
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
  const token = await bearer();
  if (!token) {
    authorized.value = false;
    throw new ApiError(401, "unauthorized", "no token");
  }
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-navarch-client": client(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401) {
    // A device's access token may have just expired or been signed by an old key: refresh once.
    if (isDevice.value && !getToken() && !retried && (await refresh())) return request<T>(method, path, body, as, true);
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
  messages: (runId: string) => request<RunMessage[]>("GET", `/api/v1/runs/${encodeURIComponent(runId)}/messages`),
  sendMessage: (runId: string, body: { text: string; task_id?: string; delivery: "next" | "now" }) =>
    request<RunMessage>("POST", `/api/v1/runs/${encodeURIComponent(runId)}/messages`, body),
  decide: (id: string, decision: "approve" | "reject", reason?: string) =>
    request<unknown>("POST", `/api/v1/approvals/${encodeURIComponent(id)}`, { decision, ...(reason ? { reason } : {}) }),
  pause: (id: string) => request<RunView>("POST", `/api/v1/runs/${encodeURIComponent(id)}/pause`),
  stopAll: () => request<StopResult>("POST", "/api/v1/stop"),
  startRun: (body: { repo_path: string; prompt: string }) => request<RunView>("POST", "/api/v1/runs", body),
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
};
