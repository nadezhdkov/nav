import type { FlowCatalogView, FlowDetail } from "@navarch/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "../src/i18n.ts";
import { newFlowYaml, readDraft } from "../src/lib/flowDoc.ts";

const api = vi.hoisted(() => ({
  flow: vi.fn(),
  flowCatalog: vi.fn(),
  flowVersion: vi.fn(),
  validateFlow: vi.fn(),
  saveFlowDraft: vi.fn(),
  publishFlow: vi.fn(),
  discardFlowDraft: vi.fn(),
  simulateFlow: vi.fn(),
}));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));

const { default: FlowStudio } = await import("../src/views/FlowStudioView.vue");

const catalog: FlowCatalogView = {
  profiles: [
    { id: "planner", edits: false },
    { id: "implementer", edits: true },
    { id: "reviewer", edits: false },
  ],
  adapters: ["claude-code", "codex"],
  uses: { action: ["verification.run"], github: ["pr.create", "pr.review", "pr.comment"] },
  flows: [{ name: "task", params: { max_fix_iterations: { type: "int", default: 3 } } }],
};

function detail(over: Partial<FlowDetail> = {}): FlowDetail {
  return {
    name: "my-flow",
    description: null,
    source: "studio",
    published_version: null,
    draft: { revision: 1, saved_at: "2026-10-16T00:00:00Z" },
    node_count: null,
    shadowed: false,
    updated_at: "2026-10-16T00:00:00Z",
    draft_yaml: newFlowYaml("my-flow"),
    published_yaml: null,
    based_on: null,
    versions: [],
    ...over,
  };
}

async function open(name = "my-flow") {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/flows", component: { template: "<div />" } },
      { path: "/flows/:name", component: FlowStudio, props: true },
    ],
  });
  await router.push(`/flows/${name}`);
  const page = mount({ template: "<RouterView />" }, { global: { plugins: [i18n, router] }, attachTo: document.body });
  await flushPromises();
  return { page, router };
}

const button = (page: ReturnType<typeof mount>, text: string) => page.findAll("button").find((b) => b.text().trim() === text || b.text().includes(text))!;

beforeEach(() => {
  i18n.global.locale.value = "en";
  Object.values(api).forEach((f) => f.mockReset());
  api.flowCatalog.mockResolvedValue(catalog);
  api.validateFlow.mockResolvedValue({ problems: [] });
  try {
    localStorage.clear();
  } catch {
    /* jsdom without storage */
  }
});

describe("Flow Studio (ADR 0033)", () => {
  it("builds a Flow from the library and the properties panel, saves it and publishes it, never touching YAML", async () => {
    api.flow.mockResolvedValue(detail());
    const { page } = await open();
    expect(page.text()).toContain("my-flow");

    // implement → verify → review → open_pr, each added after the selected one.
    await button(page, "Action").trigger("click");
    await button(page, "Agent").trigger("click");
    expect(page.text()).toContain("Agent node");
    const profile = page.findAll("select").find((s) => s.findAll("option").some((o) => o.text() === "reviewer"))!;
    await profile.setValue("reviewer");
    await button(page, "GitHub").trigger("click");

    const save = button(page, "Save draft");
    expect(save.attributes("disabled")).toBeUndefined();
    api.saveFlowDraft.mockImplementation(async (_n: string, yaml: string) => detail({ draft_yaml: yaml, draft: { revision: 2, saved_at: "t" } }));
    await save.trigger("click");
    await flushPromises();
    const [name, yaml, revision] = api.saveFlowDraft.mock.calls[0]!;
    expect([name, revision]).toEqual(["my-flow", 1]);
    const view = readDraft(yaml)!;
    expect(view.chain).toEqual(["implement", "verify", "implement_2", "open_pr"]);
    expect(view.nodes.find((n) => n.id === "implement_2")!.raw.profile).toBe("reviewer");

    api.publishFlow.mockResolvedValue(detail({ published_version: 1, draft: null, draft_yaml: null, published_yaml: yaml }));
    await button(page, "Publish").trigger("click");
    await flushPromises();
    const dialog = page.find("dialog");
    expect(dialog.text()).toContain("Publish my-flow as v1");
    expect(dialog.text()).toContain("First version");
    await dialog.findAll("button").find((b) => b.text().includes("Publish v1"))!.trigger("click");
    await flushPromises();
    expect(api.publishFlow).toHaveBeenCalledWith("my-flow", 2);
    expect(page.text()).toContain("Published as v1");
    page.unmount();
  });

  it("shows the daemon's problems on the toolbar and keeps Publish disabled while there are errors", async () => {
    api.flow.mockResolvedValue(detail());
    api.validateFlow.mockResolvedValue({ problems: [{ severity: "error", message: 'node "implement": unknown agent profile "x"', node: "implement", line: 7 }] });
    const { page } = await open();
    await button(page, "Action").trigger("click");
    await new Promise((r) => setTimeout(r, 350));
    await flushPromises();
    expect(page.text()).toContain("1 error(s) · 0 warning(s)");
    expect(button(page, "Publish").attributes("disabled")).toBeDefined();
    page.unmount();
  });

  it("opens a built-in Flow read-only, offering Duplicate", async () => {
    api.flow.mockResolvedValue(detail({ name: "task", source: "builtin", draft: null, draft_yaml: null, published_yaml: newFlowYaml("task") }));
    const { page } = await open("task");
    expect(page.text()).toContain("Built-in Flows are read-only");
    expect(page.findAll("button").some((b) => b.text().includes("Save draft"))).toBe(false);
    expect(button(page, "Agent").attributes("disabled")).toBeDefined();
    expect(button(page, "Duplicate")).toBeDefined();
    page.unmount();
  });

  it("says so when the draft changed in another tab", async () => {
    api.flow.mockResolvedValue(detail());
    const { ApiError } = await import("../src/api/client.ts");
    api.saveFlowDraft.mockRejectedValue(new ApiError(409, "conflict", "stale"));
    const { page } = await open();
    await button(page, "Action").trigger("click");
    await button(page, "Save draft").trigger("click");
    await flushPromises();
    expect(page.text()).toContain("This draft changed somewhere else");
    page.unmount();
  });
});
