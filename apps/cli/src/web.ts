import { spawn } from "node:child_process";
import type { WebCode } from "@navarch/contracts";

export type WebApi = { readonly url: string; request<T>(method: string, path: string, body?: unknown): Promise<T> };
export type Opener = (url: string) => Promise<boolean>;

/**
 * `navarch web`: the Web UI's address with a single-use sign-in code in the fragment (ADR 0017).
 * The code, not the token, goes to the browser's command line, and it stops working once used.
 */
export async function webUrl(api: WebApi): Promise<string> {
  const { code } = await api.request<WebCode>("POST", "/api/v1/web/codes");
  return `${api.url}/#code=${code}`;
}

/** Opens a URL in the default browser; resolves false when no opener could start. */
export const openInBrowser: Opener = (url) =>
  new Promise((resolve) => {
    const [cmd, args] =
      process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
