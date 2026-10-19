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
  // WebAuthn needs a domain name for the page: localhost reaches the same loopback daemon as 127.0.0.1 (ADR 0062).
  return `${api.url.replace(/^http:\/\/127\.0\.0\.1(?=[:/]|$)/, "http://localhost")}/#code=${code}`;
}

/**
 * Opens a URL in the default browser; resolves false when no opener could start. Only http(s) URLs
 * are opened, and each platform's opener gets the URL as one argument, never through a shell: on
 * Windows `rundll32` takes it as is, where `cmd /c start` would read `&` and `|` as commands.
 */
export const openInBrowser: Opener = (url) =>
  new Promise((resolve) => {
    let target: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return resolve(false);
      target = parsed.href;
    } catch {
      return resolve(false);
    }
    const [cmd, args] =
      process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", target]] : ["xdg-open", [target]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
