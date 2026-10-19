import { describe, expect, it } from "vitest";
import { openInBrowser, webUrl, type WebApi } from "../src/web.ts";

describe("navarch web", () => {
  it("asks the daemon for a single-use code and puts it in the URL fragment, not the token", async () => {
    const calls: string[] = [];
    const api: WebApi = {
      url: "http://127.0.0.1:7420",
      async request<T>(method: string, path: string): Promise<T> {
        calls.push(`${method} ${path}`);
        return { code: "c0de_abc", expires_at: "2026-10-15T00:01:00Z" } as T;
      },
    };
    expect(await webUrl(api)).toBe("http://localhost:7420/#code=c0de_abc");
    expect(calls).toEqual(["POST /api/v1/web/codes"]);
  });

  it("opens only http(s) URLs, and never starts an opener for anything else", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://host/x", "not a url", "-oProxyCommand=x", "calc.exe & whoami"]) {
      expect(await openInBrowser(url), url).toBe(false);
    }
  });
});
