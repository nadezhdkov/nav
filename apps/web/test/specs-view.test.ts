import type { SpecAddendumRunView, SpecRunView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";
import { meetsTarget, percent, shares } from "../src/lib/specs.ts";

const api = vi.hoisted(() => ({ specs: vi.fn(), specAddenda: vi.fn() }));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));

const { default: SpecsPage } = await import("../src/views/SpecsView.vue");
const { useSpecsStore } = await import("../src/stores/runs.ts");

const extraction = (over: Partial<SpecRunView> = {}): SpecRunView => ({
  run_id: "run_1", run_name: "brave-frigate", ts: "2026-10-19T12:00:00Z", components: 3, claims: 20, confirmed: 18, inferred: 1, gap: 1, downgraded: 2, green_rate: 0.9,
  branch: "navarch/run_1/reverse-spec", files: [".navarch/specs/a.md"], ...over,
});
const addendum = (over: Partial<SpecAddendumRunView> = {}): SpecAddendumRunView => ({
  run_id: "run_2", run_name: "calm-corvette", ts: "2026-10-19T13:00:00Z", repo: "acme/w", pr_number: 7, changes: 4, confirmed: 3, inferred: 1, gap: 0, downgraded: 0, stale: 2, unmatched: 1,
  branch: "navarch/run_2/spec-sync", files: [".navarch/specs/addenda/pr-7.md"], ...over,
});

const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  Object.values(api).forEach((f) => f.mockReset());
});

describe("specs helpers", () => {
  it("turns a green rate into a percentage and checks it against the 70 % target", () => {
    expect(percent(0.94)).toBe("94 %");
    expect(percent(null)).toBeNull();
    expect(meetsTarget(0.7)).toBe(true);
    expect(meetsTarget(0.69)).toBe(false);
    expect(meetsTarget(null)).toBe(false);
  });

  it("splits a write's claims into bar shares that add up to 100", () => {
    const s = shares({ confirmed: 3, inferred: 1, gap: 0 });
    expect(s).toEqual({ confirmed: 75, inferred: 25, gap: 0 });
    expect(shares({ confirmed: 0, inferred: 0, gap: 0 })).toEqual({ confirmed: 0, inferred: 0, gap: 0 });
  });
});

describe("Specs view", () => {
  it("shows the latest share against the target, each extraction and each addendum as text", async () => {
    api.specs.mockResolvedValue([extraction(), extraction({ run_id: "run_0", run_name: "old-sloop", green_rate: 0.4, confirmed: 8, inferred: 6, gap: 6 })]);
    api.specAddenda.mockResolvedValue([addendum()]);
    await useSpecsStore().load();
    const page = mount(SpecsPage, { global });
    await flushPromises();
    const text = page.text();
    expect(text).toContain("90 %");
    expect(text).toContain("target 70 % met");
    expect(text).toContain("brave-frigate");
    expect(text).toContain("old-sloop");
    expect(text).toContain("18 confirmed");
    expect(text).toContain("2 downgraded");
    expect(text).toContain("acme/w#7");
    expect(text).toContain("2 claim(s) may be stale");
    expect(text).toContain("1 not found in the specs");
    expect(page.find("[role=img]").attributes("aria-label")).toBe("18 confirmed, 1 inferred, 1 gaps");
  });

  it("says when the latest write is below the target, and when nothing was written yet", async () => {
    api.specs.mockResolvedValue([extraction({ green_rate: 0.4 })]);
    api.specAddenda.mockResolvedValue([]);
    await useSpecsStore().load();
    const low = mount(SpecsPage, { global });
    expect(low.text()).toContain("below the 70 % target");
    expect(low.text()).toContain("No addenda yet");

    api.specs.mockResolvedValue([]);
    await useSpecsStore().load();
    const none = mount(SpecsPage, { global });
    expect(none.text()).toContain("No specs written yet");
    expect(none.text()).not.toContain("target 70 % met");
  });
});

describe("specs store", () => {
  it("reloads after a spec event and ignores others", async () => {
    vi.useFakeTimers();
    api.specs.mockResolvedValue([]);
    api.specAddenda.mockResolvedValue([]);
    const store = useSpecsStore();
    store.apply({ type: "run.created" } as never);
    store.apply({ type: "spec.generated" } as never);
    store.apply({ type: "spec.addendum.written" } as never);
    await vi.advanceTimersByTimeAsync(400);
    expect(api.specs).toHaveBeenCalledTimes(1);
    expect(api.specAddenda).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
