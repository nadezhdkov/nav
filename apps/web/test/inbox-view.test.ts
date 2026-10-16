import type { InboxItemDetail, InboxItemView, InboxView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";

const api = vi.hoisted(() => ({
  inbox: vi.fn(),
  inboxItem: vi.fn(),
  projects: vi.fn(),
  quotas: vi.fn(),
  startInbox: vi.fn(),
  syncInbox: vi.fn(),
  dismissItem: vi.fn(),
  restoreItem: vi.fn(),
  flows: vi.fn(),
}));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));

const { default: InboxPage } = await import("../src/views/InboxView.vue");
const { useInboxStore, useProjectsStore } = await import("../src/stores/runs.ts");

function item(n: number, over: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: `wi_github_acme~w_${n}`,
    project_id: "prj_a",
    source: "github",
    repo: "acme/w",
    number: n,
    url: `https://github.com/acme/w/issues/${n}`,
    title: `Issue ${n}`,
    labels: ["bug"],
    author: "alice",
    status: "triaged",
    triage: { kind: "bug", complexity: 2, area: "cli", duplicate_of: null, suggested_action: "start_run", flow: "fix-issue", reason: "Clear." },
    triage_model: "openrouter/x:free",
    estimate: { usd: 0.4, runs: 5 },
    runs: [],
    updated_at: "2026-10-15T00:00:00Z",
    ...over,
  };
}

const view: InboxView = {
  triage: { available: false, reason: "no API model for triage", used_today: { items: 0, usd: 0 }, cap: { items: 50, usd: 0.5 } },
  items: [item(1), item(2, { triage: null, estimate: null, status: "new", title: "<img src=x onerror=alert(1)>" }), item(3, { status: "in_run" })],
};

const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

beforeEach(async () => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  Object.values(api).forEach((f) => f.mockReset());
  api.inbox.mockResolvedValue(view);
  api.projects.mockResolvedValue([{ id: "prj_a", name: "w", repo: "acme/w", path: "/src/w", added_at: "x", active_runs: 1, inbox: { new: 1, triaged: 1 }, synced_at: null }]);
  api.quotas.mockResolvedValue([]);
  api.flows.mockResolvedValue([
    { name: "fix-issue", description: null, source: "builtin", published_version: null, draft: null, node_count: 7, needs: "issue", shadowed: false, updated_at: null },
    { name: "plan-and-pr", description: "Plan, approve, implement, PR.", source: "studio", published_version: 3, draft: null, node_count: 5, needs: "issue", shadowed: false, updated_at: "t" },
    { name: "my-review", description: null, source: "studio", published_version: 1, draft: null, node_count: 2, needs: "pull_request", shadowed: false, updated_at: "t" },
    { name: "scratch", description: null, source: "studio", published_version: null, draft: { revision: 1, saved_at: "t" }, node_count: null, needs: null, shadowed: false, updated_at: "t" },
  ]);
  await useInboxStore().load();
  await useProjectsStore().load();
});

describe("Inbox view", () => {
  it("lists open items with triage, estimate and status as text, and says why triage is off", async () => {
    const page = mount(InboxPage, { global });
    await flushPromises();
    const text = page.text();
    expect(text).toContain("Triage unavailable. no API model for triage");
    const rows = page.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toMatch(/Issue 1.*acme\/w#1.*Bug.*2\/5.*cli.*Start a run.*≈ \$0\.400.*Triaged/);
    // Untrusted titles are text, never markup.
    expect(page.find("tbody img").exists()).toBe(false);
    expect(rows[1]!.text()).toContain("<img src=x onerror=alert(1)>");
  });

  it("starts runs for the selected items after showing what will happen and the total", async () => {
    api.startInbox.mockResolvedValue({ runs: [{ item_id: "wi_github_acme~w_1", run_id: "run_9" }], errors: [{ item_id: "wi_github_acme~w_2", message: "denied" }] });
    const page = mount(InboxPage, { global });
    await flushPromises();
    for (const box of page.findAll("tbody input[type=checkbox]")) await box.setValue(true);
    expect(page.text()).toContain("2 selected");
    await page.find("button.bg-accent").trigger("click");
    const dialog = page.find("dialog");
    expect(dialog.text()).toContain("Starts 2 run(s) of fix-issue, one per issue");
    expect(dialog.text()).toContain("Estimated total ≈ $0.400 for 2 item(s)");
    expect(dialog.text()).toContain("1 without estimate");
    await dialog.find("form").trigger("submit");
    await flushPromises();
    expect(api.startInbox).toHaveBeenCalledWith({ item_ids: ["wi_github_acme~w_1", "wi_github_acme~w_2"] });
    expect(dialog.text()).toContain("wi_github_acme~w_2: denied");
  });

  it("starts the items with a published Studio Flow that takes an issue (go/no-go finding)", async () => {
    api.startInbox.mockResolvedValue({ runs: [{ item_id: "wi_github_acme~w_1", run_id: "run_9" }], errors: [] });
    const page = mount(InboxPage, { global });
    await flushPromises();
    await page.findAll("tbody input[type=checkbox]")[0]!.setValue(true);
    await page.find("button.bg-accent").trigger("click");
    await flushPromises();
    const dialog = page.find("dialog");
    const choices = dialog.findAll("input[name=inbox-flow]").map((i) => (i.element as HTMLInputElement).value);
    // Flows that work on a pull request, or are only drafts, are not offered.
    expect(choices).toEqual(["fix-issue", "team", "plan-and-pr"]);
    await dialog.find("input[value=plan-and-pr]").setValue(true);
    expect(dialog.text()).toContain("Starts 1 run(s) of plan-and-pr");
    await dialog.find("form").trigger("submit");
    await flushPromises();
    expect(api.startInbox).toHaveBeenCalledWith({ item_ids: ["wi_github_acme~w_1"], flow: "plan-and-pr" });
  });

  it("shows the issue body as plain text in the panel and dismisses it", async () => {
    const detail: InboxItemDetail = { ...item(1), body: "<b>bold</b> and **markdown**", triaged_at: null };
    api.inboxItem.mockResolvedValue(detail);
    api.dismissItem.mockResolvedValue({ ...detail, status: "dismissed" });
    const page = mount(InboxPage, { global });
    await flushPromises();
    await page.find("tbody button").trigger("click");
    await flushPromises();
    const panel = page.find("aside");
    expect(panel.find("pre").text()).toBe("<b>bold</b> and **markdown**");
    expect(panel.find("b").exists()).toBe(false);
    expect(panel.text()).toContain("“Clear.” · openrouter/x:free");
    await panel.findAll("button").find((b) => b.text() === "Dismiss")!.trigger("click");
    await flushPromises();
    expect(api.dismissItem).toHaveBeenCalledWith("wi_github_acme~w_1");
    expect(page.find("aside").text()).toContain("Restore");
  });
});
