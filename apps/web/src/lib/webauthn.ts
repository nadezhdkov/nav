import type { ReauthOptions, RegistrationOptions } from "@navarch/contracts";

/** The browser side of WebAuthn: binary fields travel as base64url, the browser wants ArrayBuffers (ADR 0062). */

const toBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const toB64u = (buf: ArrayBuffer): string => {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const webauthnSupported = (): boolean => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/** Asks the user's authenticator for a new key; the answer is what `POST /api/v1/security-keys/register` takes. */
export async function createKey(o: RegistrationOptions): Promise<{ clientDataJSON: string; attestationObject: string }> {
  const p = o.publicKey;
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: toBytes(p.challenge),
      rp: p.rp,
      user: { id: toBytes(p.user.id), name: p.user.name, displayName: p.user.displayName },
      pubKeyCredParams: p.pubKeyCredParams,
      authenticatorSelection: p.authenticatorSelection,
      attestation: p.attestation,
      excludeCredentials: p.excludeCredentials.map((c) => ({ type: c.type, id: toBytes(c.id) })),
      timeout: p.timeout,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no key answered");
  const r = cred.response as AuthenticatorAttestationResponse;
  return { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject) };
}

/** Asks the user to touch a registered key; the answer is what `POST /api/v1/reauth/verify` takes. */
export async function useKey(o: ReauthOptions): Promise<{ credential_id: string; clientDataJSON: string; authenticatorData: string; signature: string }> {
  const p = o.publicKey;
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: toBytes(p.challenge),
      rpId: p.rpId,
      allowCredentials: p.allowCredentials.map((c) => ({ type: c.type, id: toBytes(c.id) })),
      userVerification: p.userVerification,
      timeout: p.timeout,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no key answered");
  const r = cred.response as AuthenticatorAssertionResponse;
  return { credential_id: toB64u(cred.rawId), clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature) };
}
