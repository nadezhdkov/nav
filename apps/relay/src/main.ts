#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startRelay } from "./server.ts";

/** `navarch-relay`: the relay as a program. Put a TLS proxy in front of it (it speaks plain HTTP and WebSocket). */
const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT ?? "8787" },
    host: { type: "string", default: process.env.HOST ?? "127.0.0.1" },
    state: { type: "string", default: process.env.RELAY_STATE ?? "./relay-state.json" },
    "max-relays": { type: "string", default: process.env.RELAY_MAX ?? "100" },
  },
});

const relay = await startRelay({
  port: Number(values.port),
  host: values.host,
  statePath: values.state,
  maxRelays: Number(values["max-relays"]),
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
console.log(`navarch-relay listening on ${relay.url} (state ${values.state})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void relay.stop().then(() => process.exit(0)));
}
