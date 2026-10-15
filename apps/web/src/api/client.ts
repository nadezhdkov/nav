import type { ApprovalStatus, ApprovalView, NavarchEvent, RunDetail, RunView, WebExchangeResponse } from "@navarch/contracts";
import { ref } from "vue";
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

/** False once the daemon refused the token; the app then shows the token screen. */
export const authorized = ref(getToken() !== null);

/**
 * Reads `#code=…` (from `navarch web`) or `#token=…` from the address, then removes it. The
 * fragment never reaches the server; a code is single-use and trades for the token (ADR 0017).
 */
export async function signInFromFragment(location: Location = window.location, history: History = window.history): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("code");
  const token = params.get("token");
  if (!code && !token) return;
  params.delete("code");
  params.delete("token");
  const rest = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
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

async function request<T>(method: string, path: string, body?: unknown, as: "json" | "text" = "json"): Promise<T> {
  const token = getToken();
  if (!token) {
    authorized.value = false;
    throw new ApiError(401, "unauthorized", "no token");
  }
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-navarch-client": "web",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401) {
    clearToken();
    authorized.value = false;
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "error", err.message ?? res.statusText);
  }
  authorized.value = true;
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
  decide: (id: string, decision: "approve" | "reject", reason?: string) =>
    request<unknown>("POST", `/api/v1/approvals/${encodeURIComponent(id)}`, { decision, ...(reason ? { reason } : {}) }),
};
