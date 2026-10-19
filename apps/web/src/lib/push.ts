import type { Locale } from "@navarch/contracts";
import { BASE, viaRelay } from "../api/base.ts";
import { api } from "../api/client.ts";

/**
 * Web Push on this device (ADR 0020). `install` means iOS, where push works only once the app is
 * added to the home screen; `denied` means the browser's permission was refused.
 */
export type PushState = "unsupported" | "install" | "denied" | "off" | "on";

interface Env {
  navigator: Navigator;
  window: Window;
}

const env = (): Env => ({ navigator, window });

export function isIos(nav: Navigator): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

export function isStandalone(win: Window, nav: Navigator): boolean {
  return win.matchMedia?.("(display-mode: standalone)").matches === true || (nav as Navigator & { standalone?: boolean }).standalone === true;
}

/** Registers `sw.js` in a secure context (the tailnet's HTTPS name, or localhost). */
export async function registerServiceWorker(e: Env = env()): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in e.navigator) || !e.window.isSecureContext) return undefined;
  // Behind a relay the phone's loader registered its own worker, which also shows notifications (ADR 0067).
  if (viaRelay) return e.navigator.serviceWorker.getRegistration(`${BASE}/`);
  try {
    return await e.navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return undefined;
  }
}

export async function pushState(e: Env = env()): Promise<PushState> {
  const supported = "serviceWorker" in e.navigator && "PushManager" in e.window && "Notification" in e.window;
  if (!supported) return isIos(e.navigator) && !isStandalone(e.window, e.navigator) ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await e.navigator.serviceWorker.getRegistration(`${BASE}/`);
  return (await reg?.pushManager.getSubscription()) ? "on" : "off";
}

/** Asks for permission, subscribes with the daemon's VAPID key and registers the subscription. */
export async function enablePush(locale: Locale, e: Env = env()): Promise<PushState> {
  const state = await pushState(e);
  if (state === "unsupported" || state === "install" || state === "denied") return state;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = (await registerServiceWorker(e)) ?? (await e.navigator.serviceWorker.ready);
  const { public_key } = await api.pushKey();
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(public_key) }));
  await api.subscribePush(sub.toJSON(), locale);
  return "on";
}

export async function disablePush(e: Env = env()): Promise<PushState> {
  const reg = await e.navigator.serviceWorker?.getRegistration("/");
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
  await api.unsubscribePush();
  return "off";
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
