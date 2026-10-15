import { verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPayload, generateVapidKeys, sendPush, vapidAuthorization, vapidPublicKeyObject } from "../src/notifications/webpush.ts";

// RFC 8291 Section 5 and Appendix A.
const rfc = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  result:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" +
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

describe("Web Push encryption (RFC 8291)", () => {
  it("reproduces the RFC's example message", () => {
    const body = encryptPayload(
      Buffer.from(rfc.plaintext),
      { p256dh: rfc.uaPublic, auth: rfc.auth },
      { salt: Buffer.from(rfc.salt, "base64url"), serverKeys: { publicKey: rfc.asPublic, privateKey: rfc.asPrivate } },
    );
    // The header and the ciphertext are separate base64url strings in the RFC.
    const header = body.subarray(0, 86).toString("base64url");
    const ciphertext = body.subarray(86).toString("base64url");
    expect(header + ciphertext).toBe(rfc.result);
  });

  it("uses a fresh salt and key per message and rejects malformed subscription keys", () => {
    const keys = { p256dh: rfc.uaPublic, auth: rfc.auth };
    const a = encryptPayload(Buffer.from("x"), keys);
    const b = encryptPayload(Buffer.from("x"), keys);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(() => encryptPayload(Buffer.from("x"), { p256dh: "AAAA", auth: rfc.auth })).toThrow(/P-256/);
    expect(() => encryptPayload(Buffer.from("x"), { p256dh: rfc.uaPublic, auth: "AAAA" })).toThrow(/16 bytes/);
    expect(() => encryptPayload(Buffer.alloc(4096), keys)).toThrow(/too large/);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a JWT for the endpoint's origin that the public key verifies", () => {
    const keys = generateVapidKeys();
    const now = Date.UTC(2026, 9, 15);
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:ops@example.org", now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, h, c, s, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:ops@example.org",
    });
    const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key: vapidPublicKeyObject(keys), dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("sendPush", () => {
  it("POSTs the encrypted payload with the push headers", async () => {
    const vapid = generateVapidKeys();
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const target = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc", keys: { p256dh: rfc.uaPublic, auth: rfc.auth } };
    const res = await sendPush(target, { title: "Approval needed" }, { vapid, subject: "mailto:a@b.c", urgency: "high", topic: "run_1-approval", fetch: fake });
    expect(res.status).toBe(201);
    const headers = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe(target.endpoint);
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.urgency).toBe("high");
    expect(headers.topic).toBe("run_1-approval");
    expect(headers.ttl).toBe("86400");
    expect(headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect((seen!.init.body as Buffer).includes(Buffer.from("Approval"))).toBe(false);
  });
});
