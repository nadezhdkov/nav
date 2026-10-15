import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { signInFromFragment } from "./api/client.ts";
import { i18n } from "./i18n.ts";
import { router } from "./router.ts";
import "./style.css";

document.documentElement.lang = i18n.global.locale.value;
await signInFromFragment();
createApp(App).use(createPinia()).use(router).use(i18n).mount("#app");
