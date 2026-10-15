import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorized, signInFromFragment } from "../src/api/client.ts";
import { clearToken, getToken } from "../src/api/token.ts";

function at(url: string) {
  const u = new URL(url);
  const replaced: string[] = [];
  const location = { hash: u.hash, pathname: u.pathname, search: u.search } as Location;
  const history = { state: null, replaceState: (_s: unknown, _t: string, to: string) => replaced.push(to) } as unknown as History;
  return { location, history, replaced };
}

beforeEach(() => {
  clearToken();
  authorized.value = false;
  vi.unstubAllGlobals();
});

describe("signInFromFragment", () => {
  it("trades a #code for the token and clears it from the address", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "tok_secret" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { location, history, replaced } = at("http://127.0.0.1:7420/runs/run_1#code=abc");
    await signInFromFragment(location, history);
    expect(replaced).toEqual(["/runs/run_1"]);
    expect(fetch).toHaveBeenCalledWith("/api/v1/web/exchange", expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "abc" }) }));
    expect(getToken()).toBe("tok_secret");
    expect(authorized.value).toBe(true);
  });

  it("stays signed out when the code was already used", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const { location, history, replaced } = at("http://127.0.0.1:7420/#code=used");
    await signInFromFragment(location, history);
    expect(replaced).toEqual(["/"]);
    expect(getToken()).toBeNull();
    expect(authorized.value).toBe(false);
  });

  it("does nothing without a fragment", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { location, history, replaced } = at("http://127.0.0.1:7420/approvals");
    await signInFromFragment(location, history);
    expect(fetch).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
  });
});
