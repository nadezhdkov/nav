import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { BASE } from "./api/base.ts";
import { signInFromFragment } from "./api/client.ts";
import { i18n } from "./i18n.ts";
import { registerServiceWorker } from "./lib/push.ts";
import { router } from "./router.ts";
import "./style.css";

document.documentElement.lang = i18n.global.locale.value;
await signInFromFragment();
createApp(App).use(createPinia()).use(router).use(i18n).mount("#app");

// The service worker shows push notifications and keeps the app shell for the installed PWA (ADR 0020).
void registerServiceWorker();
navigator.serviceWorker?.addEventListener("message", (e: MessageEvent<{ navigate?: string }>) => {
  // A path in the message is the page's own (without the relay prefix the worker may have added).
  const path = typeof e.data?.navigate === "string" ? e.data.navigate.slice(BASE && e.data.navigate.startsWith(`${BASE}/`) ? BASE.length : 0) : "";
  if (path.startsWith("/")) void router.push(path);
});
