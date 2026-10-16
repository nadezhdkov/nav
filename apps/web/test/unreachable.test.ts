import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, authorized, reachable } from "../src/api/client.ts";
import { forgetDevice, isDevice } from "../src/api/session.ts";
import { clearToken, setToken } from "../src/api/token.ts";

/** A paired phone whose access token must be refreshed before the next request. */
function pairedPhone() {
  clearToken();
  localStorage.setItem("navarch.device", JSON.stringify({ device_id: "dev_1", name: "Phone", refresh_token: "rt_1" }));
  isDevice.value = true;
  authorized.value = true;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  forgetDevice();
  clearToken();
  reachable.value = true;
  authorized.value = true;
});

describe("an unreachable daemon (go/no-go F2)", () => {
  it("is not an empty answer: a network failure throws unreachable and marks the daemon unreachable", async () => {
    setToken("tok");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await api.approvals().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "unreachable" });
    expect(reachable.value).toBe(false);
    expect(authorized.value).toBe(true);
  });

  it("treats a gateway error from tailscale serve as unreachable, and recovers on the next answer", async () => {
    setToken("tok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 502 })).mockResolvedValueOnce(new Response("[]", { status: 200 })));
    await expect(api.approvals()).rejects.toMatchObject({ code: "unreachable" });
    expect(reachable.value).toBe(false);
    expect(await api.approvals()).toEqual([]);
    expect(reachable.value).toBe(true);
  });

  it("keeps a paired phone paired when its token refresh cannot reach the daemon", async () => {
    pairedPhone();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502 })));
    await expect(api.approvals()).rejects.toMatchObject({ code: "unreachable" });
    expect(authorized.value).toBe(true);
    expect(isDevice.value).toBe(true);
    expect(localStorage.getItem("navarch.device")).not.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    await expect(api.approvals()).rejects.toMatchObject({ code: "unreachable" });
    expect(isDevice.value).toBe(true);
  });
});
