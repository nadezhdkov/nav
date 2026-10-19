import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { ensureToken } from "../src/daemon.ts";

describe("the daemon's token file", () => {
  it("is created once, private to the user, and every later start reads the same token", () => {
    const home = tempHome();
    const first = ensureToken(home);
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
    expect(ensureToken(home)).toBe(first);
  });
});
