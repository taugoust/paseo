// Exercise the shipped server attention broadcaster, without providers or sockets.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const root = path.join(process.env.PASEO_INSTALL, "packages/server/dist/server/server");
const { VoiceAssistantWebSocketServer: Server } = await import(
  pathToFileURL(path.join(root, "websocket-server.js"))
);
const { Session } = await import(pathToFileURL(path.join(root, "session.js")));
const { WorkspaceDirectory } = await import(
  pathToFileURL(path.join(root, "workspace-directory.js"))
);
const { createAgentUpdatesService } = await import(
  pathToFileURL(path.join(root, "session/agent-updates/agent-updates-service.js"))
);
const { isManagedPiChild } = await import(
  pathToFileURL(path.join(root, "pi-child-notifications.js"))
);

async function fixture(t, patch = {}) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "paseo-notification-test-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  const sessionFile = path.join(home, "session.jsonl");
  const agent = {
    id: "agent-child",
    provider: "pi",
    workspaceId: "workspace",
    pendingPermissions: new Map(),
    persistence: { nativeHandle: sessionFile },
    labels: {},
  };
  const record = {
    schemaVersion: 2,
    agentId: agent.id,
    sessionFile,
    managed: true,
    runtimeId: "runtime",
    childId: "child",
    parentSessionId: "parent-session",
    ...patch,
  };
  const directory = path.join(home, ".pi/paseo-bridge/runtimes");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(
    directory,
    createHash("sha256").update(sessionFile).digest("hex") + ".json",
  );
  await fs.writeFile(file, JSON.stringify(record));
  return { agent, file };
}
function broadcaster(agent, present, selective, modern) {
  const server = Object.create(Server.prototype),
    pushes = [],
    messages = [];
  const session = {
    publishToSource: (_ws, message) => messages.push({ type: "session", message }),
    delivery: { isModern: () => modern },
    wantsSourceEvent: () => true,
    wantsSourceNotification: () => true,
    subscribesToAgent: async () => true,
    supportsForSource: () => selective,
    getClientActivity: () =>
      present
        ? {
            appVisible: true,
            focusedAgentId: "different",
            focusedTerminalId: null,
            lastActivityAt: new Date(),
          }
        : null,
  };
  Object.assign(server, {
    agentManager: { getAgent: () => agent, getLastAssistantMessage: async () => "Done" },
    sessions: new Map([[{}, { session }]]),
    serverId: "server",
    pushNotificationSender: {
      send: async (payload) => {
        pushes.push(payload);
      },
    },
    logger: { warn() {} },
    sendToClient: (_ws, message) => messages.push(message),
  });
  return { server, pushes, messages };
}
for (const managed of [false, true])
  for (const present of [false, true])
    for (const selective of [false, true])
      for (const modern of [false, true]) {
        test(`${managed ? "child" : "parent"} ${present ? "web" : "push"} selective=${selective} modern=${modern}`, async (t) => {
          const { agent } = await fixture(t, { managed });
          const before = structuredClone(agent);
          for (const reason of ["finished", "error", "permission"]) {
            const f = broadcaster(agent, present, selective, modern);
            await f.server.broadcastAgentAttention({ agentId: agent.id, provider: "pi", reason });
            assert.equal(
              f.messages.length,
              1,
              "child remains subscribed and receives attention state",
            );
            const message = f.messages[0].message;
            assert.equal(
              message.type,
              modern || selective ? "agent_attention_required" : "agent_stream",
            );
            const attention = modern || selective ? message.payload : message.payload.event;
            assert.equal(attention.reason, reason);
            assert.equal(attention.shouldNotify, !managed && present);
            assert.equal(f.pushes.length, !managed && !present && reason !== "error" ? 1 : 0);
          }
          assert.deepEqual(agent, before, "no visibility, status, labels, or history mutation");
        });
      }
for (const patch of [
  { agentId: "other" },
  { sessionFile: "/other/session" },
  { managed: false },
  { parentSessionId: null },
  { runtimeId: "" },
  { childId: null },
  { schemaVersion: 1 },
]) {
  test(`unproven identity does not mute: ${JSON.stringify(patch)}`, async (t) => {
    const { agent } = await fixture(t, patch);
    assert.equal(await isManagedPiChild(agent), false);
  });
}
test("missing/corrupt record and other providers do not mute; no cwd/title heuristic", async (t) => {
  const { agent, file } = await fixture(t);
  assert.equal(await isManagedPiChild({ ...agent, provider: "claude" }), false);
  assert.equal(await isManagedPiChild({ ...agent, persistence: null }), false);
  await fs.writeFile(file, "{");
  assert.equal(await isManagedPiChild(agent), false);
  await fs.unlink(file);
  assert.equal(await isManagedPiChild({ ...agent, title: "subagent-child", cwd: "/same" }), false);
});

function attentionSnapshot(sessionFile, overrides = {}) {
  return {
    id: "agent-child",
    provider: "pi",
    workspaceId: "workspace",
    cwd: "/repo",
    status: "idle",
    updatedAt: "2025-01-01T00:00:00.000Z",
    pendingPermissions: [],
    persistence: { nativeHandle: sessionFile },
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: "2025-01-01T00:00:00.000Z",
    archivedAt: null,
    labels: {},
    ...overrides,
  };
}

test("live agent snapshot projection clears badge attention only for exact managed child", async (t) => {
  const { agent } = await fixture(t);
  const session = Object.create(Session.prototype);
  session.agentStorage = { get: async () => null };
  const child = attentionSnapshot(agent.persistence.nativeHandle);
  const parent = attentionSnapshot(agent.persistence.nativeHandle, { id: "agent-parent" });
  const projectedChild = await session.enrichAgentPayload(child);
  const projectedParent = await session.enrichAgentPayload(parent);
  assert.equal(projectedChild.requiresAttention, false);
  assert.equal(projectedChild.attentionReason, null);
  assert.equal(projectedChild.attentionTimestamp, null);
  assert.equal(
    projectedParent.requiresAttention,
    true,
    "identity mismatch fails open for ordinary parent",
  );
  assert.equal(projectedParent.attentionReason, "finished");
});

test("persisted agent list projection removes stale child badge without mutating stored record", async (t) => {
  const { agent } = await fixture(t);
  const session = Object.create(Session.prototype);
  const record = { id: agent.id, provider: "pi", internal: false, archivedAt: null };
  const payload = attentionSnapshot(agent.persistence.nativeHandle);
  session.agentDirectory = { list: async () => [payload] };
  session.agentManager = { listAgents: () => [] };
  session.agentStorage = { list: async () => [record] };
  session.providerSnapshotManager = { listRegisteredProviderIds: () => new Set(["pi"]) };
  session.isProviderVisibleToClient = () => true;
  session.buildStoredAgentPayload = () => ({ ...payload });
  const [listed] = await session.listAgentPayloads({ includeUnavailablePersisted: true });
  assert.equal(listed.requiresAttention, false);
  assert.equal(listed.attentionReason, null);
  assert.equal(
    payload.requiresAttention,
    true,
    "projection leaves authoritative payload/record untouched",
  );
  assert.deepEqual(record, { id: agent.id, provider: "pi", internal: false, archivedAt: null });

  const project = {
    projectKey: "project",
    projectName: "project",
    workspaceName: "main",
    checkout: {
      cwd: "/repo",
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  };
  const workspace = {
    workspaceId: "workspace",
    projectId: "project",
    cwd: "/repo",
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    archivedAt: null,
  };
  const directory = new WorkspaceDirectory({
    logger: { error() {} },
    projectRegistry: {
      list: async () => [
        {
          projectId: "project",
          rootPath: "/repo",
          kind: "git",
          displayName: "project",
          customName: null,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
          archivedAt: null,
        },
      ],
    },
    workspaceRegistry: { list: async () => [workspace] },
    listAgentPayloads: async () => [listed],
    listProviderSubagentActivity: async () => [],
    listTerminalActivityContributions: async () => [],
    isProviderVisibleToClient: () => true,
    buildWorkspaceDescriptor: async () => ({
      id: "workspace",
      projectId: "project",
      projectDisplayName: "project",
      projectCustomName: null,
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      archivingAt: null,
      status: "done",
      activityAt: null,
      diffStat: null,
      scripts: [],
      gitRuntime: null,
      githubRuntime: null,
    }),
  });
  const descriptors = await directory.buildDescriptorMap({ includeGitData: false });
  assert.equal(
    descriptors.get("workspace").status,
    "done",
    "stale finished child does not contribute workspace attention",
  );

  const emitted = [];
  const updates = createAgentUpdatesService({
    emit: (message) => emitted.push(message),
    enrichAgentPayload: async (value) => value,
    buildStoredAgentPayload: () => ({ ...payload }),
    isProviderVisibleToClient: () => true,
    buildProjectPlacementForWorkspaceId: async () => project,
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    sequenceAgentUpdate: (value) => value,
    logger: { error() {} },
  });
  updates.beginSubscription({ subscriptionId: "badge-test" });
  updates.flushBootstrapped("badge-test");
  const updatePayload = await updates.emitStoredRecord(record);
  assert.equal(updatePayload.requiresAttention, false);
  assert.equal(emitted.at(-1).type, "agent_update");
  assert.equal(
    emitted.at(-1).payload.agent.requiresAttention,
    false,
    "persisted single-agent updates use the same safe projection",
  );
});

test("native child classification requires Pi and complete exact runtime identity", async (t) => {
  const { agent } = await fixture(t);
  assert.equal(await isManagedPiChild(agent), true);
  assert.equal(await isManagedPiChild({ ...agent, provider: "pi-native" }), false);
  assert.equal(
    await isManagedPiChild({ ...agent, persistence: { nativeHandle: "relative/session" } }),
    false,
  );
});
