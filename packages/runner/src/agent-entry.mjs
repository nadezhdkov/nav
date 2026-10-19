// Runs inside a hardened agent container (ADR 0069): `node agent-entry.mjs <egress socket> -- <command> [args]`.
// The container has no network interface, so this opens 127.0.0.1:3128 and pipes each connection to the unix
// socket of Navarch's egress proxy; the agent finds it through HTTPS_PROXY. Then it runs the agent with the
// container's stdio and exits with its status.
import { spawn } from "node:child_process";
import net from "node:net";

const [socket, sep, command, ...args] = process.argv.slice(2);
if (!socket || sep !== "--" || !command) {
  process.stderr.write("usage: agent-entry.mjs <socket> -- <command> [args]\n");
  process.exit(64);
}

const server = net.createServer((client) => {
  const upstream = net.connect(socket);
  client.pipe(upstream);
  upstream.pipe(client);
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end);
  upstream.on("error", end);
  client.on("close", end);
  upstream.on("close", end);
});

const port = Number(process.env.NAVARCH_PROXY_PORT || 3128);
server.listen(port, "127.0.0.1", () => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", (err) => {
    process.stderr.write(`agent-entry: cannot run ${command}: ${err.message}\n`);
    process.exit(127);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + (signal === "SIGTERM" ? 15 : signal === "SIGKILL" ? 9 : 2) : 1)));
});
server.on("error", (err) => {
  process.stderr.write(`agent-entry: cannot listen on 127.0.0.1:${port}: ${err.message}\n`);
  process.exit(70);
});
