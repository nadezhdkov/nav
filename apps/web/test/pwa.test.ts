import type { DeviceSession, RunView } from "@navarch/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.ts";

const api = vi.hoisted(() => ({ runs: vi.fn(), approvals: vi.fn(), fleet: vi.fn(), stopAll: vi.fn() }));
vi.mock("../src/api/client.ts", async (orig) => ({ ...(await orig<object>()), api }));

const session = await import("../src/api/session.ts");
const { clearToken, setToken } = await import("../src/api/token.ts");
const { default: QrCode } = await import("../src/components/QrCode.vue");
const { default: HomeView } = await import("../src/views/HomeView.vue");
const { useApprovalsStore, useRunsStore } = await import("../src/stores/runs.ts");
const { base64UrlToBytes, isIos, isStandalone } = await import("../src/lib/push.ts");

const global = { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } };

function deviceSession(n: number, ttlMs = 15 * 60_000): DeviceSession {
  return {
    device: { id: "dev_1", name: "Pixel", paired_at: "2026-10-15T00:00:00Z", last_seen_at: null, revoked_at: null, push: false },
    access_token: `nvd_access${n}`,
    access_expires_at: new Date(Date.now() + ttlMs).toISOString(),
    refresh_token: `nvr_refresh${n}`,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  setActivePinia(createPinia());
  for (const fn of Object.values(api)) fn.mockReset();
  clearToken();
  session.forgetDevice();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("device session (ADR 0020)", () => {
  it("pairs, keeps the refresh token in localStorage and the access token in memory only", async () => {
    const fetch = vi.fn().mockResolvedValue(json(deviceSession(1), 201));
    vi.stubGlobal("fetch", fetch);
    expect(await session.pairDevice("code123", "Pixel")).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/v1/devices/pair", expect.objectContaining({ body: JSON.stringify({ code: "code123", name: "Pixel" }) }));
    expect(session.isDevice.value).toBe(true);
    const stored = localStorage.getItem("navarch.device")!;
    expect(stored).toContain("nvr_refresh1");
    expect(stored).not.toContain("nvd_access1");
    expect(await session.bearer()).toBe("nvd_access1");
  });

  it("refreshes an expiring access token once, even when asked twice at the same time", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(deviceSession(1, 30_000), 201)).mockResolvedValueOnce(json(deviceSession(2)));
    vi.stubGlobal("fetch", fetch);
    await session.pairDevice("c", "Pixel");
    const [a, b] = await Promise.all([session.bearer(), session.bearer()]);
    expect([a, b]).toEqual(["nvd_access2", "nvd_access2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1].body).toBe(JSON.stringify({ refresh_token: "nvr_refresh1" }));
    expect(localStorage.getItem("navarch.device")).toContain("nvr_refresh2");
  });

  it("forgets the device when the daemon refuses its refresh token", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(deviceSession(1, 0), 201)).mockResolvedValueOnce(json({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetch);
    await session.pairDevice("c", "Pixel");
    expect(await session.bearer()).toBeNull();
    expect(session.isDevice.value).toBe(false);
    expect(localStorage.getItem("navarch.device")).toBeNull();
  });

  it("prefers the local token on the desktop", async () => {
    setToken("local-token");
    expect(await session.bearer()).toBe("local-token");
  });
});

describe("QrCode", () => {
  it("draws the modules as one SVG path, without innerHTML", () => {
    const wrapper = mount(QrCode, { props: { value: "https://pc.tail.ts.net/#pair=abc", label: "Pair" } });
    expect(wrapper.attributes("role")).toBe("img");
    expect(wrapper.attributes("aria-label")).toBe("Pair");
    expect(wrapper.find("path").attributes("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  });
});

describe("HomeView", () => {
  const run = (id: string, status: RunView["status"]): RunView => ({
    id,
    status,
    repo_path: "/src/widget",
    base_commit: "abc",
    prompt: `Work ${id}`,
    budget: 2,
    cost_total: 0.25,
    plan_cost: 0,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    ended_at: null,
    work_item: null,
    pr_url: null,
    flow: "task",
    autonomy_level: 2,
  });

  it("shows waiting approvals, active runs only, and stops everything after confirming", async () => {
    api.runs.mockResolvedValue([run("run_a", "executing"), run("run_b", "done"), run("run_c", "paused")]);
    api.approvals.mockResolvedValue([{ id: "apr_1", status: "pending" }]);
    api.stopAll.mockResolvedValue({ paused: ["run_a"] });
    await useRunsStore().load();
    await useApprovalsStore().load();
    const wrapper = mount(HomeView, { global });
    expect(wrapper.text()).toContain("1 approval(s) waiting for you");
    expect(wrapper.text()).toContain("Work run_a");
    expect(wrapper.text()).toContain("Work run_c");
    expect(wrapper.text()).not.toContain("Work run_b");

    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    await wrapper.findAll("button").find((b) => b.text().includes("Stop everything"))!.trigger("click");
    await flushPromises();
    // Only the executing run counts; the paused one is already stopped.
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Pauses 1 active run(s)"));
    expect(api.stopAll).toHaveBeenCalled();
    expect(wrapper.text()).toContain("Paused 1 run(s)");
  });

  it("does not stop anything when the confirmation is declined", async () => {
    api.runs.mockResolvedValue([run("run_a", "executing")]);
    api.approvals.mockResolvedValue([]);
    await useRunsStore().load();
    const wrapper = mount(HomeView, { global });
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    await wrapper.findAll("button").find((b) => b.text().includes("Stop everything"))!.trigger("click");
    expect(api.stopAll).not.toHaveBeenCalled();
  });
});

describe("push helpers", () => {
  it("decodes the VAPID key and recognises iOS outside the home screen", () => {
    expect([...base64UrlToBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
    const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 } as Navigator;
    expect(isIos(iphone)).toBe(true);
    const win = { matchMedia: () => ({ matches: false }) } as unknown as Window;
    expect(isStandalone(win, iphone)).toBe(false);
    expect(isStandalone(win, { ...iphone, standalone: true } as Navigator)).toBe(true);
  });
});
