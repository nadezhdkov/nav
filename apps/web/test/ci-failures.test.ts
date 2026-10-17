import type { CiFailureView } from "@navarch/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { i18n } from "../src/i18n.ts";

const api = vi.hoisted(() => ({ ciFailures: vi.fn(), fixCiFailure: vi.fn(), dismissCiFailure: vi.fn() }));
const device = vi.hoisted(() => ({ value: false }));
const push = vi.hoisted(() => vi.fn());
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("../src/api/session.ts", async (orig) => ({ ...(await orig<object>()), isDevice: new Proxy(ref(false), { get: (t, k) => (k === "value" ? device.value : Reflect.get(t, k)) }) }));

const { default: CiFailures } = await import("../src/components/CiFailures.vue");
const { useCiStore } = await import("../src/stores/runs.ts");

function failure(n: number, over: Partial<CiFailureView> = {}): CiFailureView {
  return {
    id: `cif_${n}`,
    project_id: "prj_a",
    repo: "acme/w",
    number: n,
    title: `PR ${n}`,
    author: "erin",
    url: `https://github.com/acme/w/pull/${n}`,
    head_ref: "feature",
    head_sha: "abc",
    checks: [{ name: "test", conclusion: "failure", url: "u" }],
    status: "open",
    detected_at: "2026-10-17T00:00:00Z",
    run_id: null,
    resolved_reason: null,
    ...over,
  };
}

async function mountList(list: CiFailureView[]) {
  api.ciFailures.mockResolvedValue(list);
  const pinia = createPinia();
  setActivePinia(pinia);
  await useCiStore().load();
  return mount(CiFailures, { global: { plugins: [pinia, i18n] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  device.value = false;
  i18n.global.locale.value = "en";
});

describe("CI failures on Home (ADR 0041)", () => {
  it("shows nothing without failures", async () => {
    expect((await mountList([])).find("[data-testid=ci-failures]").exists()).toBe(false);
  });

  it("lists each failure as plain text with its failed checks, and a link to the pull request", async () => {
    const w = await mountList([
      failure(12, { title: "<img src=x onerror=alert(1)>", checks: ["a", "b", "c", "d"].map((name) => ({ name, conclusion: "failure", url: "u" })) }),
      failure(13, { url: "javascript:alert(1)" }),
    ]);
    expect(w.text()).toContain("<img src=x onerror=alert(1)>");
    expect(w.find("img").exists()).toBe(false);
    expect(w.text()).toContain("acme/w#12 failed a, b, c +1");
    const links = w.findAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.attributes()).toMatchObject({ href: "https://github.com/acme/w/pull/12", rel: "noopener noreferrer", target: "_blank" });
  });

  it("starts a fix and opens the run", async () => {
    api.fixCiFailure.mockResolvedValue({ failure: failure(12, { status: "started" }), run: { id: "run_1" } });
    const w = await mountList([failure(12)]);
    await w.findAll("button")[0]!.trigger("click");
    await flushPromises();
    expect(api.fixCiFailure).toHaveBeenCalledWith("cif_12");
    expect(push).toHaveBeenCalledWith("/runs/run_1");
  });

  it("shows why a fix could not start, and stays on Home", async () => {
    api.fixCiFailure.mockRejectedValue(new Error("this failure is started, not open"));
    const w = await mountList([failure(12)]);
    await w.findAll("button")[0]!.trigger("click");
    await flushPromises();
    expect(w.find("[role=alert]").text()).toBe("this failure is started, not open");
    expect(push).not.toHaveBeenCalled();
  });

  it("dismisses a failure and reloads the list", async () => {
    api.dismissCiFailure.mockResolvedValue(failure(12, { status: "dismissed" }));
    const w = await mountList([failure(12)]);
    api.ciFailures.mockResolvedValue([]);
    await w.findAll("button")[1]!.trigger("click");
    await flushPromises();
    expect(api.dismissCiFailure).toHaveBeenCalledWith("cif_12");
    expect(w.find("[data-testid=ci-failures]").exists()).toBe(false);
  });

  it("gives a paired phone the list without the buttons", async () => {
    device.value = true;
    const w = await mountList([failure(12)]);
    expect(w.text()).toContain("PR 12");
    expect(w.findAll("button")).toHaveLength(0);
    expect(w.findAll("a")).toHaveLength(1);
  });

  it("refetches when a ci.failure event arrives", async () => {
    vi.useFakeTimers();
    try {
      const pinia = createPinia();
      setActivePinia(pinia);
      api.ciFailures.mockResolvedValue([]);
      const store = useCiStore();
      store.apply({ type: "ci.failure.detected" } as never);
      store.apply({ type: "run.created" } as never);
      await vi.advanceTimersByTimeAsync(300);
      expect(api.ciFailures).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
