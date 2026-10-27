// Run against the exact built package: node this-file.mjs /nix/store/...-paseo-0.12.0
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const home = mkdtempSync(join(tmpdir(), "independent-production-"));
process.env.HOME = home;
process.env.INDEPENDENT_TEST_LOG = join(home, "launches.jsonl");
const base = resolve(
  process.argv[2],
  "lib/paseo/packages/server/dist/server/server/agent/providers/pi",
);
const { PiRpcAgentClient, PiRpcAgentSession } = await import(pathToFileURL(join(base, "agent.js")));
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};
const client = new PiRpcAgentClient({
  logger,
  runtimeSettings: {
    command: {
      mode: "replace",
      argv: [
        process.execPath,
        fileURLToPath(new URL("./pi-independent-runtime-fixture.mjs", import.meta.url)),
      ],
    },
  },
});
const log = () =>
  existsSync(process.env.INDEPENDENT_TEST_LOG)
    ? readFileSync(process.env.INDEPENDENT_TEST_LOG, "utf8").trim().split("\n").map(JSON.parse)
    : [];
const sessions = [];
function fixture() {
  const id = createHash("sha256").update(randomUUID()).digest("hex"),
    agentId = randomUUID();
  const dir = join(home, ".pi/paseo-bridge/independent-conversations", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const history =
    JSON.stringify({ type: "session", id: randomUUID(), version: 3, cwd: home }) + "\n";
  writeFileSync(join(dir, "history.jsonl"), history, { mode: 0o600 });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      version: 1,
      id,
      cwd: home,
      sessionId: randomUUID(),
      title: "test",
      historySha256: createHash("sha256").update(history).digest("hex"),
    }),
    { mode: 0o600 },
  );
  const config = {
    provider: "pi",
    cwd: home,
    independentHistoryId: id,
    providerOptions: { independentHistoryId: id, rpcTimeoutMs: 3000 },
  };
  const context = { agentId, env: { INDEPENDENT_TEST_LOG: process.env.INDEPENDENT_TEST_LOG } };
  return {
    id,
    agentId,
    dir,
    config,
    context,
    live: join(dir, `session-${agentId}.jsonl`),
    marker: join(dir, `activation-${agentId}.json`),
  };
}
try {
  const f = fixture();
  const a = await client.createSession(f.config, f.context);
  sessions.push(a);
  assert.equal(log().length, 0);
  assert.equal(existsSync(f.live), false);
  // Exactly the metadata->config merge performed by AgentManager after dormant reopen.
  const dormant = a.describePersistence();
  await a.close();
  const b = await client.resumeSession(dormant, { ...dormant.metadata, ...f.config }, f.context);
  sessions.push(b);
  await b.startTurn("first independent progress");
  assert.equal(log().filter((x) => x.type === "spawn").length, 1);
  assert.equal(log().filter((x) => x.type === "prompt").length, 1);
  assert.equal(JSON.parse(readFileSync(f.marker)).handle.nativeHandle, f.live);
  const handle = b.describePersistence();
  await b.close();
  const c = await client.resumeSession(handle, { ...handle.metadata, ...f.config }, f.context);
  sessions.push(c);
  assert.ok(c instanceof PiRpcAgentSession);
  assert.match(readFileSync(f.live, "utf8"), /first independent progress/);
  await c.close();
  const stale = { ...handle, nativeHandle: join(home, "wrong.jsonl") };
  await assert.rejects(
    client.resumeSession(stale, f.config, f.context),
    /valid native runtime handle/,
  );
  const g = fixture();
  const x = await client.createSession(g.config, g.context),
    y = await client.createSession(g.config, g.context);
  sessions.push(x, y);
  const before = log().filter((e) => e.type === "spawn").length;
  const results = await Promise.allSettled([x.startTurn("winner"), y.startTurn("loser")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(log().filter((e) => e.type === "spawn").length, before + 1);
  const h = fixture();
  writeFileSync(
    h.marker,
    JSON.stringify({ agentId: h.agentId, snapshotId: h.id, sessionFile: h.live, active: false }),
    { mode: 0o600 },
  );
  const z = await client.createSession(h.config, h.context);
  sessions.push(z);
  await assert.rejects(z.startTurn("must not launch"), /Previous startup is unresolved/);
  assert.equal(existsSync(h.live), false);
  console.log(
    "PASS production provider + RPC subprocess: dormant reopen, single first prompt, native restart/progress, stale refusal, concurrent claim, unresolved crash refusal",
  );
} finally {
  await Promise.allSettled(sessions.map((s) => s.close()));
  rmSync(home, { recursive: true, force: true });
}
