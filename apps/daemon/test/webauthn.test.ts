import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { join } from "node:path";
import type { Actor, NewEvent, ReauthOptions, RegistrationOptions } from "@navarch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { Config } from "../src/config.ts";
import { EventStore } from "../src/events/store.ts";
import { AutoMerger } from "../src/github/automerge.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { decodeCbor } from "../src/webauthn/cbor.ts";
import { WebAuthnService, WebAuthnServiceError } from "../src/webauthn/service.ts";

const user: Actor = { kind: "user", via: "web" };
const phone: Actor = { kind: "user", via: "mobile", device_id: "dev_1" };
const ORIGIN = "http://localhost:7420";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

// --- a software authenticator: what a security key does, with node:crypto ---

function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const entries = [...(v as Map<unknown, unknown>).entries()];
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

class Key {
  readonly id = randomBytes(16);
  readonly pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  counter = 0;

  create(o: RegistrationOptions, origin = ORIGIN, flags = 0x45): { clientDataJSON: string; attestationObject: string } {
    const jwk = this.pair.publicKey.export({ format: "jwk" });
    const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const authData = Buffer.concat([sha(o.publicKey.rp.id), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, this.id.length]), this.id, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: o.publicKey.challenge, origin }));
    return { clientDataJSON: clientData.toString("base64url"), attestationObject: cbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])).toString("base64url") };
  }

  get(o: ReauthOptions, opts: { origin?: string; flags?: number; counter?: number; signer?: KeyObject } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(o.publicKey.rpId), Buffer.from([opts.flags ?? 0x05]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: o.publicKey.challenge, origin: opts.origin ?? ORIGIN }));
    const signature = sign("sha256", Buffer.concat([authData, sha(clientData)]), { key: opts.signer ?? this.pair.privateKey, dsaEncoding: "der" });
    return { challenge_id: o.challenge_id, credential_id: this.id.toString("base64url"), clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") };
  }
}

describe("CBOR", () => {
  it("reads what a security key sends, and refuses what it does not understand", () => {
    const m = decodeCbor(cbor(new Map<unknown, unknown>([["fmt", "none"], [1, -7], ["id", Buffer.from([1, 2, 3])]]))).value as Map<unknown, unknown>;
    expect(m.get("fmt")).toBe("none");
    expect(m.get(1)).toBe(-7);
    expect(m.get("id")).toEqual(Buffer.from([1, 2, 3]));
    expect(() => decodeCbor(Buffer.from([0x5f]))).toThrow(); // indefinite length
    expect(() => decodeCbor(Buffer.from([0x43, 1]))).toThrow(); // truncated
  });
});

describe("security keys", () => {
  let store: EventStore;
  let now = Date.now();
  let svc: WebAuthnService;
  beforeEach(() => {
    store = new EventStore(join(tempHome(), "navarch.db"));
    now = Date.now();
    svc = new WebAuthnService({ store, policy: new PolicyEngine(), autonomyLevel: 3, allowedOrigin: (o) => /^http:\/\/localhost(:\d+)?$/.test(o), now: () => now });
  });
  afterEach(() => store.close());

  function register(key: Key, name = "YubiKey", reauth?: string) {
    const options = svc.registrationOptions(ORIGIN, user);
    return svc.register({ challenge_id: options.challenge_id, name, ...(reauth ? { reauth } : {}), ...key.create(options) }, ORIGIN, user);
  }
  function reauth(key: Key, purpose: "automerge.enable" | "webauthn.change" = "webauthn.change", tweak?: Parameters<Key["get"]>[1]) {
    const options = svc.reauthOptions(purpose, ORIGIN, user);
    return svc.reauthVerify(key.get(options, tweak), ORIGIN, user);
  }
  const fails = (fn: () => unknown, code: string, message?: RegExp) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(WebAuthnServiceError);
      expect((err as WebAuthnServiceError).code).toBe(code);
      if (message) expect((err as Error).message).toMatch(message);
      return;
    }
    throw new Error("expected a failure");
  };

  it("registers a key, records it without secrets, and proves presence with it", () => {
    const key = new Key();
    expect(svc.required()).toBe(false);
    const view = register(key);
    expect(view).toMatchObject({ name: "YubiKey", rp_id: "localhost" });
    expect(svc.required()).toBe(true);
    const event = store.events({}).find((e) => e.type === "webauthn.registered");
    expect(JSON.stringify(event)).not.toContain("publicKey");

    const token = reauth(key, "automerge.enable");
    expect(svc.consume(token.token, "automerge.enable")).toBe(true);
    expect(svc.consume(token.token, "automerge.enable")).toBe(false);
    expect(svc.view(ORIGIN).keys[0]?.last_used_at).not.toBeNull();
    expect(store.events({}).some((e) => e.type === "webauthn.reauthenticated")).toBe(true);
  });

  it("scopes a token to its purpose and to two minutes", () => {
    const key = new Key();
    register(key);
    expect(svc.consume(reauth(key, "webauthn.change").token, "automerge.enable")).toBe(false);
    const late = reauth(key, "automerge.enable");
    now += 2 * 60_000 + 1;
    expect(svc.consume(late.token, "automerge.enable")).toBe(false);
  });

  it("refuses what a phone, an IP address or a stranger sends", () => {
    fails(() => svc.registrationOptions(ORIGIN, phone), "forbidden");
    fails(() => svc.registrationOptions(ORIGIN, { kind: "agent", profile: "implementer", adapter: "x" }), "forbidden");
    fails(() => svc.registrationOptions("http://127.0.0.1:7420", user), "bad_request", /domain name/);
    fails(() => svc.registrationOptions("https://evil.example", user), "bad_request", /not an address/);
    expect(svc.view("http://127.0.0.1:7420").unavailable).toMatch(/domain name/);
  });

  it("checks the registration: challenge, origin, user verification", () => {
    const key = new Key();
    const o = svc.registrationOptions(ORIGIN, user);
    fails(() => svc.register({ challenge_id: o.challenge_id, name: "k", ...key.create({ ...o, publicKey: { ...o.publicKey, challenge: "other" } }) }, ORIGIN, user), "bad_request", /challenge/);
    // The challenge was spent by the failed try.
    fails(() => svc.register({ challenge_id: o.challenge_id, name: "k", ...key.create(o) }, ORIGIN, user), "bad_request", /expired/);
    const o2 = svc.registrationOptions(ORIGIN, user);
    fails(() => svc.register({ challenge_id: o2.challenge_id, name: "k", ...key.create(o2, "http://localhost:9999") }, ORIGIN, user), "bad_request", /origin/);
    const o3 = svc.registrationOptions(ORIGIN, user);
    fails(() => svc.register({ challenge_id: o3.challenge_id, name: "k", ...key.create(o3, ORIGIN, 0x41) }, ORIGIN, user), "bad_request", /not verified/);
    expect(svc.required()).toBe(false);
  });

  it("checks the assertion: signature, origin, user verification and the counter", () => {
    const key = new Key();
    register(key);
    fails(() => reauth(key, "webauthn.change", { signer: new Key().pair.privateKey }), "bad_request", /signature/);
    fails(() => reauth(key, "webauthn.change", { origin: "http://localhost:1" }), "bad_request", /origin/);
    fails(() => reauth(key, "webauthn.change", { flags: 0x01 }), "bad_request", /not verified/);
    reauth(key, "webauthn.change", { counter: 10 });
    fails(() => reauth(key, "webauthn.change", { counter: 10 }), "bad_request", /counter/);
    fails(() => reauth(key, "webauthn.change", { counter: 3 }), "bad_request", /counter/);
    reauth(key, "webauthn.change", { counter: 11 });
  });

  it("does not let a challenge be used twice, or after it expired", () => {
    const key = new Key();
    register(key);
    const o = svc.reauthOptions("webauthn.change", ORIGIN, user);
    const answer = key.get(o);
    svc.reauthVerify(answer, ORIGIN, user);
    fails(() => svc.reauthVerify(answer, ORIGIN, user), "bad_request", /expired/);
    const o2 = svc.reauthOptions("webauthn.change", ORIGIN, user);
    now += 2 * 60_000 + 1;
    fails(() => svc.reauthVerify(key.get(o2), ORIGIN, user), "bad_request", /expired/);
  });

  it("needs a key you already have to add or remove one", () => {
    const first = new Key();
    const second = new Key();
    register(first);
    fails(() => register(second, "second"), "reauth_required");
    const added = register(second, "second", reauth(first).token);
    expect(svc.view().keys).toHaveLength(2);
    fails(() => svc.remove(added.id, undefined, user), "reauth_required");
    svc.remove(added.id, reauth(first).token, user);
    expect(svc.view().keys).toHaveLength(1);
    expect(store.events({}).some((e) => e.type === "webauthn.removed")).toBe(true);
  });

  it("gates turning on auto-merge once a key exists, and only then", async () => {
    store.append([{ type: "project.added", run_id: null, task_id: null, actor: user, payload: { project_id: "prj_1", name: "r", repo: "o/r", path: "/nonexistent" } } as NewEvent]);
    const merger = new AutoMerger({ config: Config.parse({ autonomy_level: 3 }), store, policy: new PolicyEngine(), github: { mergeFacts: vi.fn(), autoMerge: vi.fn() }, reauth: svc });
    await expect(merger.set("prj_1", { enabled: true, confirm: "o/r" }, user)).resolves.toMatchObject({ enabled: true });
    await merger.set("prj_1", { enabled: false }, user);

    const key = new Key();
    register(key);
    await expect(merger.set("prj_1", { enabled: true, confirm: "o/r" }, user)).rejects.toMatchObject({ code: "reauth_required" });
    await expect(merger.set("prj_1", { enabled: true, confirm: "o/r", reauth: "made-up" }, user)).rejects.toMatchObject({ code: "reauth_required" });
    const token = reauth(key, "automerge.enable").token;
    await expect(merger.set("prj_1", { enabled: true, confirm: "wrong/name", reauth: token }, user)).rejects.toMatchObject({ code: "bad_request" });
    await expect(merger.set("prj_1", { enabled: true, confirm: "o/r", reauth: token }, user)).resolves.toMatchObject({ enabled: true });
    // A spent token buys nothing a second time, even for a repository that is already on.
    await expect(merger.set("prj_1", { enabled: true, confirm: "o/r", reauth: token }, user)).rejects.toMatchObject({ code: "reauth_required" });
    // Turning off never needs the key.
    await expect(merger.set("prj_1", { enabled: false }, user)).resolves.toMatchObject({ enabled: false });
  });
});
