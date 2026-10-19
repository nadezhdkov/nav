/**
 * Where the app lives. At the root of the daemon it is empty; when a phone reached it through a relay
 * (ADR 0067) the page is `/r/<relay id>/…` and the phone's service worker adds a
 * `<meta name="navarch-base">` with that prefix, so every request and link goes through the tunnel.
 */
const RELAY_BASE = /^\/r\/[A-Za-z0-9_-]{16,64}$/;

function read(): string {
  if (typeof document === "undefined") return "";
  const content = document.querySelector('meta[name="navarch-base"]')?.getAttribute("content") ?? "";
  return RELAY_BASE.test(content) ? content : "";
}

export const BASE = read();

/** `/api/v1/runs` → `/r/<id>/api/v1/runs` behind a relay, unchanged otherwise. */
export const withBase = (path: string): string => BASE + path;

/** True when the app was reached through a relay. */
export const viaRelay = BASE !== "";
