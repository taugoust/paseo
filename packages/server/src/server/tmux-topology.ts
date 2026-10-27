import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";

const exec = promisify(execFile);
const SEP = "\x1f";
export interface Placement {
  tmuxSocket: string;
  tmuxServerId: string;
  tmuxSessionId: string;
  tmuxWindowId: string;
  projectId: string;
  workspaceId: string;
}
export interface Session {
  id: string;
  name: string;
  cwd: string;
  infrastructure: boolean;
}
export interface Pane {
  sessionId: string;
  windowId: string;
  windowName: string;
  id: string;
  cwd: string;
  command: string;
  infrastructure: boolean;
  agent: boolean;
  agentId?: string;
  backgroundJob?: boolean;
  backgroundJobName?: string;
}
export interface Snapshot {
  socket: string;
  serverId: string;
  sessions: Session[];
  panes: Pane[];
}
type Run = (socket: string, args: string[]) => Promise<string>;
interface PendingTrust {
  token: string;
  socket: string;
  source: NonNullable<PersistedWorkspaceRecord["untrustedSource"]>;
  title: string;
  workspaceId?: string;
  published?: boolean;
}
export interface AgentPane {
  socket: string;
  serverId: string;
  pane: string;
  agentId: string;
  workspaceId: string;
}
interface Options {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  terminalManager: TerminalManager;
  paseoHome: string;
  launchDirectory?: string;
  logger: { warn: (...args: unknown[]) => void };
  sockets?: () => Promise<string[]>;
  snapshot?: (socket: string) => Promise<Snapshot>;
  run?: Run;
  proxy?: string;
  associateAgent?: (agentId: string, workspaceId: string) => Promise<void>;
  isBackgroundAgent?: (agentId: string) => Promise<boolean>;
  archiveAgent?: (agentId: string, workspaceId: string) => Promise<boolean | void>;
}
export function topologyId(kind: string, ...parts: string[]): string {
  return `${kind}_tmux_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;
}
export function tmuxCommand(
  socket: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): { command: string; args: string[] } {
  // In a C locale tmux replaces control separators in formatted output with
  // underscores. Force UTF-8 so identity snapshots retain their delimiters.
  const tmuxArgs = ["-u", "-S", socket, ...args];
  const scope = env.PASEO_TMUX_SYSTEMD_RUN;
  if (platform === "linux" && args[0] === "new-session" && scope) {
    if (!path.isAbsolute(scope))
      throw new Error("PASEO_TMUX_SYSTEMD_RUN must be an absolute executable path");
    // A first tmux server must not inherit Paseo's service cgroup: restarting
    // Paseo must not kill independent user Pi/job panes via KillMode=control-group.
    return {
      command: scope,
      args: ["--user", "--scope", "--quiet", "--collect", "--", "tmux", ...tmuxArgs],
    };
  }
  return { command: "tmux", args: tmuxArgs };
}
export async function runTmux(
  socket: string,
  args: string[],
  execute: (command: string, argv: string[]) => Promise<string> = async (command, argv) =>
    (await exec(command, argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10000 }))
      .stdout,
): Promise<string> {
  const launch = tmuxCommand(socket, args);
  // Intentionally no fallback: a failed scope launch must not start tmux inside
  // the daemon's cgroup after all.
  return (await execute(launch.command, launch.args)).trimEnd();
}
export function tmuxSocketRoots(
  env: NodeJS.ProcessEnv = process.env,
  uid: number = process.getuid!(),
  defaultTmpDir = "/tmp",
): string[] {
  const roots = new Set([path.join(defaultTmpDir, `tmux-${uid}`)]);
  if (env.TMUX_TMPDIR) roots.add(path.join(env.TMUX_TMPDIR, `tmux-${uid}`));
  if (env.XDG_RUNTIME_DIR) roots.add(path.join(env.XDG_RUNTIME_DIR, `tmux-${uid}`));
  return [...roots];
}
// The default-root override is solely a test seam; production calls retain /tmp
// in addition to configured/runtime roots, never in place of them.
export async function discoverSockets(
  env: NodeJS.ProcessEnv = process.env,
  defaultTmpDir = "/tmp",
): Promise<string[]> {
  const sockets = new Set<string>(JSON.parse(env.PASEO_TMUX_SOCKETS ?? "[]"));
  if (env.TMUX) sockets.add(env.TMUX.split(",")[0]!);
  const roots = tmuxSocketRoots(env, process.getuid!(), defaultTmpDir);
  for (const root of roots)
    for (const name of await fs.readdir(root).catch(() => [] as string[])) {
      const socket = path.join(root, name);
      if ((await fs.stat(socket).catch(() => null))?.isSocket()) sockets.add(socket);
    }
  return [
    ...new Set(
      await Promise.all([...sockets].map((s) => fs.realpath(s).catch(() => path.resolve(s)))),
    ),
  ].sort();
}
export interface PiProcessIdentity {
  startToken: string;
  state: string;
}
type ReadPiOwner = (pid: string) => Promise<PiProcessIdentity | undefined>;
export async function readPiProcessIdentity(pid: string): Promise<PiProcessIdentity | undefined> {
  let stat: string;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error; // Permission/I/O failure is not proof that an owner exited.
  }
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!fields[0] || !/^\d+$/.test(fields[19] ?? "") || !/^[a-f0-9-]+$/.test(boot))
    throw new Error("Invalid Pi process identity");
  return { startToken: `${boot}:${fields[19]}`, state: fields[0] };
}
// Share the shim's exclusive per-agent launch claim during automatic archive.
// Checking existence alone races with both launch start and claim release.
export async function claimAgentArchive(
  agentId: string,
  directory = path.join(homedir(), ".pi", "paseo-bridge", "launches"),
  readOwner: ReadPiOwner = readPiProcessIdentity,
): Promise<(() => Promise<void>) | undefined> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${createHash("sha256").update(agentId).digest("hex")}.json`);
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw readError;
    }
    const claim = JSON.parse(text);
    if (
      claim.agentId !== agentId ||
      !Number.isSafeInteger(claim.pid) ||
      claim.pid <= 0 ||
      typeof claim.processStartToken !== "string" ||
      !/^[a-f0-9-]+:\d+$/.test(claim.processStartToken) ||
      typeof claim.nonce !== "string" ||
      !claim.nonce
    )
      throw new Error("Invalid Pi launch claim; refusing automatic archive", { cause: error });
    const owner = await readOwner(String(claim.pid));
    if (
      owner &&
      owner.startToken === claim.processStartToken &&
      !["Z", "X", "x"].includes(owner.state)
    )
      return undefined;
    // A dead claim still blocks new launchers. Leave it for explicit recovery.
    return async () => {};
  }
  const nonce = randomUUID();
  try {
    const owner = await readOwner(String(process.pid));
    if (!owner) throw new Error("Cannot identify archive guard owner");
    await handle.writeFile(
      JSON.stringify({ agentId, pid: process.pid, processStartToken: owner.startToken, nonce }),
    );
  } catch (error) {
    await handle.close();
    await fs.unlink(file);
    throw error;
  }
  await handle.close();
  return async () => {
    try {
      if (JSON.parse(await fs.readFile(file, "utf8")).nonce === nonce) await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
export async function classifyPaneOwner(
  input: { command: string; pid?: string; startToken?: string; agentId?: string },
  readOwner: ReadPiOwner = readPiProcessIdentity,
): Promise<{ agent: boolean; agentId?: string }> {
  if (
    input.pid &&
    /^[1-9]\d*$/.test(input.pid) &&
    Number.isSafeInteger(Number(input.pid)) &&
    /^[a-f0-9-]+:\d+$/.test(input.startToken ?? "")
  ) {
    const owner = await readOwner(input.pid);
    if (owner && owner.startToken === input.startToken && !["Z", "X", "x"].includes(owner.state)) {
      return { agent: true, agentId: input.agentId || undefined };
    }
  }
  // An ID alone (or a reused PID) is never evidence of ownership. Recognize
  // legacy Pi foreground commands conservatively, but do not attach stale IDs.
  return { agent: /^(pi|pi-unsafe|pi-supervised)$/.test(input.command), agentId: undefined };
}
/** Presentation evidence only, never authority to signal or reap a job. */
export async function classifyBackgroundJobPane(
  input: { jobId?: string; pid?: string; startToken?: string; dead?: boolean },
  readOwner: ReadPiOwner = readPiProcessIdentity,
): Promise<boolean> {
  const token = /^linux-proc:([0-9]+)$/.exec(input.startToken ?? "");
  if (
    !/^job-[0-9a-f]{24}$/.test(input.jobId ?? "") ||
    !/^[1-9][0-9]*$/.test(input.pid ?? "") ||
    !Number.isSafeInteger(Number(input.pid)) ||
    !token
  )
    return false;
  if (input.dead) return true; // tmux's retained dead pane cannot become a different live process.
  const owner = await readOwner(input.pid!);
  return (
    !!owner && owner.startToken.endsWith(`:${token[1]}`) && !["Z", "X", "x"].includes(owner.state)
  );
}
export async function readSnapshot(
  socket: string,
  run: Run = runTmux,
  readOwner: ReadPiOwner = readPiProcessIdentity,
): Promise<Snapshot> {
  socket = await fs.realpath(socket);
  const pid = await run(socket, ["display-message", "-p", "#{pid}"]);
  if (!/^\d+$/.test(pid)) throw new Error("Invalid tmux server pid");
  const start = await fs
    .readFile(`/proc/${pid}/stat`, "utf8")
    .then((stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19])
    .catch(async () =>
      (await exec("ps", ["-p", pid, "-o", "lstart="], { encoding: "utf8" })).stdout.trim(),
    );
  if (!start) throw new Error("Unable to identify tmux server incarnation");
  const inode = (await fs.stat(socket)).ino;
  const serverId = `${pid}:${start}:${inode}`;
  const sessions = (
    await run(socket, [
      "list-sessions",
      "-F",
      [
        "#{session_id}",
        "#{session_name}",
        "#{session_path}",
        "#{@pi_infrastructure}",
        "#{@paseo_infrastructure}",
      ].join(SEP),
    ])
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const f = line.split(SEP);
      if (f.length !== 5 || !/^\$\d+$/.test(f[0]!))
        throw new Error("Invalid tmux session snapshot");
      return { id: f[0]!, name: f[1]!, cwd: f[2]!, infrastructure: f[3] === "1" || f[4] === "1" };
    });
  const ownerReads = new Map<string, Promise<PiProcessIdentity | undefined>>();
  const cachedOwner: ReadPiOwner = (ownerPid) => {
    let value = ownerReads.get(ownerPid);
    if (!value) {
      value = readOwner(ownerPid);
      ownerReads.set(ownerPid, value);
    }
    return value;
  };
  const panes = await Promise.all(
    (
      await run(socket, [
        "list-panes",
        "-a",
        "-F",
        [
          "#{session_id}",
          "#{window_id}",
          "#{window_name}",
          "#{pane_id}",
          "#{pane_current_path}",
          "#{pane_current_command}",
          "#{@pi_infrastructure}",
          "#{@paseo_infrastructure}",
          "#{@paseo_pi_agent_pid}",
          "#{@paseo_agent_id}",
          "#{@paseo_pi_agent_start_token}",
          "#{@pi_background_job_id}",
          "#{@pi_background_job_name}",
          "#{pane_title}",
          "#{pane_pid}",
          "#{@pi_background_job_start_token}",
          "#{pane_dead}",
        ].join(SEP),
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map(async (line) => {
        const f = line.split(SEP);
        if (f.length !== 17 || !/^@\d+$/.test(f[1]!) || !/^%\d+$/.test(f[3]!))
          throw new Error("Invalid tmux pane snapshot");
        const owner = await classifyPaneOwner(
          { command: f[5]!, pid: f[8], agentId: f[9], startToken: f[10] },
          cachedOwner,
        );
        const backgroundJob = await classifyBackgroundJobPane(
          { jobId: f[11], pid: f[14], startToken: f[15], dead: f[16] === "1" },
          cachedOwner,
        );
        const isJobId = (value: string | undefined) =>
          /^job-[a-f0-9]{24}$/.test(value?.trim() ?? "");
        let jobName = "Background job";
        if (f[12]?.trim() && !isJobId(f[12])) jobName = f[12].trim();
        else if (f[13]?.trim() && !isJobId(f[13])) jobName = f[13].trim();
        return Object.assign(
          {
            sessionId: f[0]!,
            windowId: f[1]!,
            windowName: f[2]!,
            id: f[3]!,
            cwd: f[4]!,
            command: f[5]!,
            infrastructure: f[6] === `1` || f[7] === `1`,
          },
          owner,
          { backgroundJob },
          backgroundJob ? { backgroundJobName: jobName } : {},
        );
      }),
  );
  // Reject restart races rather than publishing mixed-incarnation identities.
  if (pid !== (await run(socket, ["display-message", "-p", "#{pid}"])))
    throw new Error("tmux restarted during snapshot");
  return { socket, serverId, sessions, panes };
}
type ProjectedWindow = ReturnType<typeof projectSnapshot>["windows"][number];

export function projectSnapshot(snapshot: Snapshot) {
  const { socket, serverId } = snapshot;
  const sessions = snapshot.sessions
    .filter((s) => !s.infrastructure)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const owners = new Map<string, string>();
  for (const session of sessions)
    for (const pane of snapshot.panes)
      if (pane.sessionId === session.id && !pane.infrastructure && !owners.has(pane.windowId))
        owners.set(pane.windowId, session.id);
  const windows = new Map<string, Placement & { name: string; cwd: string; panes: Pane[] }>();
  for (const pane of snapshot.panes) {
    if (pane.infrastructure || owners.get(pane.windowId) !== pane.sessionId) continue;
    let window = windows.get(pane.windowId);
    if (!window) {
      window = {
        tmuxSocket: socket,
        tmuxServerId: serverId,
        tmuxSessionId: pane.sessionId,
        tmuxWindowId: pane.windowId,
        projectId: topologyId("prj", socket, serverId, pane.sessionId),
        workspaceId: topologyId("wks", socket, serverId, pane.windowId),
        name: pane.windowName,
        cwd: pane.cwd,
        panes: [],
      };
      windows.set(pane.windowId, window);
    }
    if (!window.panes.some((p) => p.id === pane.id)) window.panes.push(pane);
  }
  return { sessions, windows: [...windows.values()] };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPendingTrustSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === "change_request" &&
    typeof value.forge === "string" &&
    typeof value.number === "number" &&
    Number.isInteger(value.number) &&
    value.number > 0 &&
    typeof value.headRepository === "string"
  );
}

function validPendingTrustEntry(
  value: unknown,
  tokens: Set<string>,
  workspaceIds: Set<string>,
): value is PendingTrust {
  if (!isRecord(value)) return false;
  const { token, socket, title, workspaceId, published, source } = value;
  if (
    typeof token !== "string" ||
    !/^paseo-trust-[a-f0-9-]{36}$/.test(token) ||
    tokens.has(token) ||
    typeof socket !== "string" ||
    !path.isAbsolute(socket) ||
    typeof title !== "string" ||
    (workspaceId !== undefined &&
      (typeof workspaceId !== "string" ||
        !/^wks_tmux_[a-f0-9]{24}$/.test(workspaceId) ||
        workspaceIds.has(workspaceId))) ||
    (published !== undefined && (typeof published !== "boolean" || !workspaceId)) ||
    !validPendingTrustSource(source)
  )
    return false;
  tokens.add(token);
  if (typeof workspaceId === "string") workspaceIds.add(workspaceId);
  return true;
}

let active: TmuxTopology | undefined;
export function getTmuxTopology(): TmuxTopology | undefined {
  return active;
}
export class TmuxTopology {
  readonly placements = new Map<string, Placement>();
  private projects = new Map<string, { socket: string; serverId: string; sessionId: string }>();
  private paneTerminals = new Map<
    string,
    { socket: string; pane: string; terminalId: string; workspaceId: string }
  >();
  private paneAgents = new Map<string, AgentPane>();
  // Successful successor retirements are close receipts, not live pane ownership.
  private retiredAgents = new Map<string, AgentPane>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private originalCreate: TerminalManager["createTerminal"];
  private run: Run;
  constructor(private options: Options) {
    this.originalCreate = options.terminalManager.createTerminal.bind(options.terminalManager);
    this.run = options.run ?? runTmux;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async start() {
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(this.options.paseoHome, "tmux-topology.json"), "utf8"),
      );
      if (saved.version !== 1 || !Array.isArray(saved.placements))
        throw new Error("Invalid tmux topology index");
      for (const p of saved.placements as Placement[]) {
        this.placements.set(p.workspaceId, p);
        this.projects.set(p.projectId, {
          socket: p.tmuxSocket,
          serverId: p.tmuxServerId,
          sessionId: p.tmuxSessionId,
        });
      }
      for (const [id, record] of saved.terminals ?? []) this.paneTerminals.set(id, record);
      for (const [id, record] of saved.agents ?? []) this.paneAgents.set(id, record);
      for (const [id, record] of saved.retiredAgents ?? []) this.retiredAgents.set(id, record);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await this.reconcile();
    this.options.terminalManager.createTerminal = (input) =>
      this.placements.has(input.workspaceId)
        ? this.createTerminal(input)
        : this.originalCreate(input);
    this.timer = setInterval(() => {
      void this.reconcile().catch((err) =>
        this.options.logger.warn({ err }, "tmux topology reconciliation failed"),
      );
    }, 2000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.options.terminalManager.createTerminal = this.originalCreate;
  }
  reconcile() {
    return this.serial(async () => {
      const sockets = new Set([
        ...(await this.readPendingTrust()).map((entry) => entry.socket),
        ...(await (this.options.sockets ?? discoverSockets)()),
        ...[...this.projects.values()].map((p) => p.socket),
        ...[...this.paneAgents.values()].map((p) => p.socket),
      ]);
      for (const socket of sockets) {
        // Generic timeout/permission failures are not proof of death. Only an absent
        // socket or tmux's explicit connection-refused/no-server reply retires it.
        let snapshot: Snapshot;
        try {
          snapshot = await (this.options.snapshot ?? readSnapshot)(socket);
        } catch (err) {
          const error = err as NodeJS.ErrnoException & { stderr?: string };
          if (
            (error.code === "ENOENT" && error.path === socket) ||
            /no server running on |Connection refused|No such file or directory/.test(
              error.stderr ?? "",
            )
          ) {
            snapshot = { socket, serverId: "absent", sessions: [], panes: [] };
          } else {
            this.options.logger.warn({ err, socket }, "tmux socket import failed");
            continue;
          }
        }
        // A storage/provider callback failure is not a socket failure or deletion proof.
        try {
          await this.applySnapshot(snapshot);
        } catch (err) {
          this.options.logger.warn({ err, socket }, "tmux projection update failed");
        }
      }
      await this.persist();
    });
  }
  // Read on every publication: malformed/unreadable state must never downgrade a
  // retry to an ordinary, implicitly trusted tmux import.
  private async readPendingTrust(): Promise<PendingTrust[]> {
    let text: string;
    try {
      text = await fs.readFile(
        path.join(this.options.paseoHome, "tmux-pending-trust.json"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const saved = JSON.parse(text);
    if (saved.version !== 1 || !Array.isArray(saved.pending))
      throw new Error("Invalid pending tmux trust journal");
    const tokens = new Set<string>();
    const workspaceIds = new Set<string>();
    for (const entry of saved.pending) {
      if (!validPendingTrustEntry(entry, tokens, workspaceIds))
        throw new Error("Invalid pending tmux trust journal");
    }
    return saved.pending as PendingTrust[];
  }
  private async writePendingTrust(pending: PendingTrust[]) {
    const directory = this.options.paseoHome;
    const file = path.join(directory, "tmux-pending-trust.json");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, pending }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const dir = await fs.open(directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  private async validateAndBindPendingTrust(snapshot: Snapshot): Promise<PendingTrust[]> {
    const pending = await this.readPendingTrust();
    for (const pane of snapshot.panes) {
      if (
        pane.windowName.startsWith("paseo-trust-") &&
        !pending.some(
          (entry) =>
            entry.socket === snapshot.socket &&
            (entry.token === pane.windowName ||
              entry.workspaceId ===
                topologyId("wks", snapshot.socket, snapshot.serverId, pane.windowId)),
        )
      )
        throw new Error("Orphaned tmux trust marker; projection blocked");
    }
    // -n installs this unpredictable marker as part of allocation itself; no follow-up
    // set-option can safely close that allocation/tagging crash gap.
    for (const entry of pending.filter(
      (pendingEntry) => pendingEntry.socket === snapshot.socket && !pendingEntry.workspaceId,
    )) {
      const matches = new Set(
        snapshot.panes
          .filter((pane) => pane.windowName === entry.token)
          .map((pane) => pane.windowId),
      );
      if (matches.size !== 1)
        throw new Error("Unresolved pending tmux trust allocation; projection blocked");
      entry.workspaceId = topologyId("wks", snapshot.socket, snapshot.serverId, [...matches][0]!);
      await this.writePendingTrust(pending);
    }
    return pending;
  }

  private async projectSessions(
    snapshot: Snapshot,
    sessions: Session[],
    now: string,
  ): Promise<void> {
    const { projectRegistry } = this.options;
    for (const session of sessions) {
      const projectId = topologyId("prj", snapshot.socket, snapshot.serverId, session.id);
      this.projects.set(projectId, {
        socket: snapshot.socket,
        serverId: snapshot.serverId,
        sessionId: session.id,
      });
      const old = await projectRegistry.get(projectId);
      if (!old || old.displayName !== session.name || old.archivedAt)
        await projectRegistry.upsert({
          projectId,
          rootPath: old?.rootPath ?? session.cwd,
          kind: "non_git",
          displayName: session.name,
          projectKey: null,
          customName: null,
          customIconRevision: old?.customIconRevision ?? null,
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
          archivedAt: null,
        });
    }
  }

  private async projectWindows(
    snapshot: Snapshot,
    windows: ProjectedWindow[],
    pending: PendingTrust[],
    created:
      | { windowId: string; untrustedSource?: PersistedWorkspaceRecord["untrustedSource"] }
      | undefined,
    now: string,
  ): Promise<Set<string>> {
    const seen = new Set<string>();
    for (const window of windows)
      await this.projectWindow(snapshot, window, pending, created, now, seen);
    return seen;
  }

  private async projectWindow(
    snapshot: Snapshot,
    window: ProjectedWindow,
    pending: PendingTrust[],
    created:
      | { windowId: string; untrustedSource?: PersistedWorkspaceRecord["untrustedSource"] }
      | undefined,
    now: string,
    seen: Set<string>,
  ): Promise<void> {
    const { workspaceRegistry } = this.options;
    const { panes, name, cwd, ...placement } = window;
    this.placements.set(window.workspaceId, placement);
    const old = await workspaceRegistry.get(window.workspaceId);
    const managed = await Promise.all(
      panes.map((pane) =>
        pane.agent && pane.agentId && this.options.isBackgroundAgent
          ? this.options.isBackgroundAgent(pane.agentId)
          : Promise.resolve(false),
      ),
    );
    const background =
      managed.some(Boolean) &&
      panes.every((pane, index) => managed[index] || (!pane.agent && pane.backgroundJob === true));
    // Publish fork-PR trust metadata with the first record, before automation observers run.
    const trust = pending.find((entry) => entry.workspaceId === window.workspaceId);
    const projectWorkspace = (current: PersistedWorkspaceRecord | null) => {
      let untrustedSource = current?.untrustedSource;
      if (trust && !current) untrustedSource = trust.source;
      else if (created?.windowId === window.tmuxWindowId)
        untrustedSource = created.untrustedSource ?? current?.untrustedSource;
      return createPersistedWorkspaceRecord({
        ...current,
        background,
        ...(untrustedSource ? { untrustedSource } : {}),
        workspaceId: window.workspaceId,
        projectId: window.projectId,
        cwd: current?.cwd ?? cwd,
        kind: "directory",
        displayName: name,
        title: current?.title ?? null,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
        archivedAt: null,
      });
    };
    const projected = projectWorkspace(old);
    if (!old) await workspaceRegistry.upsert(projected);
    else if (
      old.displayName !== name ||
      old.projectId !== window.projectId ||
      old.archivedAt ||
      background !== old.background ||
      projected.untrustedSource !== old.untrustedSource
    )
      // The registry mutation queue ensures a title or trust approval written during
      // background classification wins over this projection.
      await workspaceRegistry.update(window.workspaceId, (current) => projectWorkspace(current));
    if (trust && !trust.published) {
      if (!(await workspaceRegistry.get(window.workspaceId)))
        throw new Error("Pending tmux trust was not published");
      await this.run(snapshot.socket, ["rename-window", "-t", window.tmuxWindowId, trust.title]);
      trust.published = true;
      await this.writePendingTrust(pending);
    }
    // Keep bound evidence for the live window so a lost registry entry cannot bypass the gate.
    await this.projectWindowPanes(snapshot, window, old?.cwd ?? cwd, seen);
  }

  private async projectWindowPanes(
    snapshot: Snapshot,
    window: ProjectedWindow,
    cwd: string,
    seen: Set<string>,
  ): Promise<void> {
    const { terminalManager } = this.options;
    const { panes } = window;
    const placement: Placement = {
      tmuxSocket: window.tmuxSocket,
      tmuxServerId: window.tmuxServerId,
      tmuxSessionId: window.tmuxSessionId,
      tmuxWindowId: window.tmuxWindowId,
      projectId: window.projectId,
      workspaceId: window.workspaceId,
    };
    for (const pane of panes) {
      const key = topologyId("trm", snapshot.socket, snapshot.serverId, pane.id);
      seen.add(key);
      const existing = this.paneTerminals.get(key);
      if (pane.agent) {
        if (terminalManager.getTerminal(key)) terminalManager.killTerminal(key);
        this.paneTerminals.delete(key);
        if (pane.agentId) {
          await this.options.associateAgent?.(pane.agentId, window.workspaceId);
          const agentKey = topologyId(
            "agt",
            snapshot.socket,
            snapshot.serverId,
            pane.id,
            pane.agentId,
          );
          this.retiredAgents.delete(pane.agentId);
          this.paneAgents.set(agentKey, {
            socket: snapshot.socket,
            serverId: snapshot.serverId,
            pane: pane.id,
            agentId: pane.agentId,
            workspaceId: window.workspaceId,
          });
        }
        continue;
      }
      if (existing && existing.workspaceId !== window.workspaceId) {
        terminalManager.killTerminal(existing.terminalId);
        this.paneTerminals.delete(key);
      }
      const displayName = pane.backgroundJob
        ? (pane.backgroundJobName ?? "Background job")
        : pane.id;
      if (existing && pane.backgroundJob) terminalManager.setTerminalTitle?.(key, displayName);
      if (!terminalManager.getTerminal(key))
        await this.attachPane(placement, pane.id, key, cwd, displayName);
      this.paneTerminals.set(key, {
        socket: snapshot.socket,
        pane: pane.id,
        terminalId: key,
        workspaceId: window.workspaceId,
      });
    }
  }

  private cleanupPaneTerminals(snapshot: Snapshot, seen: Set<string>): void {
    const { terminalManager } = this.options;
    for (const [key, record] of this.paneTerminals) {
      if (record.socket !== snapshot.socket || seen.has(key)) continue;
      terminalManager.killTerminal(record.terminalId);
      this.paneTerminals.delete(key);
    }
  }

  private async cleanupPaneAgents(snapshot: Snapshot): Promise<void> {
    const infrastructureSessions = new Set(
      snapshot.sessions.filter((session) => session.infrastructure).map((session) => session.id),
    );
    const protectedPanes = new Set(
      snapshot.panes
        .filter(
          (pane) => pane.agent || pane.infrastructure || infrastructureSessions.has(pane.sessionId),
        )
        .map((pane) => pane.id),
    );
    const presentAgents = new Set(
      snapshot.panes
        .filter((pane) => pane.agent)
        .map((pane) => pane.agentId)
        .filter(Boolean),
    );
    for (const [key, record] of this.paneAgents)
      if (await this.reconcilePaneAgent(record, snapshot, protectedPanes, presentAgents))
        this.paneAgents.delete(key);
  }

  private async reconcilePaneAgent(
    record: AgentPane,
    snapshot: Snapshot,
    protectedPanes: Set<string>,
    presentAgents: Set<string | undefined>,
  ): Promise<boolean> {
    if (record.socket !== snapshot.socket || record.serverId !== snapshot.serverId) return false;
    if (protectedPanes.has(record.pane)) {
      return this.retireSuperseded(record, snapshot);
    }
    if (
      !presentAgents.has(record.agentId) &&
      !(await this.archiveMissingPaneAgent(record, snapshot))
    )
      return false;
    return true;
  }

  // A missing-pane archive is still guarded by the launch claim and a fresh ownership check.
  private async archiveMissingPaneAgent(record: AgentPane, snapshot: Snapshot): Promise<boolean> {
    if (!this.options.archiveAgent) return false;
    const release = await claimAgentArchive(record.agentId, this.options.launchDirectory);
    if (!release) return false;
    try {
      const fresh = await (this.options.snapshot ?? readSnapshot)(snapshot.socket);
      if (
        fresh.serverId !== record.serverId ||
        fresh.panes.some(
          (pane) =>
            (pane.agent && pane.agentId === record.agentId) ||
            (pane.id === record.pane &&
              (pane.agent ||
                pane.infrastructure ||
                fresh.sessions.some(
                  (session) => session.id === pane.sessionId && session.infrastructure,
                ))),
        )
      )
        return false;
      // Legacy void callbacks remain supported only for this pre-existing missing-pane path.
      return (await this.options.archiveAgent(record.agentId, record.workspaceId)) !== false;
    } finally {
      await release();
    }
  }

  private async pruneRegistries(
    snapshot: Snapshot,
    sessions: Session[],
    windows: ProjectedWindow[],
    now: string,
  ): Promise<void> {
    const { projectRegistry, workspaceRegistry } = this.options;
    const workspaceIds = new Set(windows.map((window) => window.workspaceId));
    for (const [id, placement] of this.placements) {
      if (placement.tmuxSocket !== snapshot.socket || workspaceIds.has(id)) continue;
      await workspaceRegistry.archive(id, now);
      this.placements.delete(id);
    }
    const projectIds = new Set(
      sessions.map((session) => topologyId("prj", snapshot.socket, snapshot.serverId, session.id)),
    );
    for (const [id, project] of this.projects) {
      if (project.socket !== snapshot.socket || projectIds.has(id)) continue;
      await projectRegistry.archive(id, now);
      this.projects.delete(id);
    }
  }

  private async prunePendingTrust(snapshot: Snapshot, pending: PendingTrust[]): Promise<void> {
    const rawIds = new Set(
      snapshot.panes.map((pane) =>
        topologyId("wks", snapshot.socket, snapshot.serverId, pane.windowId),
      ),
    );
    const retained = pending.filter(
      (entry) =>
        entry.socket !== snapshot.socket || !entry.workspaceId || rawIds.has(entry.workspaceId),
    );
    if (retained.length !== pending.length) await this.writePendingTrust(retained);
  }

  async applySnapshot(
    snapshot: Snapshot,
    created?: { windowId: string; untrustedSource?: PersistedWorkspaceRecord["untrustedSource"] },
  ) {
    const pending = await this.validateAndBindPendingTrust(snapshot);
    const { sessions, windows } = projectSnapshot(snapshot);
    const now = new Date().toISOString();
    await this.projectSessions(snapshot, sessions, now);
    const seen = await this.projectWindows(snapshot, windows, pending, created, now);
    this.cleanupPaneTerminals(snapshot, seen);
    await this.cleanupPaneAgents(snapshot);
    await this.pruneRegistries(snapshot, sessions, windows, now);
    await this.prunePendingTrust(snapshot, pending);
  }
  // Require one known different owner in the original workspace, not merely a
  // Pi-looking command or a reused pane number. Linked-window rows are deduped.
  private successor(record: AgentPane, snapshot: Snapshot): string | undefined {
    if (
      snapshot.socket !== record.socket ||
      snapshot.serverId !== record.serverId ||
      snapshot.panes.some((p) => p.agentId === record.agentId)
    )
      return;
    const rows = snapshot.panes.filter((p) => p.id === record.pane);
    if (
      !rows.length ||
      rows.some(
        (p) =>
          !p.agent ||
          !p.agentId ||
          p.agentId === record.agentId ||
          p.infrastructure ||
          !snapshot.sessions.some((s) => s.id === p.sessionId && !s.infrastructure) ||
          topologyId("wks", snapshot.socket, snapshot.serverId, p.windowId) !== record.workspaceId,
      )
    )
      return;
    const owners = new Set(rows.map((p) => p.agentId));
    if (owners.size === 1) return rows[0]!.agentId;
  }
  private async retireSuperseded(
    record: AgentPane,
    snapshot: Snapshot,
    alreadyArchived = false,
  ): Promise<boolean> {
    const successor = this.successor(record, snapshot);
    if (
      !successor ||
      !this.options.archiveAgent ||
      [...this.paneAgents.values()].filter((p) => p.agentId === record.agentId).length > 1
    )
      return false;
    const release = await claimAgentArchive(record.agentId, this.options.launchDirectory);
    if (!release) return false;
    try {
      // Also inspect other known/discovered servers: the old owner may have
      // moved. Inspection failures are uncertainty, never absence evidence.
      const sockets = new Set([
        ...(await (this.options.sockets ?? discoverSockets)()),
        ...[...this.projects.values()].map((p) => p.socket),
        ...[...this.paneAgents.values()].map((p) => p.socket),
      ]);
      sockets.delete(record.socket);
      for (const socket of sockets) {
        const other = await (this.options.snapshot ?? readSnapshot)(socket);
        if (other.socket !== socket || other.panes.some((p) => p.agentId === record.agentId))
          return false;
      }
      const fresh = await (this.options.snapshot ?? readSnapshot)(record.socket);
      if (this.successor(record, fresh) !== successor) return false;
      // A fulfilled legacy/NOOP callback is not authoritative archive proof.
      // Missing-pane cleanup retains its legacy callback contract; successor
      // retirement requires confirmation, including persisted receipt retries.
      if ((await this.options.archiveAgent(record.agentId, record.workspaceId)) !== true) {
        throw new Error(
          "Superseded Pi owner archive was not confirmed; refusing provider cancellation",
        );
      }
      if (!alreadyArchived) this.retiredAgents.set(record.agentId, record);
      return true;
    } finally {
      await release();
    }
  }
  private attachPane(p: Placement, pane: string, id: string, cwd: string, name: string) {
    return this.originalCreate({
      id,
      cwd,
      workspaceId: p.workspaceId,
      name,
      command: this.options.proxy ?? process.env.PASEO_TMUX_PANE_PROXY ?? "paseo-tmux-pane",
      args: ["--socket", p.tmuxSocket, "--pane", pane, "--title", name],
    });
  }
  private async allocateWorkspaceWindow(
    project: { socket: string; serverId: string; sessionId: string } | undefined,
    socket: string,
    cwd: string,
    windowTitle: string | undefined,
  ): Promise<{
    project: { socket: string; serverId: string; sessionId: string };
    windowId: string;
  }> {
    if (project) {
      const windowId = (
        await this.run(project.socket, [
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_id}",
          "-t",
          `${project.sessionId}:`,
          "-c",
          cwd,
          ...(windowTitle ? ["-n", windowTitle] : []),
        ])
      ).trim();
      return { project, windowId };
    }
    await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
    const result = await this.run(socket, [
      "new-session",
      "-d",
      "-P",
      "-F",
      `#{session_id}${SEP}#{window_id}`,
      "-c",
      cwd,
      ...(windowTitle ? ["-n", windowTitle] : []),
    ]);
    const [sessionId, windowId] = result.split(SEP);
    const snapshot = await (this.options.snapshot ?? readSnapshot)(socket);
    project = { socket: snapshot.socket, serverId: snapshot.serverId, sessionId: sessionId! };
    return { project, windowId: windowId! };
  }

  async createWorkspace(
    projectId: string | undefined,
    cwd: string,
    title?: string,
    untrustedSource?: PersistedWorkspaceRecord["untrustedSource"],
  ) {
    return this.serial(async () => {
      let p = projectId ? this.projects.get(projectId) : undefined;
      if (projectId && !p) throw new Error("Unknown tmux session project; refresh projects");
      let id: string;
      const socket =
        p?.socket ??
        process.env.PASEO_TMUX_DEFAULT_SOCKET ??
        (await (this.options.sockets ?? discoverSockets)())[0] ??
        path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid!()}`, "default");
      if (p) await this.verify(p.socket, p.serverId);
      await fs.mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
      const canonicalSocket = await fs
        .realpath(socket)
        .catch(async () =>
          path.join(await fs.realpath(path.dirname(socket)), path.basename(socket)),
        );
      const pending = await this.readPendingTrust();
      if (pending.some((entry) => entry.socket === canonicalSocket && !entry.workspaceId))
        throw new Error("Unresolved pending tmux trust allocation; creation blocked");
      const marker = untrustedSource ? `paseo-trust-${randomUUID()}` : undefined;
      if (marker) {
        pending.push({
          token: marker,
          socket: canonicalSocket,
          source: untrustedSource!,
          title: title ?? path.basename(cwd),
        });
        await this.writePendingTrust(pending); // Must complete before any tmux allocation.
      }
      const allocated = await this.allocateWorkspaceWindow(p, socket, cwd, marker ?? title);
      p = allocated.project;
      id = allocated.windowId;
      // Keep the initial shell: it is a real user pane, not an idle placeholder/log viewer.
      await this.applySnapshot(await (this.options.snapshot ?? readSnapshot)(p.socket), {
        windowId: id,
        untrustedSource,
      });
      await this.persist();
      const workspace = await this.options.workspaceRegistry.get(
        topologyId("wks", p.socket, p.serverId, id),
      );
      if (!workspace) throw new Error("Created tmux window was not projected");
      return workspace;
    });
  }
  private async verify(socket: string, serverId: string) {
    const snapshot = await (this.options.snapshot ?? readSnapshot)(socket);
    if (snapshot.serverId !== serverId)
      throw new Error("Stale tmux server placement; refresh projects");
    return snapshot;
  }
  // Explicit closes are tmux operations, not recursive Paseo agent archival.
  // Reproject afterwards so linked windows surviving a session close move to
  // their remaining session rather than being archived/killed individually.
  private async reconcileClosed(before: Snapshot) {
    let after: Snapshot;
    try {
      after = await this.verify(before.socket, before.serverId);
    } catch (error) {
      const [pid, start] = before.serverId.split(":");
      const owner = pid && /^\d+$/.test(pid) ? await readPiProcessIdentity(pid) : undefined;
      if (
        !pid ||
        !/^\d+$/.test(pid) ||
        !/^\d+$/.test(start ?? "") ||
        (owner && owner.startToken.endsWith(`:${start}`) && !["Z", "X", "x"].includes(owner.state))
      )
        throw error;
      // Only verified death of the old server permits an empty snapshot. A
      // socket error alone must not retire unrelated live panes.
      after = { ...before, sessions: [], panes: [] };
    }
    await this.applySnapshot(after);
    await this.persist();
  }
  // Non-destructive probe for lifecycle handlers BEFORE provider cancellation.
  // Unknown/missing/history/general stale placements are not ghost evidence.
  // Unlike closeAgent this method can never execute a pane command.
  retireSupersededAgent(agentId: string, workspaceId?: string): Promise<boolean> {
    return this.serial(async () => {
      const candidates = [...this.paneAgents.values()].filter((p) => p.agentId === agentId);
      let record: AgentPane | undefined;
      if (candidates.length === 1) record = candidates[0];
      else if (candidates.length === 0) record = this.retiredAgents.get(agentId);
      if (!record || (workspaceId && workspaceId !== record.workspaceId)) return false;
      const snapshot = await (this.options.snapshot ?? readSnapshot)(record.socket);
      if (this.successor(record, snapshot) && !this.options.archiveAgent) {
        throw new Error(
          "Superseded Pi owner archive callback unavailable; refusing provider cancellation",
        );
      }
      if (!(await this.retireSuperseded(record, snapshot, candidates.length === 0))) return false;
      for (const [key, value] of this.paneAgents) if (value === record) this.paneAgents.delete(key);
      await this.persist();
      return true;
    });
  }
  private async retireMissingAgentPane(
    workspaceId: string | undefined,
    historyOnly: boolean,
    candidates: AgentPane[],
    receipt: AgentPane | undefined,
    snapshot: Snapshot,
  ): Promise<boolean> {
    if (candidates.length === 0 && !receipt && historyOnly) return false;
    let record: AgentPane | undefined;
    if (candidates.length === 1) record = candidates[0];
    else if (candidates.length === 0) record = receipt;
    if (
      !record ||
      (workspaceId && workspaceId !== record.workspaceId) ||
      !(await this.retireSuperseded(record, snapshot, candidates.length === 0))
    )
      return false;
    for (const [key, value] of this.paneAgents) if (value === record) this.paneAgents.delete(key);
    await this.persist();
    return true;
  }

  // true means handled (pane closed OR proven ghost metadata retired). Callers
  // must not then cancel/archive recursively through a dead provider session.
  closeAgent(agentId: string, workspaceId?: string, historyOnly = false): Promise<boolean> {
    return this.serial(async () => {
      const candidates = [...this.paneAgents.values()].filter((p) => p.agentId === agentId);
      const receipt = this.retiredAgents.get(agentId);
      const placement = workspaceId ? this.placements.get(workspaceId) : undefined;
      const servers = new Map(
        [...candidates, ...(receipt ? [receipt] : [])].map((p) => [
          JSON.stringify([p.socket, p.serverId]),
          { socket: p.socket, serverId: p.serverId },
        ]),
      );
      if (placement)
        servers.set(JSON.stringify([placement.tmuxSocket, placement.tmuxServerId]), {
          socket: placement.tmuxSocket,
          serverId: placement.tmuxServerId,
        });
      if (!servers.size) {
        // A history copy can retain a tmux workspace id without owning a pane.
        // Only that history-only record may fall through to archive; unknown
        // real tmux workspaces remain fail-closed and request a refresh.
        if (workspaceId?.startsWith("wks_tmux_") && !historyOnly) {
          throw new Error("Unknown tmux workspace; refresh before closing the Pi tab");
        }
        return false;
      }
      if (servers.size !== 1)
        throw new Error("Ambiguous tmux agent placement; refresh before closing the Pi tab");
      const p = [...servers.values()][0]!;
      const snapshot = await this.verify(p.socket, p.serverId);
      const panes = new Set(
        snapshot.panes
          .filter((pane) => pane.agent && pane.agentId === agentId)
          .map((pane) => pane.id),
      );
      // Only an unactivated history snapshot with no recorded or live pane
      // owner may use ordinary archival. Never bypass stale-owner protection.
      if (
        panes.size === 0 &&
        (await this.retireMissingAgentPane(workspaceId, historyOnly, candidates, receipt, snapshot))
      )
        return true;
      if (panes.size === 0 && candidates.length === 0 && !receipt && historyOnly) return false;
      if (panes.size !== 1)
        throw new Error("Pi pane ownership changed or is unavailable; refresh before closing");
      await this.applySnapshot(snapshot);
      await this.run(p.socket, ["kill-pane", "-t", [...panes][0]!]);
      await this.reconcileClosed(snapshot);
      return true;
    });
  }
  closeWorkspace(workspaceId: string): Promise<boolean> {
    if (!workspaceId.startsWith("wks_tmux_")) return Promise.resolve(false);
    return this.serial(async () => {
      const p = this.placements.get(workspaceId);
      if (!p) throw new Error("Unknown tmux workspace; refresh before closing");
      const snapshot = await this.verify(p.tmuxSocket, p.tmuxServerId);
      if (!snapshot.panes.some((pane) => pane.windowId === p.tmuxWindowId))
        throw new Error("Tmux window no longer exists");
      await this.applySnapshot(snapshot);
      await this.run(p.tmuxSocket, ["kill-window", "-t", p.tmuxWindowId]);
      await this.reconcileClosed(snapshot);
      return true;
    });
  }
  closeProject(projectId: string): Promise<boolean> {
    if (!projectId.startsWith("prj_tmux_")) return Promise.resolve(false);
    return this.serial(async () => {
      const p = this.projects.get(projectId);
      if (!p) throw new Error("Unknown tmux project; refresh before closing");
      const snapshot = await this.verify(p.socket, p.serverId);
      if (!snapshot.sessions.some((session) => session.id === p.sessionId))
        throw new Error("Tmux session no longer exists");
      await this.applySnapshot(snapshot);
      await this.run(p.socket, ["kill-session", "-t", p.sessionId]);
      await this.reconcileClosed(snapshot);
      return true;
    });
  }
  private createTerminal(input: Parameters<TerminalManager["createTerminal"]>[0]) {
    return this.serial(async () => {
      const p = this.placements.get(input.workspaceId);
      if (!p) throw new Error("Unknown tmux workspace");
      await this.verify(p.tmuxSocket, p.tmuxServerId);
      const args = [
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        p.tmuxWindowId,
        "-c",
        input.cwd,
      ];
      // tmux accepts an argv command after --; do not interpolate a shell command.
      for (const [key, value] of Object.entries(input.env ?? {}))
        args.push("-e", `${key}=${value}`);
      if (input.command)
        args.push(
          "--",
          [input.command, ...(input.args ?? [])]
            .map((s) => `'${s.replaceAll("'", "'\\''")}'`)
            .join(" "),
        );
      const pane = (await this.run(p.tmuxSocket, args)).trim();
      await this.run(p.tmuxSocket, ["select-layout", "-t", p.tmuxWindowId, "tiled"]).catch((err) =>
        this.options.logger.warn(
          { err, windowId: p.tmuxWindowId },
          "Could not tile new terminal pane",
        ),
      );
      const id = topologyId("trm", p.tmuxSocket, p.tmuxServerId, pane);
      try {
        const terminal = await this.attachPane(
          p,
          pane,
          id,
          (await this.options.workspaceRegistry.get(p.workspaceId))!.cwd,
          input.name ?? pane,
        );
        this.paneTerminals.set(id, {
          socket: p.tmuxSocket,
          pane,
          terminalId: id,
          workspaceId: p.workspaceId,
        });
        await this.persist();
        return terminal;
      } catch (error) {
        await this.run(p.tmuxSocket, ["kill-pane", "-t", pane]).catch(() => {});
        throw error;
      }
    });
  }
  // Only the explicit UI/CLI close request calls this. Reconciliation and daemon
  // shutdown call the unmodified terminalManager.killTerminal (proxy detach only).
  closeTerminal(terminalId: string): Promise<boolean> {
    return this.serial(async () => {
      const record = this.paneTerminals.get(terminalId);
      if (!record) return false;
      const placement = this.placements.get(record.workspaceId);
      if (!placement) throw new Error("Stale tmux terminal placement");
      await this.verify(record.socket, placement.tmuxServerId);
      await this.run(record.socket, ["kill-pane", "-t", record.pane]);
      this.paneTerminals.delete(terminalId);
      await this.persist();
      return true;
    });
  }
  async agentEnv(
    workspaceId: string | undefined,
    agentId: string,
  ): Promise<Record<string, string>> {
    const p = workspaceId ? this.placements.get(workspaceId) : undefined;
    if (!p) throw new Error("Pi agent requires an explicit tmux workspace");
    await this.verify(p.tmuxSocket, p.tmuxServerId);
    return {
      PI_PASEO_TMUX_TARGET: JSON.stringify({ version: 1, ...p }),
      PASEO_TMUX_SOCKET: p.tmuxSocket,
      PASEO_TMUX_SERVER_ID: p.tmuxServerId,
      PASEO_TMUX_SESSION_ID: p.tmuxSessionId,
      PASEO_TMUX_WINDOW_ID: p.tmuxWindowId,
      PASEO_PROJECT_ID: p.projectId,
      PASEO_WORKSPACE_ID: p.workspaceId,
      PASEO_AGENT_ID: agentId,
    };
  }
  private async persist() {
    const file = path.join(this.options.paseoHome, "tmux-topology.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      `${file}.tmp`,
      JSON.stringify({
        version: 1,
        placements: [...this.placements.values()],
        terminals: [...this.paneTerminals],
        agents: [...this.paneAgents],
        retiredAgents: [...this.retiredAgents],
      }),
      { mode: 0o600 },
    );
    await fs.rename(`${file}.tmp`, file);
  }
}
export async function startTmuxTopology(options: Options): Promise<TmuxTopology | undefined> {
  if (process.platform !== "linux" || process.env.PASEO_TMUX_TOPOLOGY !== "1") return undefined;
  active = new TmuxTopology(options);
  await active.start();
  return active;
}
