// Integration tests for the actual compiled server creation/import handlers.
// All process-facing dependencies are fake; no live tmux is read or changed.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const install = process.env.PASEO_INSTALL;
if (!install) throw new Error("PASEO_INSTALL must point at the newly built lib/paseo");
const server = path.join(install, "packages/server/dist/server");
const load = (relative) => import(pathToFileURL(path.join(server, relative)).href);
const { startTmuxTopology } = await load("server/tmux-topology.js");
const { AgentManager } = await load("server/agent/agent-manager.js");
const { createWorkspaceProvisioningService } = await load(
  "server/session/workspace-provisioning/workspace-provisioning-service.js",
);
const { TerminalSessionController } = await load("terminal/terminal-session-controller.js");
const { archiveAgentCommand, closeAgentCommand } = await load("server/agent/lifecycle-command.js");
const { archiveByScope } = await load("server/workspace-archive-service.js");
const { Session } = await load("server/session.js");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "paseo-hooks-test-"));
  const socket = path.join(home, "socket");
  const state = {
    socket,
    serverId: "1:start:inode",
    sessions: [{ id: "$1", name: "user", cwd: "/same", infrastructure: false }],
    panes: [
      {
        sessionId: "$1",
        windowId: "@1",
        windowName: "window",
        id: "%1",
        cwd: "/same",
        command: "bash",
        infrastructure: false,
        agent: false,
      },
    ],
  };
  const registry = () => {
    const records = new Map();
    return {
      get: async (id) => records.get(id) ?? null,
      list: async () => [...records.values()],
      update: async (id, fn) => {
        const record = fn(records.get(id) ?? null);
        records.set(id, record);
        return record;
      },
      upsert: async (record) => records.set(record.workspaceId ?? record.projectId, record),
      archive: async (id, archivedAt) => {
        const record = records.get(id);
        if (record) records.set(id, { ...record, archivedAt });
      },
      remove: async (id) => records.delete(id),
    };
  };
  const projectRegistry = registry(),
    workspaceRegistry = registry(),
    terminals = new Map(),
    commands = [];
  const terminalManager = {
    createTerminal: async (input) => {
      const terminal = { ...input, getTitle: () => "", getActivity: () => ({ state: "idle" }) };
      terminals.set(input.id, terminal);
      return terminal;
    },
    getTerminal: (id) => terminals.get(id),
    killTerminal: (id) => terminals.delete(id),
  };
  const before = process.env.PASEO_TMUX_TOPOLOGY;
  process.env.PASEO_TMUX_TOPOLOGY = "1";
  const topology = await startTmuxTopology({
    paseoHome: home,
    launchDirectory: path.join(home, "launches"),
    projectRegistry,
    workspaceRegistry,
    terminalManager,
    logger: { warn() {} },
    sockets: async () => [socket],
    snapshot: async () => structuredClone(state),
    run: async (_socket, args) => {
      commands.push(args);
      if (args[0] === "new-session") {
        state.sessions.push({ ...state.sessions[0], id: "$2" });
        state.panes.push({
          ...state.panes[0],
          sessionId: "$2",
          windowId: "@2",
          id: "%2",
          windowName: args.includes("-n") ? args[args.indexOf("-n") + 1] : "created",
        });
        return "$2\x1f@2";
      }
      if (args[0] === "rename-window") {
        state.panes.find((pane) => pane.windowId === args[2]).windowName = args[3];
        return "";
      }
      if (args[0] === "split-window") {
        state.panes.push({ ...state.panes[0], id: "%3" });
        return "%3";
      }
      if (args[0] === "kill-pane") state.panes = state.panes.filter((p) => p.id !== args[2]);
      if (args[0] === "kill-window")
        state.panes = state.panes.filter((p) => p.windowId !== args[2]);
      if (args[0] === "kill-session")
        state.panes = state.panes.filter((p) => p.sessionId !== args[2]);
      if (args[0].startsWith("kill-"))
        state.sessions = state.sessions.filter((s) =>
          state.panes.some((p) => p.sessionId === s.id),
        );
      return "";
    },
  });
  t.after(async () => {
    topology.stop();
    if (before === undefined) delete process.env.PASEO_TMUX_TOPOLOGY;
    else process.env.PASEO_TMUX_TOPOLOGY = before;
    await fs.rm(home, { recursive: true, force: true });
  });
  return { topology, projectRegistry, workspaceRegistry, terminalManager, commands, state, home };
}
function fakeProviderManager() {
  // Keep createAgentInternal itself real; stub only provider and persistence I/O.
  const manager = Object.create(AgentManager.prototype);
  manager.assertAcceptingAgentRegistrations = () => {};
  manager.idFactory = () => "12345678-1234-4234-8234-123456789abc";
  manager.deleteAgentState = async () => {};
  manager.prepareSessionConfig = async (config) => ({ storedConfig: config, launchConfig: config });
  manager.requireEnabledProvider = () => {};
  manager.requireAvailableClient = async () => ({
    createSession: async (_config, launch) => ({ env: launch.env }),
  });
  manager.paseoToolPolicies = new Map();
  manager.buildLaunchContext = async (_id, _client, _cwd, _policy, env) => ({ env });
  manager.resolveProviderLaunchConfig = (config) => config;
  manager.buildCreateSessionOptions = () => undefined;
  manager.requireExternalMcpSupport = async () => {};
  manager.registerSession = (session, _config, id, options) => ({
    id,
    env: session.env,
    workspaceId: options.workspaceId,
  });
  return manager;
}

test("actual Pi provider creation provisions root first and passes verified JSON to spawn", async (t) => {
  const f = await fixture(t);
  const result = await fakeProviderManager().createAgentInternal(
    { provider: "pi", cwd: "/same" },
    undefined,
    {},
  );
  assert.equal(f.commands[0][0], "new-session");
  const target = JSON.parse(result.env.PI_PASEO_TMUX_TARGET);
  assert.equal(target.workspaceId, result.workspaceId);
  assert.equal(target.tmuxWindowId, "@2");
  assert.equal(target.tmuxSessionId, "$2");
  assert.equal(result.env.PASEO_AGENT_ID, result.id);
  assert.deepEqual(
    Object.keys(target).sort(),
    [
      "version",
      "tmuxSocket",
      "tmuxServerId",
      "tmuxSessionId",
      "tmuxWindowId",
      "projectId",
      "workspaceId",
    ].sort(),
  );
});

test("submitted Pi tab/fork uses explicit workspace, without allocating another session/window", async (t) => {
  const f = await fixture(t);
  const p = [...f.topology.placements.values()][0];
  const result = await fakeProviderManager().createAgentInternal(
    { provider: "pi", cwd: "/different-pane-cwd" },
    undefined,
    { workspaceId: p.workspaceId },
  );
  assert.equal(JSON.parse(result.env.PI_PASEO_TMUX_TARGET).tmuxWindowId, "@1");
  assert.deepEqual(f.commands, []);
});

test("actual import provisioning accepts explicit window despite different cwd, rejects cwd-only import", async (t) => {
  const f = await fixture(t);
  const p = [...f.topology.placements.values()][0];
  const provisioning = createWorkspaceProvisioningService({
    serverId: "paseo",
    projectRegistry: f.projectRegistry,
    workspaceRegistry: f.workspaceRegistry,
    workspaceGitService: {},
    logger: { error() {} },
  });
  const result = await provisioning.runInImportWorkspace(
    { cwd: "/different-pane-cwd", requestedWorkspaceId: p.workspaceId },
    async (workspace) => workspace.workspaceId,
  );
  assert.equal(result.value, p.workspaceId);
  assert.equal(result.createdWorkspace, null);
  await assert.rejects(
    provisioning.runInImportWorkspace({ cwd: "/same" }, async () => {}),
    /explicit projected/,
  );
  assert.deepEqual(f.commands, []);
});

test("fork-PR workspaces preserve script approval metadata from the first publication through reconciliation", async (t) => {
  const f = await fixture(t),
    writes = [],
    upsert = f.workspaceRegistry.upsert;
  f.workspaceRegistry.upsert = async (record) => {
    writes.push(record);
    return upsert(record);
  };
  const provisioning = createWorkspaceProvisioningService({
    serverId: "paseo",
    projectRegistry: f.projectRegistry,
    workspaceRegistry: f.workspaceRegistry,
    workspaceGitService: {},
    logger: { error() {} },
  });
  const untrustedSource = {
    kind: "change_request",
    forge: "github",
    number: 42,
    headRepository: "fork/repo",
  };
  const workspace = await provisioning.createWorkspaceForWorktree({
    sourceCwd: "/same",
    repoRoot: "/same",
    cwd: "/fork",
    worktreeRoot: "/fork",
    branch: "pr",
    untrustedSource,
  });
  assert.deepEqual(workspace.untrustedSource, untrustedSource);
  assert.ok(writes.length > 0);
  assert.deepEqual(writes[0].untrustedSource, untrustedSource);
  f.state.panes.find((pane) => pane.windowId === "@2").windowName = "renamed";
  await f.topology.applySnapshot(structuredClone(f.state));
  assert.deepEqual(
    (await f.workspaceRegistry.get(workspace.workspaceId)).untrustedSource,
    untrustedSource,
  );
});

test("missing-pane archival closes only the exact Pi owner, without child cascade or native revival", async () => {
  const workspaceId = "wks_tmux_owned";
  const records = new Map([
    [
      "reaped",
      { id: "reaped", provider: "pi", workspaceId, archivedAt: null, lastStatus: "running" },
    ],
    [
      "child",
      {
        id: "child",
        provider: "pi",
        workspaceId,
        archivedAt: null,
        labels: { "parent-agent-id": "reaped" },
      },
    ],
    ["foreign", { id: "foreign", provider: "claude", workspaceId, archivedAt: null }],
    ["moved", { id: "moved", provider: "pi", workspaceId: "wks_tmux_elsewhere", archivedAt: null }],
    ["ordinary", { id: "ordinary", provider: "pi", workspaceId: "wks_other", archivedAt: null }],
  ]);
  const manager = Object.create(AgentManager.prototype);
  const closed = [],
    writes = [],
    archivedEvents = [];
  manager.lifecycleMutationTails = new Map();
  manager.registry = {
    get: async (id) => records.get(id),
    upsert: async (record) => {
      records.set(record.id, record);
      writes.push(record.id);
    },
  };
  manager.agents = new Map([
    ["reaped", { id: "reaped" }],
    ["child", { id: "child" }],
  ]);
  manager.closeAgent = () => assert.fail("must not re-enter the lifecycle mutation lane");
  manager.closeAgentRuntime = async (id) => {
    closed.push(id);
    manager.agents.delete(id);
  };
  manager.discardRetainedAgentState = () => {};
  manager.dispatchStoredAgentState = (record) => archivedEvents.push(record.id);
  manager.cascadeArchiveChildren = () => assert.fail("must not archive children");
  manager.syncNativeArchiveState = () =>
    assert.fail("must not call native provider/revive a reaped session");
  assert.equal(await manager.archiveMissingTmuxAgent("reaped", workspaceId), true);
  assert.equal(await manager.archiveMissingTmuxAgent("reaped", workspaceId), true);
  assert.equal(await manager.archiveMissingTmuxAgent("foreign", workspaceId), false);
  assert.equal(await manager.archiveMissingTmuxAgent("moved", workspaceId), false);
  assert.equal(await manager.archiveMissingTmuxAgent("ordinary", "wks_other"), false);
  assert.equal(await manager.archiveMissingTmuxAgent("unknown", workspaceId), false);
  assert.deepEqual(closed, ["reaped"]);
  assert.deepEqual(writes, ["reaped"]);
  assert.ok(records.get("reaped").archivedAt);
  assert.equal(records.get("reaped").lastStatus, "idle");
  assert.deepEqual(archivedEvents, ["reaped", "reaped"]);
  for (const id of ["child", "foreign", "moved", "ordinary"])
    assert.equal(records.get(id).archivedAt, null);
  assert.ok(manager.agents.has("child"));
});

test("actual terminal handlers route creation and report successful pane close after proxy already exited", async (t) => {
  const f = await fixture(t);
  const p = [...f.topology.placements.values()][0];
  const responses = [];
  const controller = Object.create(TerminalSessionController.prototype);
  controller.terminalManager = f.terminalManager;
  // v0.8 validates workspace membership before asking the terminal manager to split.
  controller.listTerminalWorkspaceRefs = () => f.workspaceRegistry.list();
  controller.ensureExitSubscription = () => {};
  controller.emit = (message) => responses.push(message);
  controller.sessionLogger = { error() {}, warn() {} };
  await controller.handleCreateTerminalRequest({
    type: "create_terminal_request",
    cwd: "/same",
    workspaceId: p.workspaceId,
    requestId: "create",
  });
  assert.equal(responses[0].payload.error, null);
  assert.equal(f.commands[0][0], "split-window");
  const terminal = responses[0].payload.terminal;
  assert.equal(terminal.workspaceId, p.workspaceId);
  controller.detachStream = () => {};
  controller.terminalManager.killTerminalAndWait = async () => {
    throw new Error("proxy already exited");
  };
  await controller.handleKillTerminalRequest({
    type: "kill_terminal_request",
    terminalId: terminal.id,
    requestId: "close",
  });
  assert.equal(f.commands.at(-1)[0], "kill-pane");
  assert.equal(responses.at(-1).payload.success, true);
});

test("terminal close fails closed on stale topology and leaves proxies untouched", async (t) => {
  const f = await fixture(t),
    responses = [];
  // stop() retains the active topology; restore this injected failure after the test.
  t.mock.method(f.topology, "closeTerminal", async () => {
    throw new Error("stale server incarnation");
  });
  const controller = Object.create(TerminalSessionController.prototype);
  controller.terminalManager = {
    killTerminalAndWait: () => assert.fail("must not close proxy after topology validation failed"),
  };
  controller.detachStream = () => assert.fail("must not detach on stale topology");
  controller.sessionLogger = { warn() {} };
  controller.emit = (message) => responses.push(message);
  await controller.handleKillTerminalRequest({
    type: "kill_terminal_request",
    terminalId: "trm_stale",
    requestId: "stale",
  });
  assert.equal(responses[0].payload.success, false);
});

test("ordinary terminal close still awaits the upstream worker exit", async () => {
  const controller = Object.create(TerminalSessionController.prototype),
    order = [];
  controller.terminalManager = {
    killTerminalAndWait: async (id) => {
      await Promise.resolve();
      order.push(id);
    },
  };
  controller.detachStream = () => order.push("detach");
  controller.emit = (message) => {
    assert.equal(message.payload.success, true);
    order.push("response");
  };
  await controller.handleKillTerminalRequest({
    type: "kill_terminal_request",
    terminalId: "ordinary",
    requestId: "close",
  });
  assert.deepEqual(order, ["detach", "ordinary", "response"]);
});

test("Pi tab archive closes exactly its pane, including managed children, without cascading to sibling panes", async (t) => {
  const f = await fixture(t),
    p = [...f.topology.placements.values()][0];
  Object.assign(f.state.panes[0], { agent: true, agentId: "parent" });
  f.state.panes.push({ ...f.state.panes[0], id: "%2", agentId: "child" });
  const records = new Map(
    ["parent", "child"].map((id) => [
      id,
      { id, provider: "pi", workspaceId: p.workspaceId, archivedAt: null },
    ]),
  );
  f.topology.options.archiveAgent = async (id) => {
    records.get(id).archivedAt = "2026-09-30T00:00:00Z";
  };
  const cancelled = [];
  const manager = {
    getAgent: (id) => records.get(id),
    hasInFlightRun: () => true,
    cancelAgentRun: async (id) => {
      assert.deepEqual(f.commands, []);
      cancelled.push(id);
      return { status: "settled" };
    },
    archiveAgent: () => assert.fail("must not cascade archive"),
    closeAgent: () => assert.fail("must not fall back after tmux close"),
  };
  const result = await archiveAgentCommand(
    {
      agentManager: manager,
      logger: { trace() {}, debug() {} },
      agentStorage: { get: async (id) => records.get(id) },
    },
    "parent",
  );
  assert.deepEqual(cancelled, ["parent"]);
  assert.ok(result.archivedAt);
  assert.deepEqual(f.commands, [["kill-pane", "-t", "%1"]]);
  assert.deepEqual(
    f.state.panes.map((pane) => pane.id),
    ["%2"],
  );
  assert.equal(records.get("child").archivedAt, null);
  await closeAgentCommand({ agentManager: manager }, "child");
  assert.deepEqual(f.commands.at(-1), ["kill-pane", "-t", "%2"]);
});

test("explicit superseded-owner handlers use metadata archival without dead-provider cancel or child cascade", async (t) => {
  const f = await fixture(t),
    p = [...f.topology.placements.values()][0];
  const records = new Map(
    ["ghost-B", "current-A", "child"].map((id) => [
      id,
      {
        id,
        provider: "pi",
        workspaceId: p.workspaceId,
        archivedAt: null,
        labels: id === "child" ? { "parent-agent-id": "ghost-B" } : {},
      },
    ]),
  );
  const manager = Object.create(AgentManager.prototype);
  manager.lifecycleMutationTails = new Map();
  manager.registry = {
    get: async (id) => records.get(id),
    upsert: async (record) => records.set(record.id, record),
  };
  manager.agents = new Map(); // B's bridge emitted terminal_ended: no live runtime.
  // Retained dead/tombstone provider view: cancellation would be erroneous even
  // though the manager still exposes a record after metadata archival.
  manager.getAgent = (id) => records.get(id);
  manager.discardRetainedAgentState = () => {};
  manager.dispatchStoredAgentState = () => {};
  for (const name of [
    "closeAgentRuntime",
    "closeAgent",
    "archiveAgent",
    "hasInFlightRun",
    "cancelAgentRun",
    "cascadeArchiveChildren",
    "syncNativeArchiveState",
  ]) {
    manager[name] = () => assert.fail(`must not invoke ${name} for ghost close`);
  }
  f.topology.options.archiveAgent = (...args) => manager.archiveMissingTmuxAgent(...args);
  Object.assign(f.state.panes[0], { agent: true, agentId: "ghost-B" });
  await f.topology.applySnapshot(structuredClone(f.state));
  f.state.panes[0].agentId = "current-A";
  const result = await archiveAgentCommand(
    { agentManager: manager, agentStorage: { get: async (id) => records.get(id) } },
    "ghost-B",
  );
  assert.ok(result.archivedAt);
  await closeAgentCommand({ agentManager: manager }, "ghost-B");
  assert.equal(records.get("current-A").archivedAt, null);
  assert.equal(records.get("child").archivedAt, null);
  assert.equal(f.state.panes[0].agentId, "current-A");
  assert.deepEqual(f.commands, []);
});

for (const change of ["provider changed", "workspace changed", "archive write ignored"]) {
  test(`authoritative archive callback NOOP (${change}) cannot report handled or drop ghost binding`, async (t) => {
    const f = await fixture(t),
      p = [...f.topology.placements.values()][0];
    Object.assign(f.state.panes[0], { agent: true, agentId: "ghost-B" });
    await f.topology.reconcile();
    f.state.panes[0].agentId = "current-A";
    let record = {
      id: "ghost-B",
      provider: change === "provider changed" ? "claude" : "pi",
      workspaceId: change === "workspace changed" ? "wks_tmux_moved" : p.workspaceId,
      archivedAt: null,
    };
    let ignoreWrite = change === "archive write ignored";
    const manager = Object.create(AgentManager.prototype);
    manager.lifecycleMutationTails = new Map();
    manager.agents = new Map();
    manager.registry = {
      get: async () => record,
      upsert: async (value) => {
        if (!ignoreWrite) record = value;
      },
    };
    manager.discardRetainedAgentState = () => {};
    manager.dispatchStoredAgentState = () => {};
    manager.getAgent = () =>
      assert.fail("unconfirmed archive must not fall through to provider cancellation");
    f.topology.options.archiveAgent = (...args) => manager.archiveMissingTmuxAgent(...args);
    // The lifecycle handler read the original placement before an authoritative
    // record change became visible to the callback (not a generic stale request).
    const prior = { ...record, provider: "pi", workspaceId: p.workspaceId };
    const deps = { agentManager: manager, agentStorage: { get: async () => prior } };
    await assert.rejects(archiveAgentCommand(deps, "ghost-B"), /archive was not confirmed/);
    assert.equal(record.archivedAt, null);
    const saved = JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8"));
    assert.ok(saved.agents.some(([, placement]) => placement.agentId === "ghost-B"));
    await assert.rejects(
      f.topology.closeAgent("ghost-B", p.workspaceId),
      /archive was not confirmed/,
    );
    ignoreWrite = false;
    record = { ...record, provider: "pi", workspaceId: p.workspaceId };
    deps.agentStorage.get = async () => record;
    manager.getAgent = () => record;
    assert.ok((await archiveAgentCommand(deps, "ghost-B")).archivedAt);
    assert.deepEqual(f.commands, []);
  });
}

test("compiled lifecycle handler rejects handled probe whose stored readback is unarchived", async (t) => {
  const f = await fixture(t),
    p = [...f.topology.placements.values()][0];
  t.mock.method(f.topology, "retireSupersededAgent", async () => true);
  const record = { id: "ghost-B", provider: "pi", workspaceId: p.workspaceId, archivedAt: null };
  const manager = {
    getAgent: () => record,
    hasInFlightRun: () => assert.fail("handled ghost must not cancel"),
  };
  await assert.rejects(
    archiveAgentCommand(
      { agentManager: manager, agentStorage: { get: async () => record } },
      "ghost-B",
    ),
    /missing archivedAt/,
  );
  assert.deepEqual(f.commands, []);
});

test("Pi tab refuses changed ownership instead of closing a successor or falling back to archive", async (t) => {
  const f = await fixture(t),
    p = [...f.topology.placements.values()][0];
  Object.assign(f.state.panes[0], { agent: true, agentId: "successor" });
  const record = { id: "old-owner", provider: "pi", workspaceId: p.workspaceId };
  await assert.rejects(
    archiveAgentCommand(
      {
        agentManager: {
          getAgent: () => record,
          hasInFlightRun: () => false,
          archiveAgent: () => assert.fail("must not fall back"),
        },
        logger: { trace() {} },
        agentStorage: { get: async () => record },
      },
      "old-owner",
    ),
    /ownership changed/,
  );
  assert.deepEqual(f.commands, []);
  assert.equal(f.state.panes[0].agentId, "successor");
});

for (const status of ["in_progress", "refused"]) {
  test(`unproven retirement preserves ${status} cancellation barrier before close`, async (t) => {
    const f = await fixture(t),
      p = [...f.topology.placements.values()][0];
    Object.assign(f.state.panes[0], { agent: true, agentId: "live-B" });
    await f.topology.applySnapshot(structuredClone(f.state));
    const record = { id: "live-B", provider: "pi", workspaceId: p.workspaceId };
    let cancelled = 0;
    const manager = {
      getAgent: () => record,
      hasInFlightRun: () => true,
      cancelAgentRun: async () => {
        cancelled++;
        return { status, error: new Error("refused") };
      },
    };
    t.mock.method(f.topology, "closeAgent", () =>
      assert.fail("cancellation must settle before pane close"),
    );
    await assert.rejects(
      archiveAgentCommand(
        {
          agentManager: manager,
          logger: { trace() {}, debug() {} },
          agentStorage: { get: async () => record },
        },
        "live-B",
      ),
      /cancellation is still in progress|interrupt failed/,
    );
    assert.equal(cancelled, 1);
    assert.deepEqual(f.commands, []);
  });
}

test("ghost archive callback failure prevents cancellation and preserves binding for retry", async (t) => {
  const f = await fixture(t),
    p = [...f.topology.placements.values()][0];
  Object.assign(f.state.panes[0], { agent: true, agentId: "ghost-B" });
  await f.topology.applySnapshot(structuredClone(f.state));
  f.state.panes[0].agentId = "current-A";
  const record = { id: "ghost-B", provider: "pi", workspaceId: p.workspaceId, archivedAt: null };
  const deps = {
    agentManager: {
      getAgent: () => assert.fail("callback failure must not fall through to provider"),
    },
    agentStorage: { get: async () => record },
  };
  await assert.rejects(archiveAgentCommand(deps, "ghost-B"), /archive callback unavailable/);
  f.topology.options.archiveAgent = async () => {
    throw new Error("callback failed");
  };
  await assert.rejects(archiveAgentCommand(deps, "ghost-B"), /callback failed/);
  f.topology.options.archiveAgent = async () => {
    record.archivedAt = "2026-10-22";
    return true;
  };
  deps.agentManager.getAgent = () => record;
  assert.ok((await archiveAgentCommand(deps, "ghost-B")).archivedAt);
  assert.deepEqual(f.commands, []);
});

test("workspace archive is one kill-window, not recursive agent archival or filesystem teardown", async (t) => {
  const f = await fixture(t),
    target = [...f.topology.placements.values()][0];
  f.state.panes.push({ ...f.state.panes[0], id: "%2", windowId: "@2" });
  await f.topology.applySnapshot(structuredClone(f.state));
  const other = [...f.topology.placements.values()].find((p) => p.tmuxWindowId === "@2");
  const result = await archiveByScope(
    {
      archiveWorkspaceRecord: async (id) => {
        assert.equal(id, target.workspaceId);
      },
      emitWorkspaceUpdatesForWorkspaceIds: async (ids) =>
        assert.deepEqual(ids, [target.workspaceId]),
      listActiveWorkspaces: () => assert.fail("must not resolve cwd or run generic teardown"),
    },
    { scope: { kind: "workspace", workspaceId: target.workspaceId }, requestId: "close-window" },
  );
  assert.deepEqual(f.commands, [["kill-window", "-t", "@1"]]);
  assert.equal(result.removedDirectory, false);
  assert.deepEqual(
    f.state.panes.map((p) => p.windowId),
    ["@2"],
  );
  assert.equal((await f.workspaceRegistry.get(other.workspaceId)).archivedAt, null);
});

test("project removal kills only the session and preserves windows linked into another session", async (t) => {
  const f = await fixture(t),
    target = [...f.topology.placements.values()][0];
  f.state.sessions.push({ ...f.state.sessions[0], id: "$2", name: "survivor" });
  f.state.panes.push({ ...f.state.panes[0], sessionId: "$2" });
  f.state.panes.push({ ...f.state.panes[0], id: "%2", windowId: "@2" });
  await f.topology.applySnapshot(structuredClone(f.state));
  const session = Object.create(Session.prototype),
    responses = [];
  Object.assign(session, {
    projectRegistry: f.projectRegistry,
    workspaceRegistry: f.workspaceRegistry,
    paseoHome: f.home,
    sessionLogger: { info() {}, warn() {}, error() {} },
    markWorkspaceArchiving: () => assert.fail("destroyed windows should already be retired"),
    archiveWorkspaceRecord: () => assert.fail("must not archive a linked surviving window"),
    emitWorkspaceUpdatesForWorkspaceIds: async () => {},
    emit: (value) => responses.push(value),
  });
  await session.handleProjectRemoveRequest({
    type: "project.remove.request",
    projectId: target.projectId,
    requestId: "close-session",
  });
  assert.equal(responses.at(-1).payload.accepted, true, JSON.stringify(responses));
  assert.deepEqual(f.commands, [["kill-session", "-t", "$1"]]);
  assert.deepEqual(
    f.state.panes.map((p) => [p.sessionId, p.id]),
    [["$2", "%1"]],
  );
  const surviving = await f.workspaceRegistry.get(target.workspaceId);
  assert.notEqual(surviving.projectId, target.projectId);
  assert.equal(surviving.archivedAt, null);
  assert.equal(await f.projectRegistry.get(target.projectId), null);
});

test("stale server and failed kills never fall back to a broader close", async (t) => {
  const f = await fixture(t),
    target = [...f.topology.placements.values()][0];
  f.state.serverId = "replaced-server";
  await assert.rejects(f.topology.closeWorkspace(target.workspaceId), /Stale tmux server/);
  await assert.rejects(f.topology.closeProject(target.projectId), /Stale tmux server/);
  assert.deepEqual(f.commands, []);
  f.state.serverId = target.tmuxServerId;
  t.mock.method(f.topology, "run", async () => {
    throw new Error("kill refused");
  });
  await assert.rejects(f.topology.closeWorkspace(target.workspaceId), /kill refused/);
  assert.equal((await f.workspaceRegistry.get(target.workspaceId)).archivedAt, null);
});
