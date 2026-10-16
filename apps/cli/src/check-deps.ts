import { fileURLToPath } from "node:url";
import { checkoutRoot, installProblem } from "./deps.ts";

// `make daemon` runs this first: a pull that changed dependencies without `make install` makes the daemon die
// on an import (F3). It only warns, like `navarch daemon start`.
const root = checkoutRoot(fileURLToPath(import.meta.url));
const stale = root && installProblem(root);
if (stale) console.error(`warning: ${stale}`);
