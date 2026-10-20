import { createRouter, createWebHistory } from "vue-router";
import { BASE } from "./api/base.ts";

export const routes = [
  { path: "/", redirect: "/home" },
  { path: "/home", name: "home", component: () => import("./views/HomeView.vue") },
  { path: "/runs", name: "runs", component: () => import("./views/RunsView.vue") },
  { path: "/runs/:id", name: "run", component: () => import("./views/RunDetailView.vue"), props: true },
  { path: "/new", name: "new", component: () => import("./views/NewRunView.vue") },
  { path: "/inbox", name: "inbox", component: () => import("./views/InboxView.vue") },
  { path: "/fleet", name: "fleet", component: () => import("./views/FleetView.vue") },
  { path: "/flows", name: "flows", component: () => import("./views/FlowsView.vue") },
  { path: "/flows/:name", name: "flow", component: () => import("./views/FlowStudioView.vue"), props: true },
  { path: "/schedules", name: "schedules", component: () => import("./views/SchedulesView.vue") },
  { path: "/away", name: "away", component: () => import("./views/AwayView.vue") },
  { path: "/rules", name: "rules", component: () => import("./views/RulesView.vue") },
  { path: "/specs", name: "specs", component: () => import("./views/SpecsView.vue") },
  { path: "/usage", name: "usage", component: () => import("./views/UsageView.vue") },
  { path: "/approvals", name: "approvals", component: () => import("./views/ApprovalsView.vue") },
  { path: "/chat", name: "chat", component: () => import("./views/ChatView.vue") },
  { path: "/session", name: "session", component: () => import("./views/SessionView.vue") },
  { path: "/device", name: "device", component: () => import("./views/DeviceView.vue") },
  { path: "/settings/security", name: "security", component: () => import("./views/SecurityView.vue") },
  { path: "/settings/devices", name: "devices", component: () => import("./views/DevicesView.vue") },
  { path: "/:rest(.*)*", redirect: "/home" },
];

export const router = createRouter({ history: createWebHistory(BASE || undefined), routes });
