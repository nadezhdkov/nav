import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
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
  if (typeof e.data?.navigate === "string" && e.data.navigate.startsWith("/")) void router.push(e.data.navigate);
});
