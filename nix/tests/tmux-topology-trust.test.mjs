// Fault/restart tests: fake process I/O, real registry schema and approval gate.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
const install = process.env.PASEO_INSTALL;
if (!install) throw new Error("Set PASEO_INSTALL to installed lib/paseo directory");
const server = path.join(install, "packages/server/dist/server/server");
const schema = pathToFileURL(path.join(server, "workspace-registry.js")).href;
const source = (
  await fs.readFile(new URL("./tmux-topology.ts", import.meta.url), "utf8")
).replaceAll('from "./workspace-registry.js";', `from "${schema}";`);
const { TmuxTopology, topologyId } = await import(
  process.env.PASEO_TOPOLOGY_COMPILED === "1"
    ? pathToFileURL(path.join(server, "tmux-topology.js")).href
    : `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "transform" })).toString("base64")}`
);
const {
  assertWorkspaceAutomationAllowedForWorkspace: allowed,
  clearWorkspaceAutomationBlock: approve,
} = await import(pathToFileURL(path.join(server, "workspace-automation-gate.js")).href);
const trust = { kind: "change_request", forge: "github", number: 42, headRepository: "fork/repo" };

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "paseo-trust-"));
  const state = {
    socket: path.join(home, "socket"),
    serverId: "1:start:inode",
    sessions: [],
    panes: [],
  };
  const journal = path.join(home, "tmux-pending-trust.json");
  const records = new Map(),
    writes = [],
    commands = [],
    instances = [];
  const fault = { snapshot: false, allocation: false, registry: false, rename: false };
  const workspaceRegistry = {
    get: async (id) => records.get(id) ?? null,
    upsert: async (record) => {
      if (fault.registry) throw new Error("registry fault");
      writes.push(structuredClone(record));
      records.set(record.workspaceId, record);
    },
    update: async (id, fn) => {
      const record = records.get(id);
      if (!record) return null;
      const next = fn(record);
      records.set(id, next);
      return next;
    },
    archive: async () => {},
  };
  const options = {
    paseoHome: home,
    launchDirectory: path.join(home, "launches"),
    workspaceRegistry,
    projectRegistry: { get: async () => null, upsert: async () => {}, archive: async () => {} },
    terminalManager: {
      createTerminal: async (input) => input,
      getTerminal: () => undefined,
      killTerminal() {},
    },
    logger: { warn() {} },
    sockets: async () => [state.socket],
    snapshot: async () => {
      if (fault.snapshot) throw new Error("snapshot fault");
      return structuredClone(state);
    },
    run: async (_socket, args) => {
      commands.push(args);
      if (["new-session", "new-window"].includes(args[0])) {
        const saved = JSON.parse(await fs.readFile(journal, "utf8"));
        assert.equal(saved.pending.length, 1, "intent exists before allocation");
        assert.deepEqual(saved.pending[0].source, trust);
        const name = args[args.indexOf("-n") + 1];
        assert.equal(name, saved.pending[0].token, "marker is atomic allocation argument");
        const n = state.panes.length + 1;
        const sessionId = args[0] === "new-session" ? `$${n}` : "$1";
        if (args[0] === "new-session")
          state.sessions.push({
            id: sessionId,
            name: "project",
            cwd: "/same",
            infrastructure: false,
          });
        state.panes.push({
          sessionId,
          windowId: `@${n}`,
          id: `%${n}`,
          windowName: name,
          cwd: "/same",
          command: "bash",
          infrastructure: false,
          agent: false,
        });
        if (fault.allocation) throw new Error("allocation reply lost");
        if (fault.snapshotAfterAllocation) fault.snapshot = true;
        return args[0] === "new-session" ? `${sessionId}\x1f@${n}` : `@${n}`;
      }
      if (args[0] === "rename-window") {
        if (fault.rename) throw new Error("rename fault");
        state.panes.find((pane) => pane.windowId === args[2]).windowName = args[3];
      }
      return "";
    },
  };
  function fresh() {
    const topology = new TmuxTopology(options);
    instances.push(topology);
    return topology;
  }
  const topology = fresh();
  await topology.start();
  topology.stop();
  t.after(async () => {
    instances.forEach((instance) => instance.stop());
    await fs.rm(home, { recursive: true, force: true });
  });
  const id = (n) => topologyId("wks", state.socket, state.serverId, `@${n}`);
  return {
    topology,
    fresh,
    options,
    state,
    home,
    journal,
    records,
    writes,
    commands,
    fault,
    workspaceRegistry,
    id,
  };
}

for (const creation of ["session", "window"])
  for (const failure of ["snapshotAfterAllocation", "allocation", "registry"]) {
    test(`${creation}: ${failure} preserves first-publication approval gate across restart`, async (t) => {
      const f = await fixture(t);
      let project;
      if (creation === "window") {
        f.state.sessions.push({ id: "$1", name: "existing", cwd: "/same", infrastructure: false });
        await f.topology.applySnapshot(structuredClone(f.state));
        project = topologyId("prj", f.state.socket, f.state.serverId, "$1");
      }
      f.fault[failure] = true;
      await assert.rejects(f.topology.createWorkspace(project, "/same", "requested", trust));
      assert.equal(f.records.size, 0);
      assert.equal(f.state.panes.length, 1, "allocated window survives failure");
      f.fault.snapshot = f.fault.allocation = f.fault.registry = false;
      // An unrelated same-cwd window must not acquire the failed creation's trust.
      f.state.panes.push({
        ...f.state.panes[0],
        windowId: "@99",
        id: "%99",
        windowName: "unrelated",
      });
      const restarted = f.fresh();
      await restarted.start();
      restarted.stop();
      assert.deepEqual(
        f.writes.find((record) => record.workspaceId === f.id(1)).untrustedSource,
        trust,
      );
      await assert.rejects(allowed(f.workspaceRegistry, f.id(1)), /Scripts are blocked/);
      assert.equal(f.records.get(f.id(99)).untrustedSource, undefined);
      assert.equal(f.state.panes[0].windowName, "requested");
      assert.equal(JSON.parse(await fs.readFile(f.journal, "utf8")).pending[0].published, true);
      assert.equal(await approve(f.workspaceRegistry, f.id(1)), true);
      await restarted.applySnapshot(structuredClone(f.state));
      await allowed(f.workspaceRegistry, f.id(1));
    });
  }

test("bound intent survives rename, cwd, and linked-session changes after registry failure", async (t) => {
  const f = await fixture(t);
  f.fault.registry = true;
  await assert.rejects(
    f.topology.createWorkspace(undefined, "/same", "requested", trust),
    /registry fault/,
  );
  const pending = JSON.parse(await fs.readFile(f.journal, "utf8")).pending;
  assert.equal(pending[0].workspaceId, f.id(1));
  f.state.sessions.push({ ...f.state.sessions[0], id: "$0" });
  Object.assign(f.state.panes[0], {
    windowName: "user rename",
    cwd: "/different",
    sessionId: "$0",
  });
  f.fault.registry = false;
  const restarted = f.fresh();
  await restarted.start();
  restarted.stop();
  assert.deepEqual(f.records.get(f.id(1)).untrustedSource, trust);
  await assert.rejects(allowed(f.workspaceRegistry, f.id(1)), /Scripts are blocked/);
});

test("approval remains authoritative when post-publication cleanup fails before restart", async (t) => {
  const f = await fixture(t);
  f.fault.rename = true;
  await assert.rejects(
    f.topology.createWorkspace(undefined, "/same", "requested", trust),
    /rename fault/,
  );
  await assert.rejects(allowed(f.workspaceRegistry, f.id(1)), /Scripts are blocked/);
  assert.equal(await approve(f.workspaceRegistry, f.id(1)), true);
  assert.equal(JSON.parse(await fs.readFile(f.journal, "utf8")).pending.length, 1);
  f.fault.rename = false;
  const restarted = f.fresh();
  await restarted.start();
  restarted.stop();
  await allowed(f.workspaceRegistry, f.id(1));
  assert.equal(f.records.get(f.id(1)).untrustedSource, undefined);
  assert.equal(JSON.parse(await fs.readFile(f.journal, "utf8")).pending[0].published, true);
});

for (const damage of ["malformed", "invalid", "inaccessible", "missing", "lost-marker"]) {
  test(`${damage} pending state never publishes an implicitly trusted failed creation`, async (t) => {
    const f = await fixture(t);
    f.fault.allocation = true;
    await assert.rejects(f.topology.createWorkspace(undefined, "/same", "requested", trust));
    if (damage === "malformed") await fs.writeFile(f.journal, "{");
    if (damage === "invalid")
      await fs.writeFile(f.journal, JSON.stringify({ version: 1, pending: [{}] }));
    if (damage === "inaccessible") {
      await fs.rm(f.journal);
      await fs.mkdir(f.journal);
    } // deterministic EISDIR, including root builds
    if (damage === "missing") await fs.rm(f.journal);
    if (damage === "lost-marker") f.state.panes[0].windowName = "renamed before recovery";
    const restarted = f.fresh();
    await assert.rejects(restarted.applySnapshot(structuredClone(f.state)));
    await restarted.start().catch(() => {});
    restarted.stop();
    assert.equal(f.records.size, 0);
    await assert.rejects(allowed(f.workspaceRegistry, f.id(1)), /Workspace not found/);
  });
}

test("ambiguous duplicate bound workspace evidence fails closed", async (t) => {
  const f = await fixture(t);
  f.fault.registry = true;
  await assert.rejects(f.topology.createWorkspace(undefined, "/same", "requested", trust));
  const saved = JSON.parse(await fs.readFile(f.journal, "utf8"));
  saved.pending.push({
    ...saved.pending[0],
    token: "paseo-trust-00000000-0000-4000-8000-000000000000",
    source: { ...trust, number: 99 },
  });
  await fs.writeFile(f.journal, JSON.stringify(saved));
  const restarted = f.fresh();
  await assert.rejects(
    restarted.applySnapshot(structuredClone(f.state)),
    /Invalid pending tmux trust/,
  );
  assert.equal(f.records.size, 0);
});

test("journal read failure prevents allocation and leaves no temporary files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.journal); // read cannot succeed, so no allocation is allowed
  await assert.rejects(f.topology.createWorkspace(undefined, "/same", "requested", trust));
  assert.equal(f.commands.length, 0);
  assert.equal((await fs.readdir(f.home)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("bound absent window retires intent, but hidden window does not", async (t) => {
  const f = await fixture(t);
  f.fault.registry = true;
  await assert.rejects(f.topology.createWorkspace(undefined, "/same", "requested", trust));
  f.state.panes[0].infrastructure = true;
  f.fault.registry = false;
  await f.topology.applySnapshot(structuredClone(f.state));
  assert.equal(JSON.parse(await fs.readFile(f.journal, "utf8")).pending.length, 1);
  f.state.panes = [];
  await f.topology.applySnapshot(structuredClone(f.state));
  assert.deepEqual(JSON.parse(await fs.readFile(f.journal, "utf8")).pending, []);
});

for (const stage of ["before-allocation", "binding", "published"]) {
  test(`${stage} journal write fault recovers safely on restart`, async (t) => {
    const f = await fixture(t);
    const rename = fs.rename;
    fs.rename = async (temporaryPath, destination) => {
      if (destination === f.journal) {
        const entry = JSON.parse(await fs.readFile(temporaryPath, "utf8")).pending[0];
        if (
          (stage === "before-allocation" && !entry.workspaceId) ||
          (stage === "binding" && entry.workspaceId && !entry.published) ||
          (stage === "published" && entry.published)
        )
          throw new Error("journal write fault");
      }
      return rename(temporaryPath, destination);
    };
    try {
      await assert.rejects(
        f.topology.createWorkspace(undefined, "/same", "requested", trust),
        /journal write fault/,
      );
    } finally {
      fs.rename = rename;
    }
    assert.equal((await fs.readdir(f.home)).filter((name) => name.endsWith(".tmp")).length, 0);
    if (stage === "before-allocation") {
      assert.equal(f.commands.length, 0);
      assert.equal(f.records.size, 0);
      return;
    }
    if (stage === "published") {
      await assert.rejects(allowed(f.workspaceRegistry, f.id(1)), /Scripts are blocked/);
      await approve(f.workspaceRegistry, f.id(1));
    } else assert.equal(f.records.size, 0);
    const restarted = f.fresh();
    await restarted.start();
    restarted.stop();
    if (stage === "published") await allowed(f.workspaceRegistry, f.id(1));
    else await assert.rejects(allowed(f.workspaceRegistry, f.id(1)), /Scripts are blocked/);
  });
}

test("lost registry after successful publication restores trust, even after previous approval", async (t) => {
  const f = await fixture(t);
  await f.topology.createWorkspace(undefined, "/same", "requested", trust);
  await approve(f.workspaceRegistry, f.id(1));
  // Upstream registry load may swallow corruption/read failure into an empty map.
  f.records.clear();
  f.state.panes[0].windowName = "renamed by user";
  const restarted = f.fresh();
  await restarted.start();
  restarted.stop();
  await assert.rejects(allowed(f.workspaceRegistry, f.id(1)), /Scripts are blocked/);
  assert.equal(f.state.panes[0].windowName, "renamed by user");
  assert.deepEqual(f.records.get(f.id(1)).untrustedSource, trust);
});
