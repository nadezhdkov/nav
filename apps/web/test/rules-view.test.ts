import type { PrinciplesView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";

const api = vi.hoisted(() => ({ projects: vi.fn(), principles: vi.fn(), acceptProposal: vi.fn(), dismissProposal: vi.fn(), quotas: vi.fn() }));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));

const { default: RulesPage } = await import("../src/views/RulesView.vue");
const { usePrinciplesStore, useProjectsStore } = await import("../src/stores/runs.ts");

const view = (over: Partial<PrinciplesView> = {}): PrinciplesView => ({
  project_id: "prj_1",
  principles: [{ id: "prin_1", text: "Use Pest", source: "user", added_at: null, run_id: null }],
  proposals: [{ id: "prop_1", text: "Keep functions short", reason: "<b>reviewers</b> asked", run_id: "run_1", proposed_at: "2026-10-19T11:00:00Z" }],
  truncated: false,
  ...over,
});
const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

async function open(v: PrinciplesView) {
  api.projects.mockResolvedValue([{ id: "prj_1", name: "acme" }]);
  api.quotas.mockResolvedValue([]);
  api.principles.mockResolvedValue(v);
  await useProjectsStore().load();
  await usePrinciplesStore().load();
  const page = mount(RulesPage, { global });
  await flushPromises();
  return page;
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  Object.values(api).forEach((f) => f.mockReset());
});

describe("Rules view (ADR 0057)", () => {
  it("lists rules and proposals, shows the reason as plain text and counts pending ones", async () => {
    const page = await open(view());
    const text = page.text();
    expect(text).toContain("Use Pest");
    expect(text).toContain("Keep functions short");
    expect(text).toContain("Why: <b>reviewers</b> asked");
    expect(page.find("b").exists()).toBe(false);
    expect(text).toContain("not applied to any agent until you accept");
    expect(usePrinciplesStore().pending).toBe(1);
  });

  it("accepts a proposal and reloads", async () => {
    const page = await open(view());
    api.acceptProposal.mockResolvedValue({});
    api.principles.mockResolvedValue(view({ proposals: [] }));
    await page.findAll("button").find((b) => b.text() === "Accept")!.trigger("click");
    await flushPromises();
    expect(api.acceptProposal).toHaveBeenCalledWith("prj_1", "prop_1");
    expect(page.text()).not.toContain("Keep functions short");
    expect(usePrinciplesStore().pending).toBe(0);
  });

  it("dismisses, and keeps the error when the daemon refuses", async () => {
    const page = await open(view());
    api.dismissProposal.mockRejectedValue(new Error("forbidden"));
    await page.findAll("button").find((b) => b.text() === "Dismiss")!.trigger("click");
    await flushPromises();
    expect(api.dismissProposal).toHaveBeenCalledWith("prj_1", "prop_1");
    expect(page.text()).toContain("forbidden");
  });

  it("reloads after rule events only", async () => {
    vi.useFakeTimers();
    api.projects.mockResolvedValue([]);
    const store = usePrinciplesStore();
    store.apply({ type: "run.created" } as never);
    store.apply({ type: "principle.proposed" } as never);
    await vi.advanceTimersByTimeAsync(400);
    expect(api.projects).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
