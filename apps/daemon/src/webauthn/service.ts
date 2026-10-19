import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { type Actor, type RegisterKeyRequest, type ReauthOptions, type ReauthPurpose, type ReauthToken, type ReauthVerifyRequest, type RegistrationOptions, type SecurityKeysView, type SecurityKeyView } from "@navarch/contracts";
import type { EventStore } from "../events/store.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import { verifyAssertion, verifyRegistration, WebAuthnError, type PublicKeyJwk } from "./verify.ts";

const CHALLENGE_TTL_MS = 2 * 60_000;
const TOKEN_TTL_MS = 2 * 60_000;
const MAX_PENDING = 50;

export class WebAuthnServiceError extends Error {
  readonly code: "bad_request" | "forbidden" | "not_found" | "conflict" | "reauth_required";
  constructor(code: WebAuthnServiceError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type Pending = { challenge: string; kind: "register" | "reauth"; purpose?: ReauthPurpose; rpId: string; origin: string; expires: number };

type KeyRow = { id: string; name: string; rp_id: string; public_key: string; sign_count: number; created_at: string; last_used_at: string | null };

/**
 * Security keys (WebAuthn, spec §11.1, ADR 0062): the user registers keys and proves presence with
 * one before a sensitive action. Challenges and the tokens a proof earns live in memory, single use
 * and short; the keys' public parts live in a table that is not a projection, and registering,
 * removing and using a key are events without secrets. Only the user, from the desktop, gets here.
 */
export class WebAuthnService {
  private readonly deps: { store: EventStore; policy: PolicyEngine; allowedOrigin: (origin: string) => boolean; autonomyLevel: number; now?: () => number };
  private readonly challenges = new Map<string, Pending>();
  private readonly tokens = new Map<string, { purpose: ReauthPurpose; expires: number }>();

  constructor(deps: WebAuthnService["deps"]) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private rows(): KeyRow[] {
    return this.deps.store.db.prepare("SELECT * FROM webauthn_credentials ORDER BY created_at").all() as KeyRow[];
  }

  /** Whether sensitive actions now need a key. */
  required(): boolean {
    return this.rows().length > 0;
  }

  /** The keys, and whether this address can use them at all (WebAuthn needs a domain name, not an IP). */
  view(origin?: string): SecurityKeysView {
    const keys: SecurityKeyView[] = this.rows().map((r) => ({ id: r.id, name: r.name, rp_id: r.rp_id, created_at: r.created_at, last_used_at: r.last_used_at }));
    return { keys, unavailable: origin ? this.unusable(origin) ?? null : null };
  }

  private unusable(origin: string | undefined): string | undefined {
    if (!origin) return "the browser sent no origin";
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return "the origin is not a URL";
    }
    if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return "security keys need a domain name: open Navarch at http://localhost (navarch web does) instead of an IP address";
    if (!this.deps.allowedOrigin(url.origin)) return `${url.origin} is not an address Navarch serves (localhost, or the Tailscale name)`;
    return undefined;
  }

  private user(actor: Actor): void {
    const decision = this.deps.policy.decide(actor, "webauthn.set", "security-keys", { autonomyLevel: this.deps.autonomyLevel });
    if (decision.effect !== "allow") throw new WebAuthnServiceError("forbidden", decision.reason);
  }

  private issue(pending: Omit<Pending, "challenge" | "expires">): { id: string; challenge: string } {
    const now = this.now();
    for (const [id, p] of this.challenges) if (p.expires <= now) this.challenges.delete(id);
    if (this.challenges.size >= MAX_PENDING) throw new WebAuthnServiceError("conflict", "too many pending challenges; try again in a minute");
    const id = `wac_${randomBytes(9).toString("base64url")}`;
    const challenge = randomBytes(32).toString("base64url");
    this.challenges.set(id, { ...pending, challenge, expires: now + CHALLENGE_TTL_MS });
    return { id, challenge };
  }

  /** A challenge is used once, whether or not the answer holds. */
  private take(id: string, kind: Pending["kind"], origin: string): Pending {
    const p = this.challenges.get(id);
    this.challenges.delete(id);
    if (!p || p.expires <= this.now()) throw new WebAuthnServiceError("bad_request", "the challenge expired; start again");
    if (p.kind !== kind || p.origin !== origin) throw new WebAuthnServiceError("bad_request", "the challenge belongs to another request");
    return p;
  }

  registrationOptions(origin: string | undefined, actor: Actor): RegistrationOptions {
    this.user(actor);
    const bad = this.unusable(origin);
    if (bad) throw new WebAuthnServiceError("bad_request", bad);
    const url = new URL(origin!);
    const { id, challenge } = this.issue({ kind: "register", rpId: url.hostname, origin: url.origin });
    return {
      challenge_id: id,
      publicKey: {
        challenge,
        rp: { id: url.hostname, name: "Navarch" },
        // One owner: a fixed handle, so a second key is the same account.
        user: { id: Buffer.from("navarch-owner").toString("base64url"), name: "owner", displayName: "Navarch owner" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        attestation: "none",
        excludeCredentials: this.rows().filter((r) => r.rp_id === url.hostname).map((r) => ({ type: "public-key" as const, id: r.id })),
        timeout: CHALLENGE_TTL_MS,
      },
    };
  }

  register(req: RegisterKeyRequest, origin: string | undefined, actor: Actor): SecurityKeyView {
    this.user(actor);
    // Once a key exists, adding another needs one: a stolen daemon token alone cannot plant its own.
    if (this.required() && !this.consume(req.reauth, "webauthn.change")) throw new WebAuthnServiceError("reauth_required", "adding a security key needs one you already have");
    const bad = this.unusable(origin);
    if (bad) throw new WebAuthnServiceError("bad_request", bad);
    const pending = this.take(req.challenge_id, "register", new URL(origin!).origin);
    try {
      const out = verifyRegistration({ clientDataJSON: req.clientDataJSON, attestationObject: req.attestationObject, challenge: pending.challenge, origin: pending.origin, rpId: pending.rpId });
      if (this.rows().some((r) => r.id === out.credentialId)) throw new WebAuthnServiceError("conflict", "this key is already registered");
      const created_at = new Date(this.now()).toISOString();
      this.deps.store.db
        .prepare("INSERT INTO webauthn_credentials (id, name, rp_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(out.credentialId, req.name, pending.rpId, JSON.stringify(out.publicKey), out.signCount, created_at);
      this.deps.store.append([{ type: "webauthn.registered", run_id: null, task_id: null, actor, payload: { credential_id: out.credentialId, name: req.name, rp_id: pending.rpId } }]);
      return { id: out.credentialId, name: req.name, rp_id: pending.rpId, created_at, last_used_at: null };
    } catch (err) {
      if (err instanceof WebAuthnError) throw new WebAuthnServiceError("bad_request", err.message);
      throw err;
    }
  }

  remove(id: string, reauth: string | undefined, actor: Actor): void {
    this.user(actor);
    if (!this.rows().some((r) => r.id === id)) throw new WebAuthnServiceError("not_found", "no such key");
    if (!this.consume(reauth, "webauthn.change")) throw new WebAuthnServiceError("reauth_required", "removing a security key needs one");
    this.deps.store.db.prepare("DELETE FROM webauthn_credentials WHERE id = ?").run(id);
    this.deps.store.append([{ type: "webauthn.removed", run_id: null, task_id: null, actor, payload: { credential_id: id } }]);
  }

  reauthOptions(purpose: ReauthPurpose, origin: string | undefined, actor: Actor): ReauthOptions {
    this.user(actor);
    const bad = this.unusable(origin);
    if (bad) throw new WebAuthnServiceError("bad_request", bad);
    const url = new URL(origin!);
    const allow = this.rows().filter((r) => r.rp_id === url.hostname);
    if (!allow.length) throw new WebAuthnServiceError("bad_request", `no security key is registered for ${url.hostname}; keys registered on another address do not work here`);
    const { id, challenge } = this.issue({ kind: "reauth", purpose, rpId: url.hostname, origin: url.origin });
    return { challenge_id: id, publicKey: { challenge, rpId: url.hostname, allowCredentials: allow.map((r) => ({ type: "public-key" as const, id: r.id })), userVerification: "required", timeout: CHALLENGE_TTL_MS } };
  }

  reauthVerify(req: ReauthVerifyRequest, origin: string | undefined, actor: Actor): ReauthToken {
    this.user(actor);
    const bad = this.unusable(origin);
    if (bad) throw new WebAuthnServiceError("bad_request", bad);
    const pending = this.take(req.challenge_id, "reauth", new URL(origin!).origin);
    const row = this.rows().find((r) => r.id === req.credential_id && r.rp_id === pending.rpId);
    if (!row) throw new WebAuthnServiceError("bad_request", "that key is not registered for this address");
    try {
      const { signCount } = verifyAssertion({
        clientDataJSON: req.clientDataJSON,
        authenticatorData: req.authenticatorData,
        signature: req.signature,
        challenge: pending.challenge,
        origin: pending.origin,
        rpId: pending.rpId,
        publicKey: JSON.parse(row.public_key) as PublicKeyJwk,
        signCount: row.sign_count,
      });
      this.deps.store.db.prepare("UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?").run(signCount, new Date(this.now()).toISOString(), row.id);
    } catch (err) {
      if (err instanceof WebAuthnError) throw new WebAuthnServiceError("bad_request", err.message);
      throw err;
    }
    const purpose = pending.purpose!;
    const token = randomBytes(24).toString("base64url");
    const expires = this.now() + TOKEN_TTL_MS;
    this.tokens.set(token, { purpose, expires });
    this.deps.store.append([{ type: "webauthn.reauthenticated", run_id: null, task_id: null, actor, payload: { credential_id: row.id, purpose } }]);
    return { token, purpose, expires_at: new Date(expires).toISOString() };
  }

  /** Spends a token for a purpose; false when it is missing, spent, expired or for something else. */
  consume(token: string | undefined, purpose: ReauthPurpose): boolean {
    if (!token) return false;
    const t = this.tokens.get(token);
    this.tokens.delete(token);
    return !!t && t.purpose === purpose && t.expires > this.now();
  }
}
