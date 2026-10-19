import { describe, expect, it } from "vitest";
import { accept, decodeMessage, encodeMessage, fromB64u, RelayClient, random, toB64u, type SocketLike } from "../src/index.ts";

/** A socket whose other end is a daemon in the test's hands. */
function fakeSocket() {
  const listeners: Record<string, ((e: { data: unknown }) => void)[]> = {};
  const sent: string[] = [];
  const socket: SocketLike = {
    readyState: 1,
    send: (d) => void sent.push(d),
    close: () => {},
    addEventListener: (type: string, l: (e: { data: unknown }) => void) => void (listeners[type] ??= []).push(l),
  } as SocketLike;
  const emit = (type: string, data?: unknown) => listeners[type]?.forEach((l) => l({ data }));
  return { socket, sent, emit };
}

describe("the phone's client", () => {
  it("completes a request whose answer is followed at once by a close", async () => {
    const secret = random(32);
    const { socket, sent, emit } = fakeSocket();
    const connecting = RelayClient.connect(socket, "pairing", secret, 2_000);
    await new Promise((r) => setTimeout(r, 20));
    const hello = fromB64u((JSON.parse(sent[0]!) as { d: string }).d);
    const daemon = (await accept(hello, () => [secret]))!;
    emit("message", JSON.stringify({ t: "data", d: toB64u(daemon.welcome) }));
    const client = await connecting;

    const enrolled = client.enroll("code", "Pixel");
    await new Promise((r) => setTimeout(r, 20));
    const request = decodeMessage(await daemon.session.open(fromB64u((JSON.parse(sent[1]!) as { d: string }).d)));
    const answer = await daemon.session.seal(encodeMessage({ k: "enrolled", id: request.id, session: { ok: true }, secret: toB64u(random(32)) }));
    // The daemon answers and hangs up, as it does after pairing; both reach the phone back to back.
    emit("message", JSON.stringify({ t: "data", d: toB64u(answer) }));
    emit("close");
    await expect(enrolled).resolves.toMatchObject({ session: { ok: true } });
  });

  it("fails the requests still waiting when the connection closes", async () => {
    const secret = random(32);
    const { socket, sent, emit } = fakeSocket();
    const connecting = RelayClient.connect(socket, "dev_1", secret, 2_000);
    await new Promise((r) => setTimeout(r, 20));
    const daemon = (await accept(fromB64u((JSON.parse(sent[0]!) as { d: string }).d), () => [secret]))!;
    emit("message", JSON.stringify({ t: "data", d: toB64u(daemon.welcome) }));
    const client = await connecting;
    const pending = client.fetch("GET", "/api/v1/runs");
    emit("close");
    await expect(pending).rejects.toThrow(/closed/);
  });
});
