/*
 * Navarch service worker (ADR 0020). It shows Web Push notifications, opens the app where a
 * notification points, and keeps the app shell so the installed app opens offline. It never
 * caches or answers the Core API.
 */
const SHELL = "navarch-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api")) return;
  if (req.mode === "navigate") {
    // Network first, so a new build shows at once; the last shell when offline.
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) (await caches.open(SHELL)).put("/", res.clone());
          return res;
        } catch {
          return (await caches.match("/")) ?? Response.error();
        }
      })(),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    // Hashed build files never change: cache first.
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      })(),
    );
  }
});

/** Only same-origin paths: a notification can open the app, nothing else. */
function safePath(value) {
  try {
    const url = new URL(String(value || "/home"), self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : "/home";
  } catch {
    return "/home";
  }
}

self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = {};
  }
  const actions = Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : [];
  const urls = Object.fromEntries(actions.map((a) => [a.action, safePath(a.url)]));
  event.waitUntil(
    self.registration.showNotification(String(msg.title || "Navarch"), {
      body: String(msg.body || ""),
      tag: msg.tag ? String(msg.tag) : undefined,
      renotify: Boolean(msg.tag),
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: safePath(msg.url), urls },
      actions: actions.map((a) => ({ action: String(a.action), title: String(a.title) })),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const path = (event.action && data.urls && data.urls[event.action]) || data.url || "/home";
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
