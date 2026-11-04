import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const cli = process.argv[2];
assert(cli, "installed Paseo CLI is required");
const installRoot = process.env.PASEO_INSTALL;
if (installRoot) {
  assert(
    existsSync(
      path.join(installRoot, "packages/server/dist/server/terminal-worker/terminal-worker.mjs"),
    ),
    "installed terminal worker bundle is present in the Nix closure",
  );
  assert(
    existsSync(
      path.join(installRoot, "packages/server/dist/server/terminal-worker/shell-integration"),
    ),
    "installed terminal worker shell integration is present in the Nix closure",
  );
}
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

function startDaemon() {
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
  return {
    child,
    closed,
    get exited() {
      return exited;
    },
    get launchError() {
      return launchError;
    },
  };
}

async function runCli(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const command = spawn(cli, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      command.kill("SIGKILL");
    }, timeoutMs);
    command.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    command.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    command.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    command.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`paseo ${args.join(" ")} timed out after ${timeoutMs}ms`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`paseo ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
    });
  });
}

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

async function waitForDaemon(daemon) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (daemon.exited)
      throw new Error(
        `Installed daemon exited before listening: ${daemon.launchError ?? JSON.stringify(await daemon.closed)}`,
      );
    if (await listening()) return;
    assert(Date.now() < deadline, "installed daemon never listened on its isolated endpoint");
    await delay(50);
  }
}

let daemon;
let terminalId;
try {
  daemon = startDaemon();
  await waitForDaemon(daemon);
  const created = await runCli(["terminal", "create", "--home", home, "--cwd", root, "--json"]);
  terminalId = JSON.parse(created.stdout).id;
  assert.equal(typeof terminalId, "string", "installed terminal create returns its ID");

  const marker = (phase) => `PASEO_INSTALLED_TERMINAL_${process.pid}_${phase}`;
  const sendMarker = (phase) =>
    runCli([
      "terminal",
      "send-keys",
      "--home",
      home,
      "--literal",
      terminalId,
      `printf '\\nPASEO_INSTALLED_TERMINAL_%s_%s\\n' '${process.pid}' '${phase}'\n`,
    ]);
  const captured = async (expected) => {
    const output = await runCli(["terminal", "capture", "--home", home, "--json", terminalId]);
    return JSON.stringify(JSON.parse(output.stdout)).includes(expected);
  };
  const waitForMarker = async (expected, phase) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sendMarker(phase);
      await delay(150);
      if (await captured(expected)) return true;
    }
    return false;
  };
  const firstMarker = marker("FIRST");
  assert(
    await waitForMarker(firstMarker, "FIRST"),
    "installed terminal executes commands and captures output",
  );

  await runCli(["daemon", "stop", "--home", home, "--keep-terminals", "--json"]);
  const firstExit = await Promise.race([
    daemon.closed,
    delay(10_000).then(() => {
      throw new Error("installed daemon did not stop gracefully");
    }),
  ]);
  assert.equal(firstExit.code, 0, `installed daemon stop result: ${JSON.stringify(firstExit)}`);
  daemon = startDaemon();
  await waitForDaemon(daemon);
  assert(await captured(firstMarker), "installed terminal output survives daemon restart");
  const restartMarker = marker("AFTER_RESTART");
  assert(
    await waitForMarker(restartMarker, "AFTER_RESTART"),
    "the surviving terminal shell executes new commands after daemon restart",
  );
  await runCli(["terminal", "kill", "--home", home, terminalId, "--json"]);
  console.log(
    "PASS installed Paseo daemon and terminal lifecycle: create, execute, restart, capture",
  );
} finally {
  if (terminalId && !daemon?.exited) {
    await runCli(["terminal", "kill", "--home", home, terminalId, "--json"]).catch(() => {});
  }
  if (daemon && !daemon.exited) {
    await runCli(["daemon", "stop", "--home", home, "--json"]).catch(() => {});
    const graceful = await Promise.race([
      daemon.closed.then(() => true),
      delay(5000).then(() => false),
    ]);
    if (!graceful) {
      daemon.child.kill("SIGKILL");
      await daemon.closed;
    }
  }
  await rm(root, { recursive: true, force: true });
}
