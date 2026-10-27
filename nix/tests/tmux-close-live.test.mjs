// Real tmux, isolated socket and dummy processes only. Never touches user panes.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
const exec = promisify(execFile);
const server = path.join(process.env.PASEO_INSTALL, "packages/server/dist/server/server");
const schema = pathToFileURL(path.join(server, "workspace-registry.js")).href;
const source = (
  await fs.readFile(new URL("./tmux-topology.ts", import.meta.url), "utf8")
).replaceAll('from "./workspace-registry.js";', `from "${schema}";`);
const { TmuxTopology, readPiProcessIdentity, readSnapshot } = await import(
  process.env.PASEO_TOPOLOGY_COMPILED === "1"
    ? pathToFileURL(path.join(server, "tmux-topology.js")).href
    : `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "transform" })).toString("base64")}`
);

test(
  "explicit pane/window/session closes preserve tmux scope, links, and last-server cleanup",
  { skip: process.platform !== "linux", timeout: 30000 },
  async () => {
    // C-locale tmux must not lose snapshot delimiters or Pi pane ownership.
    const previousLocale = process.env.LC_ALL;
    process.env.LC_ALL = "C";
    const home = await fs.mkdtemp(path.join(tmpdir(), "paseo-close-live-"));
    const socket = path.join(home, "tmux.sock");
    const tmux = async (...args) =>
      (await exec("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout.trim();
    const idle = [process.execPath, "-e", "setInterval(()=>{},1000)"];
    const registry = () => {
      const records = new Map();
      return {
        get: async (id) => records.get(id),
        list: async () => [...records.values()],
        upsert: async (r) => records.set(r.workspaceId ?? r.projectId, r),
        update: async (id, fn) => {
          const record = fn(records.get(id) ?? null);
          records.set(id, record);
          return record;
        },
        archive: async (id, archivedAt) => {
          const r = records.get(id);
          if (r) records.set(id, { ...r, archivedAt });
        },
      };
    };
    const projects = registry(),
      workspaces = registry(),
      terminals = new Map(),
      archived = [],
      warnings = [];
    const topology = new TmuxTopology({
      paseoHome: home,
      launchDirectory: path.join(home, "launches"),
      projectRegistry: projects,
      workspaceRegistry: workspaces,
      terminalManager: {
        createTerminal: async (input) => {
          terminals.set(input.id, input);
          return input;
        },
        getTerminal: (id) => terminals.get(id),
        killTerminal: (id) => terminals.delete(id),
      },
      logger: {
        warn({ err }) {
          warnings.push(String(err));
        },
      },
      sockets: async () => [socket],
      archiveAgent: async (id) => {
        archived.push(id);
      },
    });
    try {
      const [pane, pid] = (
        await tmux(
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{pane_id} #{pane_pid}",
          "-s",
          "first",
          ...idle,
        )
      ).split(" ");
      const window = await tmux(
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        "first:",
        ...idle,
      );
      const otherWindow = await tmux(
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-s",
        "second",
        ...idle,
      );
      await tmux("link-window", "-s", window, "-t", "second:");
      await tmux("set-option", "-p", "-t", pane, "@paseo_agent_id", "pi-close-probe");
      await tmux("set-option", "-p", "-t", pane, "@paseo_pi_agent_pid", pid);
      const identity = await readPiProcessIdentity(pid);
      await tmux(
        "set-option",
        "-p",
        "-t",
        pane,
        "@paseo_pi_agent_start_token",
        identity.startToken,
      );
      const observed = await readSnapshot(socket);
      assert.ok(
        observed.panes.some((p) => p.agentId === "pi-close-probe"),
        "C-locale snapshot lost the verified Pi owner",
      );
      await topology.start();
      assert.ok(topology.placements.size > 0, warnings.join("\n"));
      assert.equal(await topology.closeAgent("pi-close-probe"), true, warnings.join("\n"));
      assert.deepEqual(archived, ["pi-close-probe"]);
      assert.ok(!(await tmux("list-panes", "-a", "-F", "#{pane_id}")).split("\n").includes(pane));
      const target = [...topology.placements.values()].find((p) => p.tmuxWindowId === window);
      assert.equal(await topology.closeWorkspace(target.workspaceId), true);
      assert.ok(
        !(await tmux("list-windows", "-a", "-F", "#{window_id}")).split("\n").includes(window),
      );
      assert.ok((await tmux("list-windows", "-a", "-F", "#{window_id}")).includes(otherWindow));
      const second = [...topology.placements.values()].find((p) => p.tmuxWindowId === otherWindow);
      await tmux("new-session", "-d", "-s", "third", ...idle);
      await tmux("link-window", "-s", otherWindow, "-t", "third:");
      await topology.reconcile();
      assert.equal(await topology.closeProject(second.projectId), true);
      const surviving = await workspaces.get(second.workspaceId);
      assert.equal(surviving.archivedAt, null);
      assert.notEqual(surviving.projectId, second.projectId);
      assert.ok((await tmux("list-windows", "-a", "-F", "#{window_id}")).includes(otherWindow));
      assert.equal(await topology.closeProject(surviving.projectId), true);
      assert.equal(topology.placements.size, 0);
      await assert.rejects(tmux("list-sessions"));
    } finally {
      topology.stop();
      await tmux("kill-server").catch(() => {});
      await fs.rm(home, { recursive: true, force: true });
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
  },
);
