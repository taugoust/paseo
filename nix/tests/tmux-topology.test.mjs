import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import net from "node:net";
import { createHash } from "node:crypto";

// Use the shipped registry schema, not a permissive test-only copy. No tmux command
// is executed: every topology process boundary is injected below.
const install = process.env.PASEO_INSTALL;
if (!install) throw new Error("Set PASEO_INSTALL to installed lib/paseo directory");
const schema = pathToFileURL(
  path.join(install, "packages/server/dist/server/server/workspace-registry.js"),
).href;
const source = (await fs.readFile(new URL("./tmux-topology.ts", import.meta.url), "utf8"))
  .replace('from "./workspace-registry.js";', `from "${schema}";`)
  .replace('from "./workspace-registry.js";', `from "${schema}";`);
const code = stripTypeScriptTypes(source, { mode: "transform" });
const {
  TmuxTopology,
  projectSnapshot,
  topologyId,
  readSnapshot,
  discoverSockets,
  startTmuxTopology,
  tmuxCommand,
  runTmux,
  tmuxSocketRoots,
  classifyPaneOwner,
  classifyBackgroundJobPane,
  classifyBackgroundJobLaunch,
  classifyManagedLaunch,
  decodeTmuxLaunchCommand,
  readPiProcessIdentity,
  claimAgentArchive,
} = await import(
  process.env.PASEO_TOPOLOGY_COMPILED === "1"
    ? pathToFileURL(path.join(install, "packages/server/dist/server/server/tmux-topology.js")).href
    : `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

test("managed launch evidence classifies the gate before import and validates committed incarnation", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-launch-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socket = path.join(directory, "socket");
  await fs.writeFile(socket, "");
  const file = path.join(directory, "launch-intent.json");
  const nonce = "a".repeat(64);
  const command = `PASEO_MANAGED_LAUNCH=${Buffer.from(file).toString("base64url")}.${nonce}; gate shell`;
  const intent = {
    schemaVersion: 1,
    command,
    nonce,
    socketPath: socket,
    serverEpoch: "1:2",
    ownerPid: 10,
    ownerToken: "10:20",
    runtimeId: "runtime",
    childId: "child",
    presentation: "background",
  };
  await fs.writeFile(file, JSON.stringify(intent), { mode: 0o600 });
  const pane = {
    startCommand: `"${command}"`,
    socket,
    serverId: "1:2:3",
    paneId: "%4",
    panePid: "30",
    dead: false,
  };
  const owner = async (pid) => ({ startToken: `boot:${pid === "10" ? "20" : "40"}`, state: "S" });
  assert.equal(await classifyManagedLaunch(pane, owner), "background");
  assert.equal(
    await classifyManagedLaunch(
      { ...pane, startCommand: `"${command}; arbitrary command"` },
      owner,
    ),
    undefined,
  );
  assert.equal(await classifyManagedLaunch({ ...pane, serverId: "1:3:3" }, owner), undefined);
  await fs.writeFile(file, JSON.stringify({ ...intent, command: undefined }));
  assert.equal(await classifyManagedLaunch(pane, owner), undefined);
  await fs.writeFile(file, JSON.stringify(intent));
  await fs.chmod(file, 0o644);
  assert.equal(await classifyManagedLaunch(pane, owner), undefined);
  await fs.chmod(file, 0o600);
  await fs.chmod(directory, 0o755);
  assert.equal(await classifyManagedLaunch(pane, owner), undefined);
  await fs.chmod(directory, 0o700);
  await fs.rename(file, `${file}.real`);
  await fs.symlink(`${file}.real`, file);
  assert.equal(await classifyManagedLaunch(pane, owner), undefined);
  await fs.unlink(file);
  await fs.rename(`${file}.real`, file);
  assert.equal(
    await classifyManagedLaunch({ ...pane, startCommand: "ordinary shell" }, owner),
    undefined,
  );
  assert.equal(await classifyManagedLaunch(pane, async () => undefined), undefined);
  await fs.writeFile(file, JSON.stringify({ ...intent, presentation: "foreground-staged" }));
  assert.equal(await classifyManagedLaunch(pane, owner), "foreground-staged");
  const manifest = {
    runtimeId: "runtime",
    childId: "child",
    panePid: 30,
    paneProcessToken: "30:40",
    placement: { ownershipNonce: nonce, paneId: "%4" },
    presentation: "background",
  };
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
  assert.equal(await classifyManagedLaunch(pane, owner), "background");
  assert.equal(
    await classifyManagedLaunch(pane, async () => ({ startToken: "boot:41", state: "S" })),
    undefined,
  );
  assert.equal(
    await classifyManagedLaunch({ ...pane, dead: true }, async () => undefined),
    "background",
  );
  assert.equal(await classifyManagedLaunch({ ...pane, paneId: "%5" }, owner), undefined);
});

test("tmux launch command decoding never evaluates or accepts unknown shell escapes", () => {
  assert.equal(
    decodeTmuxLaunchCommand('"test \\$name \\"quoted\\" \\\\ path\\n\\t\\037"'),
    'test $name "quoted" \\ path\n\t\x1f',
  );
  assert.equal(decodeTmuxLaunchCommand('"bad\\q"'), undefined);
  assert.equal(decodeTmuxLaunchCommand('"bad" suffix"'), undefined);
  assert.equal(decodeTmuxLaunchCommand('"bad\\"'), undefined);
  assert.equal(decodeTmuxLaunchCommand("unquoted"), undefined);
});

test("Linux new-session uses configured immutable systemd-run scope with exact argv", () => {
  const command = "/nix/store/test-systemd/bin/systemd-run";
  const args = [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}\x1f#{window_id}",
    "-c",
    "/path with spaces",
  ];
  assert.deepEqual(
    tmuxCommand(
      "/run/user/1000/tmux-1000/default",
      args,
      { PASEO_TMUX_SYSTEMD_RUN: command },
      "linux",
    ),
    {
      command,
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--",
        "tmux",
        "-u",
        "-S",
        "/run/user/1000/tmux-1000/default",
        ...args,
      ],
    },
  );
  assert.equal(args[0], "new-session");
});

test("polling and mutations other than new-session never create scopes", () => {
  for (const action of [
    "display-message",
    "list-sessions",
    "list-panes",
    "new-window",
    "split-window",
    "select-layout",
    "kill-pane",
  ]) {
    assert.deepEqual(
      tmuxCommand(
        "/socket",
        [action, "-t", "@1"],
        { PASEO_TMUX_SYSTEMD_RUN: "/nix/store/systemd/bin/systemd-run" },
        "linux",
      ),
      {
        command: "tmux",
        args: ["-u", "-S", "/socket", action, "-t", "@1"],
      },
    );
  }
});

test("unset scope configuration and non-Linux preserve direct launch behavior", () => {
  const expected = { command: "tmux", args: ["-u", "-S", "/socket", "new-session", "-d"] };
  assert.deepEqual(tmuxCommand("/socket", ["new-session", "-d"], {}, "linux"), expected);
  assert.deepEqual(
    tmuxCommand(
      "/socket",
      ["new-session", "-d"],
      { PASEO_TMUX_SYSTEMD_RUN: "/configured" },
      "darwin",
    ),
    expected,
  );
  assert.throws(
    () =>
      tmuxCommand("/socket", ["new-session"], { PASEO_TMUX_SYSTEMD_RUN: "systemd-run" }, "linux"),
    /absolute executable/,
  );
});

test("scope failure propagates without direct fallback; successful stdout is preserved", async (t) => {
  const previous = process.env.PASEO_TMUX_SYSTEMD_RUN;
  process.env.PASEO_TMUX_SYSTEMD_RUN = "/nix/store/test-systemd/bin/systemd-run";
  t.after(() => {
    if (previous === undefined) delete process.env.PASEO_TMUX_SYSTEMD_RUN;
    else process.env.PASEO_TMUX_SYSTEMD_RUN = previous;
  });
  const calls = [];
  const failure = new Error("user manager unavailable");
  await assert.rejects(
    runTmux("/socket", ["new-session", "-d"], async (command, args) => {
      calls.push({ command, args });
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    {
      command: process.env.PASEO_TMUX_SYSTEMD_RUN,
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--",
        "tmux",
        "-u",
        "-S",
        "/socket",
        "new-session",
        "-d",
      ],
    },
  ]);
  assert.equal(
    await runTmux("/socket", ["new-session", "-P"], async () => "$2\x1f@3\n"),
    "$2\x1f@3",
  );
});

function snapshot() {
  return {
    socket: "/fake/socket",
    serverId: "100:123:456",
    sessions: [
      { id: "$10", name: "same directory", cwd: "/same", infrastructure: false },
      { id: "$2", name: "another session", cwd: "/same", infrastructure: false },
      { id: "$0", name: "staging", cwd: "/same", infrastructure: true },
    ],
    panes: [
      {
        sessionId: "$10",
        windowId: "@1",
        windowName: "window one",
        id: "%1",
        cwd: "/same",
        command: "bash",
        infrastructure: false,
        agent: false,
      },
      {
        sessionId: "$2",
        windowId: "@2",
        windowName: "window two",
        id: "%2",
        cwd: "/same",
        command: "pi",
        infrastructure: false,
        agent: true,
      },
      {
        sessionId: "$0",
        windowId: "@0",
        windowName: "staged",
        id: "%0",
        cwd: "/same",
        command: "pi",
        infrastructure: false,
        agent: true,
      },
    ],
  };
}
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "paseo-topology-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  function registry() {
    const records = new Map();
    const writes = [];
    return {
      records,
      writes,
      get: async (id) => records.get(id) ?? null,
      list: async () => [...records.values()],
      update: async (id, fn) => {
        const record = fn(records.get(id) ?? null);
        records.set(id, record);
        writes.push(record);
        return record;
      },
      upsert: async (record) => {
        records.set(
          record.projectId && !record.workspaceId ? record.projectId : record.workspaceId,
          record,
        );
        writes.push(record);
      },
      archive: async (id, now) => {
        const record = records.get(id);
        records.set(id, { ...record, archivedAt: now });
      },
    };
  }
  const projects = registry(),
    workspaces = registry(),
    terminals = new Map(),
    creates = [],
    detaches = [],
    calls = [];
  const terminalManager = {
    createTerminal: async (input) => {
      creates.push(input);
      const session = {
        title: input.title,
        getTitle() {
          return this.title;
        },
        setTitle(title) {
          this.title = title;
        },
      };
      terminals.set(input.id, session);
      return { ...input, id: input.id };
    },
    getTerminal: (id) => terminals.get(id),
    setTerminalTitle: (id, title) => {
      const session = terminals.get(id);
      if (!session) return false;
      session.setTitle(title);
      return true;
    },
    killTerminal: (id) => {
      detaches.push(id);
      terminals.delete(id);
    },
  };
  let current = snapshot();
  current.socket = path.join(home, "socket");
  const options = {
    paseoHome: home,
    launchDirectory: path.join(home, "launches"),
    projectRegistry: projects,
    workspaceRegistry: workspaces,
    terminalManager,
    logger: { warn() {} },
    sockets: async () => [current.socket],
    snapshot: async () => structuredClone(current),
    run: async (socket, args) => {
      calls.push([socket, args]);
      if (args[0] === "split-window") {
        current.panes.push({ ...current.panes[0], id: "%9" });
        return "%9";
      }
      if (args[0] === "new-window") {
        current.panes.push({ ...current.panes[0], windowId: "@9", id: "%9" });
        return "@9";
      }
      if (args[0] === "new-session") {
        current.sessions.push({
          id: "$20",
          name: "new session",
          cwd: "/same",
          infrastructure: false,
        });
        current.panes.push({ ...current.panes[0], sessionId: "$20", windowId: "@20", id: "%20" });
        return "$20\x1f@20";
      }
      return "";
    },
  };
  const topology = new TmuxTopology(options);
  t.after(() => topology.stop());
  return {
    topology,
    options,
    projects,
    workspaces,
    terminalManager,
    creates,
    detaches,
    calls,
    home,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
  };
}

test("new topology activation is Linux-only even when explicitly enabled", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const enabled = process.env.PASEO_TMUX_TOPOLOGY;
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    if (enabled === undefined) delete process.env.PASEO_TMUX_TOPOLOGY;
    else process.env.PASEO_TMUX_TOPOLOGY = enabled;
  });
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.env.PASEO_TMUX_TOPOLOGY = "1";
  assert.equal(await startTmuxTopology({}), undefined);
});

test("sessions/windows/panes keep independent identities despite identical cwd; infrastructure excluded", () => {
  const s = snapshot();
  const p = projectSnapshot(s);
  assert.equal(p.sessions.length, 2);
  assert.equal(p.windows.length, 2);
  assert.notEqual(p.windows[0].workspaceId, p.windows[1].workspaceId);
  assert.notEqual(p.windows[0].projectId, p.windows[1].projectId);
  const renamed = structuredClone(s);
  renamed.sessions[0].name = "renamed";
  renamed.panes[0].cwd = "/elsewhere";
  assert.equal(projectSnapshot(renamed).windows[0].workspaceId, p.windows[0].workspaceId);
  assert.notEqual(topologyId("prj", "/a", "1", "$1"), topologyId("prj", "/b", "1", "$1"));
  assert.notEqual(topologyId("prj", "/a", "1", "$1"), topologyId("prj", "/a", "2", "$1"));
});

test("host absolute pane proxy override is used without relying on PATH", async (t) => {
  const before = process.env.PASEO_TMUX_PANE_PROXY;
  t.after(() => {
    if (before === undefined) delete process.env.PASEO_TMUX_PANE_PROXY;
    else process.env.PASEO_TMUX_PANE_PROXY = before;
  });
  process.env.PASEO_TMUX_PANE_PROXY = "/nix/store/test/bin/paseo-tmux-pane";
  const f = await fixture(t);
  await f.topology.start();
  assert.equal(f.creates[0].command, process.env.PASEO_TMUX_PANE_PROXY);
});

test("linked windows choose lowest numeric eligible session; owner changes preserve workspace ID", () => {
  const s = snapshot();
  s.panes.push({ ...s.panes[0], sessionId: "$2" });
  const linked = projectSnapshot(s).windows.find((w) => w.tmuxWindowId === "@1");
  assert.equal(linked.tmuxSessionId, "$2");
  assert.equal(linked.panes.length, 1);
  const original = projectSnapshot(snapshot()).windows.find((w) => w.tmuxWindowId === "@1");
  assert.equal(linked.workspaceId, original.workspaceId);
  assert.notEqual(linked.projectId, original.projectId);
});

test("import uses real schema, is idempotent, agent panes never get terminal resources", async (t) => {
  const f = await fixture(t);
  await f.topology.start();
  await f.topology.reconcile();
  assert.equal(f.projects.records.size, 2);
  assert.equal(f.workspaces.records.size, 2);
  assert.equal(f.projects.writes.length, 2);
  assert.equal(f.workspaces.writes.length, 2);
  assert.equal(f.creates.length, 1);
  assert.equal(f.creates[0].args[1], f.current.socket);
  assert.deepEqual(f.calls, []);
  const index = JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8"));
  assert.equal(index.placements.length, 2);
  assert.equal(JSON.stringify(index).includes("token"), false);
});

test("ordinary→agent and pane move detach proxies only, never kill user panes", async (t) => {
  const f = await fixture(t);
  await f.topology.start();
  f.current.panes[0].agent = true;
  await f.topology.reconcile();
  assert.equal(f.detaches.length, 1);
  assert.deepEqual(f.calls, []);
  f.current.panes[0].agent = false;
  await f.topology.reconcile();
  f.current.panes[0].windowId = "@2";
  f.current.panes[0].sessionId = "$2";
  await f.topology.reconcile();
  assert.equal(f.detaches.length, 2);
  assert.deepEqual(f.calls, []);
});

test("UI terminal creation allocates pane in exact workspace and close alone kills it", async (t) => {
  const f = await fixture(t);
  await f.topology.start();
  const p = [...f.topology.placements.values()][0];
  const terminal = await f.terminalManager.createTerminal({
    cwd: "/other",
    workspaceId: p.workspaceId,
    command: "/a path/tool",
    args: ["quote' ; touch /bad"],
    env: { TEST: "ok" },
  });
  assert.equal(f.calls[0][1][0], "split-window");
  assert.equal(f.calls[0][1][6], p.tmuxWindowId);
  assert.equal(f.creates.at(-1).name, "%9");
  assert.ok(f.calls[0][1].includes("TEST=ok"));
  await f.topology.reconcile();
  assert.equal(f.creates.length, 2);
  assert.equal(await f.topology.closeTerminal(terminal.id), true);
  assert.equal(await f.topology.closeTerminal(terminal.id), false);
  assert.equal(f.calls.at(-1)[1][0], "kill-pane");
  assert.equal(f.calls.at(-1)[1][2], "%9");
});

test("workspace and root project submissions materialize windows/sessions; Pi env targets real window", async (t) => {
  const f = await fixture(t);
  await f.topology.start();
  const p = [...f.topology.placements.values()][0];
  const workspace = await f.topology.createWorkspace(p.projectId, "/same", "fork");
  assert.equal(f.calls[0][1][0], "new-window");
  assert.notEqual(workspace.workspaceId, p.workspaceId);
  const env = await f.topology.agentEnv(workspace.workspaceId, "agent-1");
  assert.deepEqual(JSON.parse(env.PI_PASEO_TMUX_TARGET), {
    version: 1,
    ...f.topology.placements.get(workspace.workspaceId),
  });
  assert.equal(env.PASEO_TMUX_WINDOW_ID, "@9");
  assert.equal(env.PASEO_WORKSPACE_ID, workspace.workspaceId);
  assert.equal(env.PASEO_AGENT_ID, "agent-1");
  await assert.rejects(f.topology.agentEnv(undefined, "agent-2"), /explicit/);
  const newRoot = await f.topology.createWorkspace(undefined, "/same");
  assert.equal(f.calls.at(-1)[1][0], "new-session");
  assert.notEqual(newRoot.projectId, p.projectId);
});

test("failed socket is not death; server incarnation change detaches only; stale create rejected", async (t) => {
  const f = await fixture(t);
  await f.topology.start();
  const p = [...f.topology.placements.values()][0];
  f.options.snapshot = async () => {
    throw new Error("transient disconnect");
  };
  await f.topology.reconcile();
  assert.equal(f.detaches.length, 0);
  assert.equal(f.topology.placements.size, 2);
  f.current.serverId = "new-incarnation";
  f.options.snapshot = async () => structuredClone(f.current);
  await assert.rejects(f.topology.createWorkspace(p.projectId, "/same"), /Stale/);
  assert.deepEqual(f.calls, []);
  await f.topology.reconcile();
  assert.equal(f.detaches.length, 1);
  assert.deepEqual(f.calls, []);
});

test("tagged Pi follows window placement without replacing its TUI or creating a terminal", async (t) => {
  const f = await fixture(t);
  const associations = [];
  f.options.associateAgent = async (id, workspaceId) => associations.push([id, workspaceId]);
  f.current.panes[1].agentId = "pi-agent";
  await f.topology.start();
  const before = associations.at(-1)[1];
  f.current.panes[1].windowId = "@1";
  f.current.panes[1].sessionId = "$10";
  await f.topology.reconcile();
  assert.notEqual(associations.at(-1)[1], before);
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.calls, []);
});

test("absent known socket retires projection; missing executable does not", async (t) => {
  const f = await fixture(t);
  await f.topology.start();
  f.options.snapshot = async () => {
    throw Object.assign(new Error("missing binary"), { code: "ENOENT", path: "tmux" });
  };
  await f.topology.reconcile();
  assert.equal(f.topology.placements.size, 2);
  f.options.sockets = async () => [];
  f.options.snapshot = async (socket) => {
    throw Object.assign(new Error("missing socket"), { code: "ENOENT", path: socket });
  };
  await f.topology.reconcile();
  assert.equal(f.topology.placements.size, 0);
  assert.equal(f.detaches.length, 1);
  assert.deepEqual(f.calls, []);
});

test("fork bootstrap gap retains live launch, observes successor, and later reaps normally", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => archived.push(args);
  f.current.panes[1].agentId = "fork-pi";
  await f.topology.start();
  const successor = { ...f.current.panes[1], id: "%41" };
  const release = await claimAgentArchive("fork-pi", f.options.launchDirectory);
  assert.ok(release);
  t.after(release);
  f.current.panes = f.current.panes.filter((p) => p.id !== "%2");
  await f.topology.reconcile();
  assert.deepEqual(archived, []);
  await release();
  f.current.panes.push(successor);
  await f.topology.reconcile();
  assert.deepEqual(archived, []);
  f.current.panes = f.current.panes.filter((p) => p.id !== "%41");
  await f.topology.reconcile();
  assert.equal(archived.length, 1);
});

test("stale missing-pane snapshot cannot archive a newly published successor", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => archived.push(args);
  f.current.panes[1].agentId = "fork-pi";
  await f.topology.start();
  const stale = structuredClone(f.current);
  stale.panes = stale.panes.filter((p) => p.id !== "%2");
  f.current.panes[1].id = "%41";
  await f.topology.applySnapshot(stale);
  assert.deepEqual(archived, []);
  await f.topology.reconcile();
  assert.deepEqual(archived, []);
});

test("archive claims distinguish live, dead, reused and malformed owners without deleting foreign claims", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "archive-claim-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, createHash("sha256").update("agent").digest("hex") + ".json");
  const claim = { agentId: "agent", pid: 42, processStartToken: "abc:123", nonce: "nonce" };
  await fs.writeFile(file, JSON.stringify(claim));
  assert.equal(
    await claimAgentArchive("agent", dir, async () => ({ startToken: "abc:123", state: "S" })),
    undefined,
  );
  for (const owner of [
    undefined,
    { startToken: "abc:124", state: "S" },
    { startToken: "abc:123", state: "Z" },
  ]) {
    const release = await claimAgentArchive("agent", dir, async () => owner);
    assert.ok(release);
    await release();
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), claim);
  }
  await fs.writeFile(file, "{");
  await assert.rejects(claimAgentArchive("agent", dir));
  await fs.writeFile(file, JSON.stringify(claim));
  await assert.rejects(
    claimAgentArchive("agent", dir, async () => {
      throw new Error("permission denied");
    }),
    /permission denied/,
  );
});

test("confirmed reap archives only tracked missing Pi pane once and never mutates another pane", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => archived.push(args);
  f.current.panes[1].agentId = "reaped-pi";
  await f.topology.start();
  const owner = [...f.topology.placements.values()].find((p) => p.tmuxWindowId === "@2");
  f.current.panes = f.current.panes.filter((p) => p.id !== "%2");
  await f.topology.reconcile();
  await f.topology.reconcile();
  assert.deepEqual(archived, [["reaped-pi", owner.workspaceId]]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.creates.length, 1); // unrelated ordinary pane survives
  const saved = JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8"));
  assert.deepEqual(saved.agents, []);
});

test("missing-pane explicit archive refusal retains binding while legacy void callback remains compatible", async (t) => {
  const f = await fixture(t);
  f.current.panes[1].agentId = "missing-pi";
  await f.topology.start();
  f.current.panes = f.current.panes.filter((p) => p.id !== "%2");
  f.options.archiveAgent = async () => false;
  await f.topology.reconcile();
  const file = path.join(f.home, "tmux-topology.json");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).agents.length, 1);
  f.options.archiveAgent = async () => {}; // Deliberately preserve old callback compatibility.
  await f.topology.reconcile();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).agents, []);
  assert.deepEqual(f.calls, []);
});

test("persisted pane-agent ownership survives Paseo restart and detects an offline reap", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => archived.push(args);
  f.current.panes[1].agentId = "persisted-pi";
  await f.topology.start();
  f.topology.stop();
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8")).agents.length,
    1,
  );
  const again = new TmuxTopology(f.options);
  t.after(() => again.stop());
  await again.start();
  assert.deepEqual(archived, []);
  again.stop();
  f.current.panes = f.current.panes.filter((p) => p.id !== "%2");
  const afterReap = new TmuxTopology(f.options);
  t.after(() => afterReap.stop());
  await afterReap.start();
  assert.equal(archived.length, 1);
  assert.equal(archived[0][0], "persisted-pi");
  assert.deepEqual(f.calls, []);
});

test("socket failure/absence and a different tmux incarnation never prove agent reap", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => archived.push(args);
  f.current.panes[1].agentId = "retained-pi";
  await f.topology.start();
  f.options.snapshot = async () => {
    throw new Error("timeout");
  };
  await f.topology.reconcile();
  f.options.snapshot = async (socket) => {
    throw Object.assign(new Error("absent socket"), { code: "ENOENT", path: socket });
  };
  await f.topology.reconcile();
  f.current.serverId = "different-incarnation";
  f.current.panes = [];
  f.options.snapshot = async () => structuredClone(f.current);
  await f.topology.reconcile();
  assert.deepEqual(archived, []);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8")).agents.length,
    1,
  );
  assert.deepEqual(f.calls, []);
});

test("same pane moving windows or into infrastructure is not reaped; new owner is persisted", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => archived.push(args);
  f.current.panes[1].agentId = "moving-pi";
  await f.topology.start();
  f.current.panes[1].windowId = "@1";
  f.current.panes[1].sessionId = "$10";
  await f.topology.reconcile();
  const saved = JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8"));
  assert.equal(saved.agents[0][1].workspaceId, [...f.topology.placements.values()][0].workspaceId);
  f.current.panes[1].infrastructure = true;
  f.current.panes[1].sessionId = "$0";
  await f.topology.reconcile();
  assert.deepEqual(archived, []);
  assert.deepEqual(f.calls, []);
});

test("failed archive callback retains ownership for idempotent retry", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.options.archiveAgent = async () => {
    if (++attempts === 1)
      throw Object.assign(new Error("provider cleanup failed"), { stderr: "Connection refused" });
  };
  f.current.panes[1].agentId = "retry-pi";
  await f.topology.start();
  f.current.panes = f.current.panes.filter((p) => p.id !== "%2");
  await f.topology.reconcile();
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8")).agents.length,
    1,
  );
  assert.equal(f.topology.placements.size, 2); // callback failure must not become synthetic socket death
  await f.topology.reconcile();
  await f.topology.reconcile();
  assert.equal(attempts, 2);
  assert.deepEqual(f.calls, []);
});

test("terminal split requests tiled layout, but layout failure does not roll back a real pane", async (t) => {
  const f = await fixture(t);
  const run = f.options.run;
  const topology = new TmuxTopology({
    ...f.options,
    run: async (socket, args) => {
      const result = await run(socket, args);
      if (args[0] === "select-layout") throw new Error("layout unavailable");
      return result;
    },
  });
  t.after(() => topology.stop());
  await topology.start();
  const p = [...topology.placements.values()][0];
  const terminal = await f.terminalManager.createTerminal({
    cwd: "/same",
    workspaceId: p.workspaceId,
  });
  assert.ok(terminal.id);
  assert.deepEqual(
    f.calls.map((c) => c[1][0]),
    ["split-window", "select-layout"],
  );
  assert.deepEqual(f.calls[1][1], ["select-layout", "-t", p.tmuxWindowId, "tiled"]);
});

test("stale ID/dead PID/reused PID/missing token never hide an ordinary returned shell", async () => {
  const ordinary = { agent: false, agentId: undefined };
  assert.deepEqual(await classifyPaneOwner({ command: "zsh", agentId: "stale" }), ordinary);
  assert.deepEqual(
    await classifyPaneOwner({ command: "zsh", pid: "42", agentId: "stale" }, async () => ({
      startToken: "abcd:1",
      state: "S",
    })),
    ordinary,
  );
  const tagged = { command: "zsh", pid: "42", startToken: "abcd:1", agentId: "stale" };
  assert.deepEqual(await classifyPaneOwner(tagged, async () => undefined), ordinary);
  assert.deepEqual(
    await classifyPaneOwner(tagged, async () => ({ startToken: "abcd:2", state: "S" })),
    ordinary,
  );
  assert.deepEqual(
    await classifyPaneOwner(tagged, async () => ({ startToken: "abcd:1", state: "Z" })),
    ordinary,
  );
});

test("valid Pi PID/start token protects foreground bash/agentsh children and startup without an agent ID", async () => {
  const read = async () => ({ startToken: "abcd:1234", state: "S" });
  for (const command of ["bash", "zsh", "agentsh", "sleep", "node"]) {
    assert.deepEqual(
      await classifyPaneOwner(
        { command, pid: "42", startToken: "abcd:1234", agentId: "live" },
        read,
      ),
      { agent: true, agentId: "live" },
    );
  }
  assert.deepEqual(
    await classifyPaneOwner({ command: "bash", pid: "42", startToken: "abcd:1234" }, read),
    { agent: true, agentId: undefined },
  );
  assert.deepEqual(await classifyPaneOwner({ command: "pi", agentId: "stale" }), {
    agent: true,
    agentId: undefined,
  });
});

test("unknown owner inspection failure is not interpreted as ordinary-shell transition", async () => {
  await assert.rejects(
    classifyPaneOwner(
      { command: "zsh", pid: "42", startToken: "abcd:1234", agentId: "live" },
      async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    ),
    /permission denied/,
  );
  const identity = await readPiProcessIdentity(String(process.pid));
  const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  assert.ok(identity.startToken.startsWith(`${boot}:`));
  assert.match(identity.startToken.slice(boot.length + 1), /^\d+$/);
});

test("same-pane Pi exit archives old agent and exposes existing shell without killing pane/window", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => archived.push(args);
  f.current.panes[1].agentId = "exited-pi";
  await f.topology.start();
  const workspace = [...f.topology.placements.values()].find((p) => p.tmuxWindowId === "@2");
  Object.assign(
    f.current.panes[1],
    { command: "zsh" },
    await classifyPaneOwner(
      { command: "zsh", agentId: "exited-pi", pid: "42", startToken: "abcd:1" },
      async () => undefined,
    ),
  );
  await f.topology.reconcile();
  await f.topology.reconcile();
  assert.deepEqual(archived, [["exited-pi", workspace.workspaceId]]);
  assert.equal(f.topology.placements.size, 2);
  assert.equal(f.creates.length, 2);
  assert.equal(f.creates.at(-1).workspaceId, workspace.workspaceId);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.detaches, []);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8")).agents.length,
    0,
  );
});

test("unknown startup owner is protected, verified same-pane successor retires only old metadata", async (t) => {
  const f = await fixture(t);
  const archived = [];
  f.options.archiveAgent = async (...args) => {
    archived.push(args);
    return true;
  };
  f.current.panes[1].agentId = "old-pi";
  await f.topology.start();
  Object.assign(
    f.current.panes[1],
    await classifyPaneOwner({ command: "agentsh", pid: "42", startToken: "abcd:2" }, async () => ({
      startToken: "abcd:2",
      state: "S",
    })),
  );
  await f.topology.reconcile();
  f.current.panes[1].agentId = "successor";
  await f.topology.reconcile();
  f.current.panes[1].sessionId = "$10";
  f.current.panes[1].windowId = "@1";
  await f.topology.reconcile();
  assert.deepEqual(
    archived.map((a) => a[0]),
    ["old-pi"],
  );
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.calls, []);
});

// Clara: B forked from A's native session, ended, then A reclaimed the SAME
// verified server/pane/workspace. Session ancestry is not ownership evidence.
const ghostB = "6d341e62-ghost-B";
const currentA = "54217fe0-current-A";
async function ghostFixture(t) {
  const f = await fixture(t);
  f.archived = [];
  f.options.archiveAgent = async (...args) => {
    if (!f.archived.some((a) => a[0] === args[0])) f.archived.push(args);
    return true;
  };
  f.current.serverId = "1107101:23656991:192";
  f.current.panes[1].id = "%1";
  f.current.panes[0].id = "%9";
  f.current.panes[1].agentId = ghostB;
  await f.topology.start();
  f.topology.stop();
  f.workspace = [...f.topology.placements.values()].find(
    (p) => p.tmuxWindowId === "@2",
  ).workspaceId;
  f.current.panes[1].agentId = currentA;
  return f;
}
async function savedAgents(f) {
  return JSON.parse(await fs.readFile(path.join(f.home, "tmux-topology.json"), "utf8")).agents.map(
    ([, p]) => p.agentId,
  );
}

test("Clara B->A same-pane ghost retires once, persisted restart and explicit close are handled without tmux mutation", async (t) => {
  const f = await ghostFixture(t);
  const archive = f.options.archiveAgent;
  delete f.options.archiveAgent;
  await f.topology.reconcile();
  assert.deepEqual(await savedAgents(f), [ghostB, currentA]); // confirmed on-disk ghost shape
  f.options.archiveAgent = archive;
  const restarted = new TmuxTopology(f.options);
  t.after(() => restarted.stop());
  await restarted.start();
  restarted.stop();
  assert.deepEqual(f.archived, [[ghostB, f.workspace]]);
  assert.deepEqual(await savedAgents(f), [currentA]);
  const again = new TmuxTopology(f.options);
  t.after(() => again.stop());
  await again.start();
  again.stop();
  assert.equal(await again.closeAgent(ghostB, f.workspace), true);
  assert.equal(await again.closeAgent(ghostB, f.workspace), true);
  assert.equal(f.archived.length, 1);
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.detaches, []);
});

test("metadata-only retirement probe handles known successor but never closes live, missing or unknown owners", async (t) => {
  const f = await ghostFixture(t);
  f.current.panes[1].agentId = ghostB;
  assert.equal(await f.topology.retireSupersededAgent(ghostB, f.workspace), false);
  assert.equal(await f.topology.retireSupersededAgent("unknown", f.workspace), false);
  const pane = f.current.panes.splice(1, 1)[0];
  assert.equal(await f.topology.retireSupersededAgent(ghostB, f.workspace), false);
  f.current.panes.push({ ...pane, agentId: currentA });
  assert.equal(await f.topology.retireSupersededAgent(ghostB, "wks_tmux_wrong"), false);
  assert.equal(await f.topology.retireSupersededAgent(ghostB, f.workspace), true);
  assert.equal(await f.topology.retireSupersededAgent(ghostB, f.workspace), true);
  assert.deepEqual(f.archived, [[ghostB, f.workspace]]);
  assert.deepEqual(f.calls, []);
});

test("explicit ghost close before reconciliation archives metadata, not successor pane or descendants", async (t) => {
  const f = await ghostFixture(t);
  assert.equal(await f.topology.closeAgent(ghostB, f.workspace), true);
  assert.deepEqual(f.archived, [[ghostB, f.workspace]]);
  assert.deepEqual(await savedAgents(f), []);
  assert.equal(f.current.panes[1].agentId, currentA);
  assert.deepEqual(f.calls, []);
  assert.equal(f.creates.length, 1);
});

for (const guard of [
  "unknown owner",
  "legacy owner",
  "infrastructure pane",
  "infrastructure session",
  "unknown session",
  "changed incarnation",
  "changed workspace",
  "ambiguous rows",
  "old owner elsewhere",
  "other socket old owner",
  "other socket unavailable",
  "callback unavailable",
  "live launch claim",
  "return of old owner",
  "successor changed",
]) {
  test(`same-pane successor retirement fails closed: ${guard}`, async (t) => {
    const f = await ghostFixture(t);
    if (guard === "unknown owner") delete f.current.panes[1].agentId;
    if (guard === "legacy owner")
      Object.assign(f.current.panes[1], { command: "pi", agentId: undefined });
    if (guard === "infrastructure pane") f.current.panes[1].infrastructure = true;
    if (guard === "infrastructure session")
      f.current.sessions.find((s) => s.id === "$2").infrastructure = true;
    if (guard === "unknown session")
      f.current.sessions = f.current.sessions.filter((s) => s.id !== "$2");
    if (guard === "changed incarnation") f.current.serverId = "1107101:other:192";
    if (guard === "changed workspace") f.current.panes[1].windowId = "@1";
    if (guard === "ambiguous rows")
      f.current.panes.push({ ...f.current.panes[1], agentId: "third-owner" });
    if (guard === "old owner elsewhere")
      f.current.panes.push({ ...f.current.panes[1], id: "%99", agentId: ghostB });
    if (guard.startsWith("other socket")) {
      f.options.sockets = async () => [f.current.socket, "/other/socket"];
      f.options.snapshot = async (socket) => {
        if (socket === f.current.socket) return structuredClone(f.current);
        if (guard === "other socket unavailable") throw new Error("unavailable");
        return {
          ...structuredClone(f.current),
          socket,
          panes: [{ ...f.current.panes[1], agentId: ghostB }],
        };
      };
    }
    if (guard === "callback unavailable") delete f.options.archiveAgent;
    if (guard === "live launch claim") {
      const release = await claimAgentArchive(ghostB, f.options.launchDirectory);
      t.after(release);
    }
    if (guard === "return of old owner" || guard === "successor changed") {
      let reads = 0;
      f.options.snapshot = async () => {
        const value = structuredClone(f.current);
        if (++reads > 1)
          value.panes[1].agentId = guard === "return of old owner" ? ghostB : "third-owner";
        return value;
      };
    }
    await f.topology.reconcile();
    assert.deepEqual(f.archived, []);
    // A live old agent elsewhere may update its binding, but must not archive.
    assert.ok((await savedAgents(f)).includes(ghostB));
    assert.deepEqual(f.calls, []);
    assert.equal(f.creates.length, guard === "changed incarnation" ? 2 : 1);
  });
}

for (const guard of [
  "unknown owner",
  "callback unavailable",
  "changed incarnation",
  "return of old owner",
]) {
  test(`explicit ghost close refuses uncertainty without fallthrough: ${guard}`, async (t) => {
    const f = await ghostFixture(t);
    if (guard === "unknown owner") delete f.current.panes[1].agentId;
    if (guard === "callback unavailable") delete f.options.archiveAgent;
    if (guard === "changed incarnation") f.current.serverId = "restarted";
    if (guard === "return of old owner") {
      let reads = 0;
      f.options.snapshot = async () => {
        const s = structuredClone(f.current);
        if (++reads > 1) s.panes[1].agentId = ghostB;
        return s;
      };
    }
    await assert.rejects(
      f.topology.closeAgent(ghostB, f.workspace),
      /ownership changed|Stale tmux/,
    );
    assert.deepEqual(f.archived, []);
    assert.deepEqual(f.calls, []);
    assert.ok((await savedAgents(f)).includes(ghostB));
  });
}

for (const result of [false, undefined]) {
  test(`fulfilled but unconfirmed archive callback (${result}) never retires binding or reports handled`, async (t) => {
    const f = await ghostFixture(t);
    f.options.archiveAgent = async () => result;
    await assert.rejects(
      f.topology.retireSupersededAgent(ghostB, f.workspace),
      /archive was not confirmed/,
    );
    await assert.rejects(f.topology.closeAgent(ghostB, f.workspace), /archive was not confirmed/);
    await f.topology.reconcile();
    assert.ok((await savedAgents(f)).includes(ghostB));
    assert.deepEqual(f.calls, []);
  });
}

test("persisted retirement receipt requires fresh authoritative archive confirmation", async (t) => {
  const f = await ghostFixture(t);
  await f.topology.reconcile();
  f.options.archiveAgent = async () => false;
  const restarted = new TmuxTopology(f.options);
  t.after(() => restarted.stop());
  await restarted.start();
  restarted.stop();
  await assert.rejects(
    restarted.retireSupersededAgent(ghostB, f.workspace),
    /archive was not confirmed/,
  );
  await assert.rejects(restarted.closeAgent(ghostB, f.workspace), /archive was not confirmed/);
  assert.deepEqual(f.calls, []);
});

test("successor archival holds exclusive old-agent launch claim through callback", async (t) => {
  const f = await ghostFixture(t);
  f.options.archiveAgent = async () => {
    assert.equal(await claimAgentArchive(ghostB, f.options.launchDirectory), undefined);
    return true;
  };
  assert.equal(await f.topology.closeAgent(ghostB, f.workspace), true);
  const release = await claimAgentArchive(ghostB, f.options.launchDirectory);
  assert.ok(release);
  await release();
  assert.deepEqual(f.calls, []);
});

test("automatic successor callback failure persists binding and retries idempotently", async (t) => {
  const f = await ghostFixture(t);
  let attempts = 0;
  f.options.archiveAgent = async (...args) => {
    if (++attempts === 1) throw new Error("archive failed");
    f.archived.push(args);
    return true;
  };
  await f.topology.reconcile();
  assert.ok((await savedAgents(f)).includes(ghostB));
  await f.topology.reconcile();
  await f.topology.reconcile();
  assert.deepEqual(await savedAgents(f), [currentA]);
  assert.deepEqual(f.archived, [[ghostB, f.workspace]]);
  assert.equal(attempts, 2);
  assert.deepEqual(f.calls, []);
  assert.equal(f.creates.length, 1);
});

test("successor callback failure keeps old binding until successful explicit retry", async (t) => {
  const f = await ghostFixture(t);
  let attempts = 0;
  f.options.archiveAgent = async (...args) => {
    if (++attempts === 1) throw new Error("archive failed");
    f.archived.push(args);
    return true;
  };
  await assert.rejects(f.topology.closeAgent(ghostB, f.workspace), /archive failed/);
  assert.ok((await savedAgents(f)).includes(ghostB));
  assert.equal(await f.topology.closeAgent(ghostB, f.workspace), true);
  assert.deepEqual(f.archived, [[ghostB, f.workspace]]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.creates.length, 1);
});

test("restart loads identity index and does not recreate existing proxies", async (t) => {
  const f = await fixture(t);
  await f.topology.start();
  f.topology.stop();
  const again = new TmuxTopology(f.options);
  t.after(() => again.stop());
  await again.start();
  assert.equal(f.creates.length, 1);
  assert.equal(again.placements.size, 2);
});

test("background job presentation requires a valid job marker and matching live process incarnation", async () => {
  const input = { jobId: `job-${"a".repeat(24)}`, pid: "123", startToken: "linux-proc:456" };
  assert.equal(
    await classifyBackgroundJobPane(input, async () => ({ startToken: "abcd:456", state: "S" })),
    true,
  );
  for (const owner of [
    undefined,
    { startToken: "abcd:789", state: "S" },
    { startToken: "abcd:456", state: "Z" },
  ]) {
    assert.equal(await classifyBackgroundJobPane(input, async () => owner), false);
  }
  for (const change of [{ jobId: "ordinary" }, { pid: "0" }, { startToken: "" }]) {
    assert.equal(
      await classifyBackgroundJobPane({ ...input, ...change }, async () =>
        assert.fail("invalid evidence must not inspect a process"),
      ),
      false,
    );
  }
  assert.equal(
    await classifyBackgroundJobPane({ ...input, dead: true }, async () =>
      assert.fail("retained dead pane needs no live process"),
    ),
    true,
  );
  await assert.rejects(
    classifyBackgroundJobPane(input, async () => {
      throw Error("permission denied");
    }),
    /permission denied/,
  );
});

for (const companion of [
  "verified job",
  "retained job",
  "ordinary shell",
  "unverified job",
  "root agent",
]) {
  test(`managed child workspace background classification with ${companion}`, async (t) => {
    const f = await fixture(t);
    f.options.isBackgroundAgent = async (id) => id === "managed-child";
    Object.assign(f.current.panes[0], { command: "pi", agent: true, agentId: "managed-child" });
    f.current.panes.push({
      ...f.current.panes[0],
      id: "%20",
      command: "node",
      agent: companion === "root agent",
      agentId: companion === "root agent" ? "root" : undefined,
      backgroundJob: ["verified job", "retained job"].includes(companion),
    });
    await f.topology.start();
    const workspace = [...f.workspaces.records.values()].find(
      (w) => w.displayName === "window one",
    );
    assert.equal(workspace.background, ["verified job", "retained job"].includes(companion));
    assert.deepEqual(f.calls, [], "classification cannot mutate panes");
  });
}

for (const mixed of [false, true]) {
  test(`initial managed gate publication preserves mixed=${mixed} visibility`, async (t) => {
    const f = await fixture(t);
    f.options.isBackgroundAgent = async () => assert.fail("gate has no imported agent");
    f.current.panes = [{ ...f.current.panes[0], command: "sh", agent: false, managedLaunch: true }];
    if (mixed) f.current.panes.push({ ...f.current.panes[0], id: "%20", managedLaunch: false });
    await f.topology.start();
    assert.equal([...f.workspaces.records.values()][0].background, !mixed);
    assert.deepEqual(f.calls, [], "launch classification cannot mutate panes");
  });
}

for (const mixed of [false, true]) {
  test(`job-only initial publication preserves mixed=${mixed} visibility`, async (t) => {
    const f = await fixture(t);
    f.options.isBackgroundAgent = async () => assert.fail("no agent to classify");
    f.current.panes = [{ ...f.current.panes[0], agent: false, backgroundJob: true }];
    if (mixed) f.current.panes.push({ ...f.current.panes[0], id: "%20", backgroundJob: false });
    await f.topology.start();
    assert.equal([...f.workspaces.records.values()][0].background, !mixed);
    assert.deepEqual(f.calls, [], "classification cannot mutate panes");
  });
}

test("job launch evidence validates creation, commit, completion and rejects stale or forged evidence", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-job-launch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socket = path.join(directory, "socket");
  await fs.writeFile(socket, "");
  const file = path.join(directory, "launch-intent.json");
  const nonce = "a".repeat(64);
  const command = `PASEO_BACKGROUND_JOB_LAUNCH=${Buffer.from(file).toString("base64url")}.${nonce} runner`;
  const intent = {
    schemaVersion: 1,
    nonce,
    command,
    jobId: `job-${"b".repeat(24)}`,
    socketPath: socket,
    serverEpoch: "1:2",
    ownerPid: 10,
    ownerToken: "10:20",
  };
  const pane = {
    startCommand: `"${command}"`,
    socket,
    serverId: "1:2:3",
    paneId: "%4",
    panePid: "30",
    dead: false,
  };
  const owner = async (pid) => ({ startToken: `boot:${pid === "10" ? "20" : "40"}`, state: "S" });
  const save = (record) => fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await save(intent);
  assert.equal(await classifyBackgroundJobLaunch(pane, owner), true);
  assert.equal(await classifyBackgroundJobLaunch({ ...pane, dead: true }, owner), false);
  assert.equal(await classifyBackgroundJobLaunch(pane, async () => undefined), false);
  const committed = { ...intent, paneId: "%4", panePid: 30, paneStartToken: "linux-proc:40" };
  await save(committed);
  assert.equal(await classifyBackgroundJobLaunch(pane, owner), true);
  assert.equal(
    await classifyBackgroundJobLaunch({ ...pane, dead: true }, async () => undefined),
    true,
  );
  assert.equal(await classifyBackgroundJobLaunch({ ...pane, paneId: "%5" }, owner), false);
  assert.equal(await classifyBackgroundJobLaunch({ ...pane, serverId: "1:9:3" }, owner), false);
  assert.equal(
    await classifyBackgroundJobLaunch({ ...pane, startCommand: `"${command}; extra"` }, owner),
    false,
  );
  assert.equal(
    await classifyBackgroundJobLaunch(pane, async () => ({ startToken: "boot:99", state: "S" })),
    false,
  );
  await fs.chmod(file, 0o644);
  assert.equal(await classifyBackgroundJobLaunch(pane, owner), false);
});

test("snapshot reader parses immutable IDs and infrastructure tags without live tmux", async (t) => {
  const f = await fixture(t);
  const socket = path.join(f.home, "snapshot-socket");
  await fs.writeFile(socket, "fake socket inode");
  const sep = "\x1f";
  let currentCommand = "node",
    jobPane = false,
    jobName = "Build the package",
    paneTitle = "pane-fallback";
  const run = async (_socket, args) => {
    if (args[0] === "display-message") return String(process.pid);
    if (args[0] === "list-sessions")
      return (
        ["$2", "user", "/same", "", ""].join(sep) +
        "\n" +
        ["$0", "stage", "/same", "1", ""].join(sep)
      );
    assert.ok(args.at(-1).includes("#{@pi_background_job_name}"));
    const jobId = jobPane ? `job-${"a".repeat(24)}` : "";
    return [
      "$2",
      "@3",
      "window",
      "%4",
      "/same",
      currentCommand,
      "",
      "",
      jobPane ? "" : "123",
      jobPane ? "" : "agent-1",
      jobPane ? "" : "abcd:1234",
      jobId,
      jobPane ? jobName : "",
      jobPane ? paneTitle : "",
      jobPane ? "123" : "",
      jobPane ? "linux-proc:1234" : "",
      "0",
      "",
    ].join(sep);
  };
  const s = await readSnapshot(socket, run, async () => ({ startToken: "abcd:1234", state: "S" }));
  assert.match(s.serverId, new RegExp(`^${process.pid}:`));
  assert.equal(s.sessions[1].infrastructure, true);
  assert.equal(s.panes[0].agent, true);
  assert.equal(projectSnapshot(s).windows[0].tmuxWindowId, "@3");
  currentCommand = "zsh";
  const returnedShell = await readSnapshot(socket, run, async () => undefined);
  assert.equal(returnedShell.panes[0].agent, false);
  assert.equal(returnedShell.panes[0].agentId, undefined);
  assert.equal(projectSnapshot(returnedShell).windows.length, 1);
  jobPane = true;
  const observedJob = await readSnapshot(socket, run, async () => ({
    startToken: "abcd:1234",
    state: "S",
  }));
  assert.equal(observedJob.panes[0].agent, false);
  assert.equal(observedJob.panes[0].backgroundJob, true);
  assert.equal(observedJob.panes[0].backgroundJobName, "Build the package");
  // Updated published metadata is reflected by the next topology snapshot.
  jobName = "Build release artifacts";
  const renamedJob = await readSnapshot(socket, run, async () => ({
    startToken: "abcd:1234",
    state: "S",
  }));
  assert.equal(renamedJob.panes[0].backgroundJobName, "Build release artifacts");
  const f2 = await fixture(t);
  await f2.topology.start();
  const observedPane = {
    ...f2.current.panes[0],
    backgroundJob: true,
    backgroundJobName: "Build the package",
  };
  f2.current.panes = [observedPane];
  await f2.topology.reconcile();
  const terminalKey = topologyId("trm", f2.current.socket, f2.current.serverId, observedPane.id);
  assert.equal(f2.terminalManager.getTerminal(terminalKey).getTitle(), "Build the package");
  f2.current.panes[0] = { ...observedPane, backgroundJobName: "Build release artifacts" };
  await f2.topology.reconcile();
  assert.equal(f2.terminalManager.getTerminal(terminalKey).getTitle(), "Build release artifacts");
  f2.current.panes[0] = { ...observedPane, backgroundJobName: "Background job" };
  await f2.topology.reconcile();
  assert.equal(f2.terminalManager.getTerminal(terminalKey).getTitle(), "Background job");
  jobName = "";
  paneTitle = `job-${"a".repeat(24)}`;
  const idTitleFallback = await readSnapshot(socket, run, async () => ({
    startToken: "abcd:1234",
    state: "S",
  }));
  assert.equal(idTitleFallback.panes[0].backgroundJobName, "Background job");
  jobPane = false;
  const fallbackName = await readSnapshot(socket, run, async () => ({
    startToken: "abcd:1234",
    state: "S",
  }));
  jobPane = true;
  assert.equal(fallbackName.panes[0].backgroundJobName, undefined);
  const reusedPid = await readSnapshot(socket, run, async () => ({
    startToken: "abcd:999",
    state: "S",
  }));
  assert.equal(reusedPid.panes[0].backgroundJob, false);
  assert.equal(reusedPid.panes[0].backgroundJobName, undefined);
});

test("socket discovery includes XDG runtime socket and deduplicates symlink aliases", async (t) => {
  const f = await fixture(t);
  const runtime = path.join(f.home, "runtime");
  const directory = path.join(runtime, `tmux-${process.getuid()}`);
  await fs.mkdir(directory, { recursive: true });
  const socket = path.join(directory, "default"),
    alias = path.join(f.home, "alias");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await fs.symlink(socket, alias);
  const env = {
    XDG_RUNTIME_DIR: runtime,
    TMUX_TMPDIR: path.join(f.home, "empty"),
    PASEO_TMUX_SOCKETS: JSON.stringify([alias]),
  };
  assert.deepEqual(await discoverSockets(env, path.join(f.home, "default-root")), [socket]);
});

test("configured tmux roots never replace the manual /tmp root", () => {
  assert.deepEqual(
    tmuxSocketRoots({ TMUX_TMPDIR: "/configured", XDG_RUNTIME_DIR: "/runtime" }, 123),
    ["/tmp/tmux-123", "/configured/tmux-123", "/runtime/tmux-123"],
  );
  assert.deepEqual(tmuxSocketRoots({ TMUX_TMPDIR: "/tmp", XDG_RUNTIME_DIR: "/tmp" }, 123), [
    "/tmp/tmux-123",
  ]);
});

test("concurrent default/configured/runtime/explicit sockets are discovered and canonical aliases deduplicated", async (t) => {
  const f = await fixture(t);
  const roots = ["manual", "configured", "runtime", "explicit"].map((name) =>
    path.join(f.home, name),
  );
  const sockets = [];
  for (const root of roots) {
    const directory = path.join(root, `tmux-${process.getuid()}`);
    await fs.mkdir(directory, { recursive: true });
    const socket = path.join(directory, "default");
    sockets.push(socket);
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
  }
  const alias = path.join(f.home, "manual-alias");
  await fs.symlink(sockets[0], alias);
  const env = {
    TMUX_TMPDIR: roots[1],
    XDG_RUNTIME_DIR: roots[2],
    PASEO_TMUX_SOCKETS: JSON.stringify([sockets[3], alias]),
    TMUX: `${sockets[2]},123,0`,
  };
  // All roots are test-owned. No live user tmux socket is queried or changed.
  assert.deepEqual(await discoverSockets(env, roots[0]), sockets.sort());
});
