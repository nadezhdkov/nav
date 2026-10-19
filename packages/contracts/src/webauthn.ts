import { z } from "zod";

/** Security keys and re-authentication (spec §11.1, ADR 0062). Binary fields are base64url. */

export const ReauthPurpose = z.enum(["automerge.enable", "webauthn.change"]);
export type ReauthPurpose = z.infer<typeof ReauthPurpose>;

export const SecurityKeyView = z.object({
  id: z.string(),
  name: z.string(),
  rp_id: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});
export type SecurityKeyView = z.infer<typeof SecurityKeyView>;

export const SecurityKeysView = z.object({
  keys: z.array(SecurityKeyView),
  /** Why a key cannot be registered or used from this address (an IP address is not a valid relying party), if so. */
  unavailable: z.string().nullable(),
});
export type SecurityKeysView = z.infer<typeof SecurityKeysView>;

/** What `navigator.credentials.create({ publicKey })` takes, with binary fields as base64url. */
export const RegistrationOptions = z.object({
  challenge_id: z.string(),
  publicKey: z.object({
    challenge: z.string(),
    rp: z.object({ id: z.string(), name: z.string() }),
    user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
    pubKeyCredParams: z.array(z.object({ type: z.literal("public-key"), alg: z.number().int() })),
    authenticatorSelection: z.object({ residentKey: z.literal("preferred"), userVerification: z.literal("required") }),
    attestation: z.literal("none"),
    excludeCredentials: z.array(z.object({ type: z.literal("public-key"), id: z.string() })),
    timeout: z.number().int().positive(),
  }),
});
export type RegistrationOptions = z.infer<typeof RegistrationOptions>;

export const RegisterKeyRequest = z.object({
  challenge_id: z.string(),
  name: z.string().trim().min(1).max(60),
  /** Needed when a key is already registered (purpose `webauthn.change`). */
  reauth: z.string().optional(),
  clientDataJSON: z.string(),
  attestationObject: z.string(),
});
export type RegisterKeyRequest = z.infer<typeof RegisterKeyRequest>;

export const ReauthOptionsRequest = z.object({ purpose: ReauthPurpose });
export type ReauthOptionsRequest = z.infer<typeof ReauthOptionsRequest>;

/** What `navigator.credentials.get({ publicKey })` takes. */
export const ReauthOptions = z.object({
  challenge_id: z.string(),
  publicKey: z.object({
    challenge: z.string(),
    rpId: z.string(),
    allowCredentials: z.array(z.object({ type: z.literal("public-key"), id: z.string() })),
    userVerification: z.literal("required"),
    timeout: z.number().int().positive(),
  }),
});
export type ReauthOptions = z.infer<typeof ReauthOptions>;

export const ReauthVerifyRequest = z.object({
  challenge_id: z.string(),
  credential_id: z.string(),
  clientDataJSON: z.string(),
  authenticatorData: z.string(),
  signature: z.string(),
});
export type ReauthVerifyRequest = z.infer<typeof ReauthVerifyRequest>;

/** Single use, for one purpose, valid for two minutes. */
export const ReauthToken = z.object({ token: z.string(), purpose: ReauthPurpose, expires_at: z.string() });
export type ReauthToken = z.infer<typeof ReauthToken>;
