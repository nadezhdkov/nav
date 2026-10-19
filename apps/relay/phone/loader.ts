import { pairWithCode, relayIdOf, TunnelError } from "./core.ts";
import { credStore } from "./store.ts";

/**
 * The loader page the relay serves at `/r/<relay id>/` (ADR 0067). It is the only code the relay supplies:
 * it pairs the phone (the pairing code is in the address's fragment, which a server never receives),
 * keeps the phone's secrets, registers the service worker and hands over to the app, which the daemon then
 * delivers through the encrypted tunnel.
 */
const relayId = relayIdOf(location.pathname);
const status = document.getElementById("status")!;
const detail = document.getElementById("detail")!;

function show(text: string, more = ""): void {
  status.textContent = text;
  detail.textContent = more;
}

async function ensureWorker(id: string): Promise<void> {
  if (!("serviceWorker" in navigator)) throw new Error("this browser has no service workers, which the relay needs");
  const reg = await navigator.serviceWorker.register(`/r/${id}/sw.js`, { scope: `/r/${id}/` });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // The worker took control after this page loaded: load again so the app comes through it.
    await new Promise<void>((done) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => done(), { once: true });
      setTimeout(done, 2000);
    });
  }
  void reg;
}

async function main(): Promise<void> {
  if (!relayId) return show("This address is not a Navarch relay page.");
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("pair");
  const paired = await credStore.load(relayId);

  if (code) {
    show("Pairing with your computer…", "Keep this page open.");
    // The fragment never reaches a server; take it out of the address bar and the history too.
    history.replaceState(history.state, "", location.pathname + location.search);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/p/${relayId}`);
    const name = guessName(navigator.userAgent);
    const { session, creds } = await pairWithCode(ws, code, name);
    await credStore.save(relayId, creds);
    // The app reads its session from this key, one per relay address.
    const device = session as { device: { id: string; name: string }; refresh_token: string; access_token: string; access_expires_at: string };
    localStorage.setItem(`navarch.device/r/${relayId}`, JSON.stringify({ device_id: device.device.id, name: device.device.name, refresh_token: device.refresh_token }));
  } else if (!paired) {
    return show("Not paired yet.", "On your computer, open Navarch → Settings → Devices → Pair a phone, and scan the code with this phone.");
  }

  show("Opening Navarch…");
  await ensureWorker(relayId);
  location.replace(`/r/${relayId}/home`);
}

function guessName(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

main().catch((err: unknown) => {
  if (err instanceof TunnelError) show(err.reason === "offline" ? "Your computer is offline." : "Could not pair.", err.message);
  else show("Something went wrong.", err instanceof Error ? err.message : String(err));
});
