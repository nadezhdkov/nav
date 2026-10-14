import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "@vectr/contracts";
import { describe, expect, it } from "vitest";
import { Vault, VaultError } from "../src/vault/vault.ts";

/** A `secret-tool` stand-in that keeps secrets in a JSON file. */
function fakeSecretTool(): { command: string; store: string } {
  const dir = mkdtempSync(join(tmpdir(), "vectr-keyring-"));
  const store = join(dir, "store.json");
  const command = join(dir, "secret-tool");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const [op, ...rest] = process.argv.slice(2);
const attrs = rest.filter((a) => !a.startsWith("--"));
const key = attrs.join(" ");
const db = fs.existsSync(${JSON.stringify(store)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(store)}, "utf8")) : {};
if (op === "store") {
  db[key] = fs.readFileSync(0, "utf8");
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(db));
} else if (op === "lookup") {
  if (!(key in db)) process.exit(1);
  process.stdout.write(db[key]);
} else if (op === "clear") {
  delete db[key];
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(db));
} else process.exit(2);
`,
  );
  chmodSync(command, 0o755);
  return { command, store };
}

describe("Vault", () => {
  it("stores and reads secrets through the keychain command, by secret:// name", async () => {
    const { command, store } = fakeSecretTool();
    const vault = new Vault({ command, env: {} });
    expect(await vault.has("github/token")).toBe(false);
    await vault.set("github/token", "github_pat_stored_value_123");
    expect(readFileSync(store, "utf8")).toContain("service vectr name github/token");
    expect(await vault.get("secret://github/token")).toBe("github_pat_stored_value_123");
    expect(await vault.has("github/token")).toBe(true);
  });

  it("lets VECTR_SECRET_* override the keychain, and redacts every value it hands out", async () => {
    const { command, store } = fakeSecretTool();
    const vault = new Vault({ command, env: { VECTR_SECRET_GITHUB_TOKEN: "env-token-value-42" } });
    expect(await vault.get("github/token")).toBe("env-token-value-42");
    expect(existsSync(store)).toBe(false);
    expect(redact("auth env-token-value-42 done")).toBe("auth [REDACTED] done");
  });

  it("explains how to set a missing secret and refuses bad names", async () => {
    const { command } = fakeSecretTool();
    const vault = new Vault({ command, env: {} });
    const err = await vault.get("github/token").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as Error).message).toContain("vectr secret set github/token");
    for (const bad of ["../x", "a b", "", "GITHUB/token", "x/"]) {
      await expect(vault.get(bad), bad).rejects.toThrow("invalid secret name");
    }
    await expect(vault.set("github/token", "")).rejects.toThrow("empty");
  });
});
