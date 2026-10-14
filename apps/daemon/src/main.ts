#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { navarchHome } from "./config.ts";
import { Daemon } from "./daemon.ts";

const home = navarchHome();
mkdirSync(home, { recursive: true, mode: 0o700 });
const daemon = new Daemon({ home });
await daemon.start();
console.log(`navarchd listening on ${daemon.url} (home ${home})`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`navarchd: ${signal}, stopping`);
    daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  });
}
