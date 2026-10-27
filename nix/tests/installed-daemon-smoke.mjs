import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const cli = process.argv[2];
assert(cli, "installed Paseo CLI is required");
const root = await mkdtemp(path.join(os.tmpdir(), "paseo-installed-smoke-"));
const home = path.join(root, "home");
await mkdir(home, { mode: 0o700 });
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
await writeFile(
  path.join(home, "config.json"),
  JSON.stringify({
    version: 1,
    daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } },
    features: {
      dictation: { enabled: false },
      voiceMode: { enabled: false },
      webUi: { enabled: false },
    },
  }),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
);
Object.assign(env, {
  HOME: home,
  PASEO_HOME: home,
  PASEO_LISTEN: `127.0.0.1:${port}`,
  PASEO_RELAY_ENABLED: "false",
  PASEO_NODE_ENV: "production",
  XDG_RUNTIME_DIR: root,
});
const child = spawn(cli, ["daemon", "run", "--home", home], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let exited = false;
let launchError;
const closed = new Promise((resolve) => {
  child.once("error", (error) => {
    launchError = error;
  });
  child.once("close", (code, signal) => {
    exited = true;
    resolve({ code, signal });
  });
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
async function listening() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(200, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
  });
}
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited)
      throw new Error(
        `Installed daemon exited before listening: ${launchError ?? JSON.stringify(await closed)}`,
      );
    if (await listening()) break;
    assert(Date.now() < deadline, "installed daemon never listened on its isolated endpoint");
    await delay(50);
  }
  assert(!exited, "installed daemon exited during readiness check");
  console.log("PASS installed Paseo daemon run: private home and isolated loopback endpoint");
} finally {
  if (!exited) child.kill("SIGTERM");
  let timer;
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    }),
  ]);
  clearTimeout(timer);
  if (!graceful) {
    child.kill("SIGKILL");
    await closed;
  }
  await rm(root, { recursive: true, force: true });
}
