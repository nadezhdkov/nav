import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { decodeCbor } from "./cbor.ts";

/**
 * WebAuthn ceremonies checked with `node:crypto` (ADR 0062). Only ES256 (P-256) keys, no attestation
 * trust (the registration asks for `none`): what matters is that the same private key signs later.
 */

export type PublicKeyJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

export class WebAuthnError extends Error {}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64u = (b: Buffer): string => b.toString("base64url");
export const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");
const sha256 = (b: Buffer | string): Buffer => createHash("sha256").update(b).digest();

type ClientData = { type: string; challenge: string; origin: string };

function checkClientData(raw: Buffer, type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): void {
  let data: ClientData;
  try {
    data = JSON.parse(raw.toString("utf8")) as ClientData;
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON");
  }
  if (data.type !== type) throw new WebAuthnError(`wrong ceremony type: ${String(data.type)}`);
  if (data.challenge !== challenge) throw new WebAuthnError("the challenge does not match");
  if (data.origin !== origin) throw new WebAuthnError(`the origin ${String(data.origin)} is not ${origin}`);
}

function parseAuthData(authData: Buffer): { rpIdHash: Buffer; flags: number; signCount: number; rest: Buffer } {
  if (authData.length < 37) throw new WebAuthnError("authenticator data is too short");
  return { rpIdHash: authData.subarray(0, 32), flags: authData[32]!, signCount: authData.readUInt32BE(33), rest: authData.subarray(37) };
}

function checkUser(rpId: string, a: ReturnType<typeof parseAuthData>): void {
  if (!a.rpIdHash.equals(sha256(rpId))) throw new WebAuthnError("the relying party id does not match");
  if (!(a.flags & FLAG_UP)) throw new WebAuthnError("the user was not present");
  if (!(a.flags & FLAG_UV)) throw new WebAuthnError("the user was not verified (PIN, fingerprint or similar is required)");
}

/** The new credential from a `navigator.credentials.create()` result. */
export function verifyRegistration(input: { clientDataJSON: string; attestationObject: string; challenge: string; origin: string; rpId: string }): { credentialId: string; publicKey: PublicKeyJwk; signCount: number } {
  checkClientData(fromB64u(input.clientDataJSON), "webauthn.create", input.challenge, input.origin);
  let attestation: unknown;
  try {
    attestation = decodeCbor(fromB64u(input.attestationObject)).value;
  } catch (err) {
    throw new WebAuthnError((err as Error).message);
  }
  if (!(attestation instanceof Map) || !Buffer.isBuffer(attestation.get("authData"))) throw new WebAuthnError("the attestation object has no authData");
  const auth = parseAuthData(attestation.get("authData") as Buffer);
  checkUser(input.rpId, auth);
  if (!(auth.flags & FLAG_AT)) throw new WebAuthnError("no credential in the authenticator data");
  const rest = auth.rest;
  if (rest.length < 18) throw new WebAuthnError("attested credential data is too short");
  const idLength = rest.readUInt16BE(16);
  if (idLength < 1 || idLength > 1023 || rest.length < 18 + idLength) throw new WebAuthnError("bad credential id length");
  const credentialId = b64u(rest.subarray(18, 18 + idLength));
  let cose: unknown;
  try {
    cose = decodeCbor(rest.subarray(18 + idLength)).value;
  } catch (err) {
    throw new WebAuthnError((err as Error).message);
  }
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw new WebAuthnError("only ES256 (P-256) keys are supported");
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new WebAuthnError("bad public key coordinates");
  const publicKey: PublicKeyJwk = { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) };
  try {
    createPublicKey({ key: publicKey, format: "jwk" });
  } catch {
    throw new WebAuthnError("the public key is not a point on P-256");
  }
  return { credentialId, publicKey, signCount: auth.signCount };
}

/** The new signature counter from a `navigator.credentials.get()` result, after checking its signature. */
export function verifyAssertion(input: {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  challenge: string;
  origin: string;
  rpId: string;
  publicKey: PublicKeyJwk;
  signCount: number;
}): { signCount: number } {
  const clientData = fromB64u(input.clientDataJSON);
  checkClientData(clientData, "webauthn.get", input.challenge, input.origin);
  const authData = fromB64u(input.authenticatorData);
  const auth = parseAuthData(authData);
  checkUser(input.rpId, auth);
  let ok = false;
  try {
    ok = cryptoVerify("sha256", Buffer.concat([authData, sha256(clientData)]), { key: createPublicKey({ key: input.publicKey, format: "jwk" }), dsaEncoding: "der" }, fromB64u(input.signature));
  } catch {
    ok = false;
  }
  if (!ok) throw new WebAuthnError("the signature is not valid");
  // A counter that does not move forward means the key may have been cloned; authenticators that keep none send 0 every time.
  if ((input.signCount > 0 || auth.signCount > 0) && auth.signCount <= input.signCount) throw new WebAuthnError("the signature counter did not advance: the key may be cloned");
  return { signCount: auth.signCount };
}
