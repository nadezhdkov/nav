import { execFile } from "node:child_process";
import { registerSecret } from "@navarch/contracts";

/**
 * Secrets Vault (spec §6.1.5, ADR 0007). Secrets are named, e.g. `secret://github/token`, and kept
 * in the OS keychain through libsecret's `secret-tool`. `NAVARCH_SECRET_<NAME>` in the daemon's
 * environment takes precedence (tests, headless setups). Secrets stored before the rename
 * (ADR 0008), under the keychain service `vectr` or in `VECTR_SECRET_<NAME>`, are still read.
 * Every value read is registered for
 * redaction, and values are handed only to the module that needs them.
 */

export class VaultError extends Error {}

export type VaultOptions = {
  /** The `secret-tool` binary. */
  command?: string;
  env?: NodeJS.ProcessEnv;
};

const NAME = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

export class Vault {
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: VaultOptions = {}) {
    this.command = options.command ?? "secret-tool";
    this.env = options.env ?? process.env;
  }

  async get(ref: string): Promise<string> {
    const name = parseName(ref);
    const value = this.fromEnv(name) || (await this.lookup(name));
    if (!value) {
      throw new VaultError(`secret ${name} is not set; store it with \`navarch secret set ${name}\` (reads stdin) or set ${envName(name)}`);
    }
    registerSecret(value);
    return value;
  }

  async has(ref: string): Promise<boolean> {
    const name = parseName(ref);
    return Boolean(this.fromEnv(name) || (await this.lookup(name)));
  }

  async set(ref: string, value: string): Promise<void> {
    const name = parseName(ref);
    if (!value) throw new VaultError("refusing to store an empty secret");
    registerSecret(value);
    await this.run(["store", `--label=Navarch ${name}`, "service", "navarch", "name", name], value);
  }

  private fromEnv(name: string): string | undefined {
    return this.env[envName(name)] || this.env[envName(name, "VECTR_SECRET_")];
  }

  private async lookup(name: string): Promise<string | undefined> {
    for (const service of ["navarch", "vectr"]) {
      try {
        const value = await this.run(["lookup", "service", service, "name", name]);
        if (value) return value;
      } catch (err) {
        if ((err as { code?: unknown }).code === "ENOENT") {
          throw new VaultError(`${this.command} not found: install libsecret tools, or set ${envName(name)}`);
        }
      }
    }
    return undefined;
  }

  private run(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.command, args, { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin?.on("error", () => {
        // secret-tool may exit before reading stdin; its exit status reports why.
      });
      child.stdin?.end(stdin ?? "");
    });
  }
}

function parseName(ref: string): string {
  const name = ref.startsWith("secret://") ? ref.slice("secret://".length) : ref;
  if (!NAME.test(name)) throw new VaultError(`invalid secret name ${JSON.stringify(ref)}`);
  return name;
}

function envName(name: string, prefix = "NAVARCH_SECRET_"): string {
  return `${prefix}${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}
