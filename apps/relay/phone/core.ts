import { fromB64u, RelayClient, RelayClosed, toB64u, utf8, type Headers as Hdrs, type SocketLike } from "@navarch/relay-protocol";

/**
 * What the phone's loader and service worker do, without touching the browser's own objects so it runs
 * the same in tests (ADR 0067): keep a tunnel to the daemon, turn a page's request into a tunnelled one,
 * and turn the answer back into a `Response` whose links point at the relay path the app lives under.
 */

export type Creds = { deviceId: string; /** base64url */ secret: string };

export interface CredStore {
  load(relayId: string): Promise<Creds | undefined>;
  save(relayId: string, creds: Creds): Promise<void>;
  clear(relayId: string): Promise<void>;
}

/** The relay id in a path under `/r/<id>`, if it is one. */
export const relayIdOf = (pathname: string): string | undefined => /^\/r\/([A-Za-z0-9_-]{16,64})(?:\/|$)/.exec(pathname)?.[1];

export type TunnelFailure = "offline" | "refused" | "unreachable";

export class TunnelError extends Error {
  readonly reason: TunnelFailure;

  constructor(reason: TunnelFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type TunnelOptions = {
  relayId: string;
  creds: () => Promise<Creds | undefined>;
  /** A socket to `/p/<relay id>` on the relay. */
  socket: () => SocketLike;
};

/** One tunnel to the daemon, opened when first needed and again after it drops. */
export class Tunnel {
  private readonly opts: TunnelOptions;
  private current: RelayClient | undefined;
  private connecting: Promise<RelayClient> | undefined;

  constructor(opts: TunnelOptions) {
    this.opts = opts;
  }

  client(): Promise<RelayClient> {
    if (this.current) return Promise.resolve(this.current);
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  close(): void {
    this.current?.close();
    this.current = undefined;
  }

  private async open(): Promise<RelayClient> {
    const creds = await this.opts.creds();
    if (!creds) throw new TunnelError("refused", "this phone is not paired");
    try {
      const client = await RelayClient.connect(this.opts.socket(), creds.deviceId, fromB64u(creds.secret));
      client.onclose = () => {
        if (this.current === client) this.current = undefined;
      };
      this.current = client;
      return client;
    } catch (err) {
      if (err instanceof RelayClosed) {
        // 4404: the relay has no daemon for this id. Any other close after our HELLO means the daemon
        // would not answer it: a revoked device or a secret it does not know.
        throw err.code === 4404 ? new TunnelError("offline", "the computer is offline") : err.code === 1000 ? new TunnelError("refused", "the computer did not accept this phone") : new TunnelError("unreachable", err.message);
      }
      throw new TunnelError("unreachable", (err as Error).message);
    }
  }
}

/** Headers of a page's request that the daemon's API looks at; the connector drops the rest anyway. */
const FORWARD = ["authorization", "content-type", "accept", "if-none-match", "x-navarch-client"];
/** What a response may carry back to the page. */
const KEEP = ["content-type", "cache-control", "etag", "content-security-policy", "x-content-type-options", "referrer-policy"];
const NO_BODY = new Set([101, 204, 205, 304]);
/** What `new Response()` takes as a body, without naming a DOM or Node type. */
type ResponseBody = ConstructorParameters<typeof Response>[0];

/**
 * Answers a request under `scope` (`/r/<id>`) through the tunnel. HTML, CSS and the manifest are rewritten so
 * their absolute links stay under the scope; a failed tunnel is a 503, which the app reads as "the computer
 * is not reachable" and shows its offline notice.
 */
export async function respond(req: Request, scope: string, tunnel: Tunnel): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.slice(scope.length) || "/";
  const headers: Hdrs = {};
  for (const name of FORWARD) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let answer;
  try {
    const client = await tunnel.client();
    answer = await client.fetch(req.method, path + url.search, { headers, ...(hasBody ? { body: new Uint8Array(await req.arrayBuffer()) } : {}) });
  } catch (err) {
    return unavailable(req, err);
  }
  const out = new globalThis.Headers();
  for (const name of KEEP) if (answer.headers[name]) out.set(name, answer.headers[name]);
  const location = answer.headers.location;
  if (location) out.set("location", location.startsWith("/") && !location.startsWith("//") ? scope + location : location);
  const type = answer.headers["content-type"] ?? "";
  let body: ResponseBody = NO_BODY.has(answer.status) || req.method === "HEAD" ? null : (answer.body as unknown as ResponseBody);
  if (body !== null && answer.status < 300) {
    if (type.startsWith("text/html")) body = rewriteHtml(new TextDecoder().decode(answer.body), scope);
    else if (type.startsWith("text/css")) body = rewriteCss(new TextDecoder().decode(answer.body), scope);
    else if (type.startsWith("application/manifest+json")) body = rewriteManifest(new TextDecoder().decode(answer.body), scope);
  }
  return new Response(body, { status: answer.status, headers: out });
}

function unavailable(req: Request, err: unknown): Response {
  const reason = err instanceof TunnelError ? err.reason : "unreachable";
  const message = err instanceof Error ? err.message : "the computer cannot be reached";
  const wantsHtml = req.mode === "navigate" || (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
    const text = reason === "refused" ? "This phone is no longer paired with the computer. Pair it again from the computer: Settings → Devices." : "Your computer cannot be reached through the relay. Check that Navarch is running and connected, then reload.";
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Navarch</title><body style="font:16px system-ui;background:#0f1114;color:#e6e8eb;padding:2rem"><h1>Navarch</h1><p>${text}</p>`, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(JSON.stringify({ error: reason, message }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Puts the app's absolute links under the scope and tells the app where it lives (`<meta name="navarch-base">`). */
export function rewriteHtml(html: string, scope: string): string {
  const moved = html.replace(/\b(href|src|action)="\/(?!\/)/g, `$1="${scope}/`);
  return moved.replace(/<head>/i, `<head><meta name="navarch-base" content="${scope}">`);
}

export function rewriteCss(css: string, scope: string): string {
  return css.replace(/url\(\s*(["']?)\/(?!\/)/g, `url($1${scope}/`);
}

export function rewriteManifest(json: string, scope: string): string {
  const manifest = JSON.parse(json) as { id?: string; start_url?: string; scope?: string; icons?: { src?: string }[] };
  const under = (p: string | undefined) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? scope + p : p);
  manifest.id = under(manifest.id);
  manifest.start_url = under(manifest.start_url);
  manifest.scope = `${scope}/`;
  for (const icon of manifest.icons ?? []) icon.src = under(icon.src);
  return JSON.stringify(manifest);
}

/**
 * Pairing, as the loader page does it: the code from the QR link's fragment is the secret of a pairing
 * channel; one `enroll` trades it for a device session and the device's own secret.
 */
export async function pairWithCode(socket: SocketLike, code: string, name: string): Promise<{ session: unknown; creds: Creds }> {
  let client: RelayClient;
  try {
    client = await RelayClient.connect(socket, "pairing", utf8(code));
  } catch (err) {
    if (err instanceof RelayClosed && err.code === 4404) throw new TunnelError("offline", "the computer is offline");
    throw new TunnelError("refused", "the pairing code was not accepted (it works once, for five minutes)");
  }
  try {
    const done = await client.enroll(code, name);
    const session = done.session as { device?: { id?: string } };
    if (!session.device?.id) throw new TunnelError("refused", "the computer sent no device");
    return { session: done.session, creds: { deviceId: session.device.id, secret: toB64u(done.secret) } };
  } finally {
    client.close();
  }
}
