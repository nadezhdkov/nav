/// <reference lib="webworker" />
import { relayIdOf, respond, Tunnel } from "./core.ts";
import { credStore } from "./store.ts";

/**
 * The phone's service worker (ADR 0067). Once the phone is paired it answers every request under
 * `/r/<relay id>/` by asking the daemon through the end-to-end encrypted tunnel, so the app that runs is the
 * daemon's own and the relay only ever saw ciphertext. It also shows Web Push notifications.
 */
declare const self: ServiceWorkerGlobalScope;

const tunnels = new Map<string, Tunnel>();
/** Files the relay itself serves: the loader page's own parts. */
const RELAY_FILES = new Set(["loader.js", "loader.css", "sw.js"]);

function tunnelFor(relayId: string): Tunnel {
  let tunnel = tunnels.get(relayId);
  if (!tunnel) {
    tunnel = new Tunnel({
      relayId,
      creds: () => credStore.load(relayId),
      socket: () => new WebSocket(`${self.location.protocol === "https:" ? "wss" : "ws"}://${self.location.host}/p/${relayId}`),
    });
    tunnels.set(relayId, tunnel);
  }
  return tunnel;
}

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const relayId = relayIdOf(url.pathname);
  if (url.origin !== self.location.origin || !relayId) return;
  const scope = `/r/${relayId}`;
  const file = url.pathname.slice(scope.length + 1);
  if (RELAY_FILES.has(file)) return;
  event.respondWith(
    (async () => {
      // Not paired yet: the relay's loader page is the answer.
      if (!(await credStore.load(relayId))) return fetch(req);
      return respond(req, scope, tunnelFor(relayId));
    })(),
  );
});

/** Only paths of this app: a notification can open the app, nothing else. */
function safePath(scope: string, value: unknown): string {
  try {
    const url = new URL(String(value || "/home"), self.location.origin);
    const path = url.origin === self.location.origin ? url.pathname + url.search : "/home";
    return path.startsWith(`${scope}/`) ? path : `${scope}${path.startsWith("/") ? path : "/home"}`;
  } catch {
    return `${scope}/home`;
  }
}

const scopeOf = (): string => new URL(self.registration.scope).pathname.replace(/\/$/, "");

self.addEventListener("push", (event) => {
  let msg: { title?: string; body?: string; tag?: string; url?: string; actions?: { action: string; title: string; url?: string }[] } = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = {};
  }
  const scope = scopeOf();
  const actions = Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : [];
  const urls = Object.fromEntries(actions.map((a) => [a.action, safePath(scope, a.url)]));
  event.waitUntil(
    self.registration.showNotification(String(msg.title || "Navarch"), {
      body: String(msg.body || ""),
      ...(msg.tag ? { tag: String(msg.tag), renotify: true } : {}),
      icon: `${scope}/icons/icon-192.png`,
      badge: `${scope}/icons/icon-192.png`,
      data: { url: safePath(scope, msg.url), urls },
      actions: actions.map((a) => ({ action: String(a.action), title: String(a.title) })),
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { url?: string; urls?: Record<string, string> };
  const scope = scopeOf();
  const path = (event.action && data.urls?.[event.action]) || data.url || `${scope}/home`;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(path).catch(() => client.postMessage({ navigate: path }));
          return;
        }
      }
      await self.clients.openWindow(path);
    })(),
  );
});
