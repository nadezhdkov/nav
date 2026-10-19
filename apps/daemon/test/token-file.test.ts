import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "../../../packages/runner/test/helpers.ts";
import { ensureToken } from "../src/daemon.ts";
import { loadKey } from "../src/devices/devices.ts";

describe("the daemon's token file", () => {
  it("is created once, private to the user, and every later start reads the same token", () => {
    const home = tempHome();
    const first = ensureToken(home);
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
    expect(ensureToken(home)).toBe(first);
  });
});

describe("the daemon's key files", () => {
  it("replace a device key that is too short to be one, and keep a good one", () => {
    const home = tempHome();
    const file = join(home, "device-key");
    writeFileSync(file, "short\n");
    const key = loadKey(file);
    expect(key.length).toBe(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadKey(file).equals(key)).toBe(true);
  });
});
