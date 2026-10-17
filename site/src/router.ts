import { createRouter, createWebHistory } from "vue-router";
import Home from "./views/Home.vue";

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "home", component: Home, meta: { title: "Navarch: orchestrate your fleet of coding agents" } },
    { path: "/download", name: "download", component: () => import("./views/Download.vue"), meta: { title: "Install Navarch" } },
    { path: "/docs", redirect: "/docs/introduction" },
    { path: "/docs/:slug", name: "docs", component: () => import("./views/Docs.vue") },
    { path: "/:pathMatch(.*)*", name: "not-found", component: () => import("./views/NotFound.vue"), meta: { title: "Page not found · Navarch" } },
  ],
  scrollBehavior(to, _from, saved) {
    if (saved) return saved;
    if (to.hash) return { el: to.hash, top: 88 };
    return { top: 0 };
  },
});

router.afterEach((to) => {
  if (typeof to.meta.title === "string") document.title = to.meta.title;
});
