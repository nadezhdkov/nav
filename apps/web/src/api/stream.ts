import type { NavarchEvent, StreamServerMessage } from "@navarch/contracts";
import { ref } from "vue";
import { authorized } from "./client.ts";
import { bearer, forgetDevice } from "./session.ts";

/**
 * `/api/v1/stream` (spec §6.13): one socket for the app, topics added and dropped as views need
 * them, reconnecting with backoff. Views refetch on reconnect, so missed events are not lost.
 */

type EventListener = (event: NavarchEvent) => void;
type LogListener = (runId: string, taskId: string, line: string) => void;

export const connected = ref(false);

const topics = new Map<string, number>();
const eventListeners = new Set<EventListener>();
const logListeners = new Set<LogListener>();
const reconnectListeners = new Set<() => void>();
let socket: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export function subscribe(topic: string): () => void {
  topics.set(topic, (topics.get(topic) ?? 0) + 1);
  if (topics.get(topic) === 1) send({ subscribe: [topic] });
  ensure();
  return () => {
    const n = (topics.get(topic) ?? 1) - 1;
    if (n > 0) return void topics.set(topic, n);
    topics.delete(topic);
    send({ unsubscribe: [topic] });
  };
}

export function onEvent(fn: EventListener): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

export function onLog(fn: LogListener): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

/** Called after the socket comes back, so views can refetch what they missed. */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

function send(msg: { subscribe?: string[]; unsubscribe?: string[] }): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

let opening = false;

function ensure(): void {
  if (socket || timer || opening) return;
  opening = true;
  void bearer()
    .then((token) => {
      if (token) open(token);
    })
    .finally(() => {
      opening = false;
    });
}

function open(token: string): void {
  if (socket) return;
  const url = new URL("/api/v1/stream", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    const reconnect = retry > 0;
    retry = 0;
    connected.value = true;
    if (topics.size) send({ subscribe: [...topics.keys()] });
    if (reconnect) for (const fn of reconnectListeners) fn();
  };
  ws.onmessage = (e) => {
    let msg: StreamServerMessage;
    try {
      msg = JSON.parse(String(e.data)) as StreamServerMessage;
    } catch {
      return;
    }
    if (msg.kind === "event") for (const fn of eventListeners) fn(msg.event as unknown as NavarchEvent);
    else if (msg.kind === "log") for (const fn of logListeners) fn(msg.run_id, msg.task_id, msg.line);
  };
  ws.onclose = (e) => {
    socket = null;
    connected.value = false;
    // 4401: this device was revoked (ADR 0020); there is nothing to reconnect to.
    if (e.code === 4401) {
      forgetDevice();
      authorized.value = false;
      return;
    }
    if (!topics.size) return;
    retry++;
    timer = setTimeout(() => {
      timer = undefined;
      ensure();
    }, Math.min(30_000, 500 * 2 ** retry));
  };
}
