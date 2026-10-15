import { createRouter, createWebHistory } from "vue-router";

export const routes = [
  { path: "/", redirect: "/runs" },
  { path: "/runs", name: "runs", component: () => import("./views/RunsView.vue") },
  { path: "/runs/:id", name: "run", component: () => import("./views/RunDetailView.vue"), props: true },
  { path: "/fleet", name: "fleet", component: () => import("./views/FleetView.vue") },
  { path: "/approvals", name: "approvals", component: () => import("./views/ApprovalsView.vue") },
  { path: "/:rest(.*)*", redirect: "/runs" },
];

export const router = createRouter({ history: createWebHistory(), routes });
