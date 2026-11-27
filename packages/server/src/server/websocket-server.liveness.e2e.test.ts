import { expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./websocket/physical-socket.js";
import type { AgentModelDefinition, FetchCatalogOptions } from "./agent/agent-sdk-types.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

const LARGE_MODEL_LABEL_BYTES = 512 * 1024;
const LARGE_MODEL_LABEL = "x".repeat(LARGE_MODEL_LABEL_BYTES);
const LARGE_MODEL_COUNT =
  Math.floor(MAX_PHYSICAL_SOCKET_BUFFERED_BYTES / LARGE_MODEL_LABEL_BYTES) + 2;
const TEST_TIMEOUT_MS = 30_000;

interface SocketClose {
  code: number;
  reason: string;
}

class ResumedPhysicalSocketSession {
  private replacement: WebSocket | null = null;

  private constructor(
    private readonly daemon: TestPaseoDaemon,
    private readonly original: WebSocket,
  ) {}

  static async launch(): Promise<ResumedPhysicalSocketSession> {
    // Pings are correlated replies to the replacement socket, not a broadcast. A forced
    // provider snapshot gives the paused legacy source an actual broadcast larger than its cap.
    const agentClients = createTestAgentClients();
    const claude = agentClients.claude!;
    const fetchCatalog = claude.fetchCatalog.bind(claude);
    const largeModels: AgentModelDefinition[] = Array.from(
      { length: LARGE_MODEL_COUNT },
      (_, index) => ({
        provider: "claude",
        id: `physical-buffer-${index}`,
        label: LARGE_MODEL_LABEL,
        isDefault: index === 0,
      }),
    );
    agentClients.claude = new Proxy(claude, {
      get(target, property, receiver) {
        if (property === "fetchCatalog") {
          return (options: FetchCatalogOptions) =>
            options.force
              ? Promise.resolve({ models: largeModels, modes: [] })
              : fetchCatalog(options);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const daemon = await createTestPaseoDaemon({ agentClients });
    const original = await connectSocket(daemon.port, "stale-physical-socket");
    return new ResumedPhysicalSocketSession(daemon, original);
  }

  async abandonOriginal(): Promise<void> {
    this.original.pause();
  }

  async resumeSameClient(): Promise<void> {
    this.replacement = await connectSocket(this.daemon.port, "stale-physical-socket", {
      explicit_event_subscriptions: true,
    });
  }

  async broadcastUntilOriginalCloses(): Promise<SocketClose> {
    const replacement = this.requireReplacement();
    const originalClose = waitForClose(this.original);
    const requestId = "large-provider-snapshot";
    const refreshResponse = waitForMessage(
      replacement,
      (message) =>
        message.type === "session" &&
        message.message.type === "refresh_providers_snapshot_response" &&
        message.message.payload.requestId === requestId,
    );

    replacement.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "refresh_providers_snapshot_request",
          requestId,
          cwd: this.daemon.staticDir,
          providers: ["claude"],
        },
      }),
    );

    await refreshResponse;
    this.original.resume();
    return originalClose;
  }

  async replacementRoundTrip(): Promise<void> {
    const replacement = this.requireReplacement();
    const requestId = "replacement-still-active";
    await sendAndWait(
      replacement,
      {
        type: "session",
        message: { type: "ping", requestId, clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === requestId,
    );
  }

  async close(): Promise<void> {
    this.original.terminate();
    this.replacement?.terminate();
    await this.daemon.close();
  }

  private requireReplacement(): WebSocket {
    if (!this.replacement) throw new Error("Replacement socket is not connected");
    return this.replacement;
  }
}

test(
  "a resumed stale socket is bounded and removed without disrupting its replacement",
  async () => {
    const session = await ResumedPhysicalSocketSession.launch();
    try {
      await session.abandonOriginal();
      await session.resumeSameClient();

      const originalClose = await session.broadcastUntilOriginalCloses();

      expect(originalClose).toEqual({ code: 1006, reason: "" });
      await session.replacementRoundTrip();
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(
  port: number,
  clientId: string,
  capabilities?: { explicit_event_subscriptions: boolean },
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(socket);
  await sendAndWait(
    socket,
    {
      type: "hello",
      clientId,
      clientType: "browser",
      protocolVersion: 1,
      ...(capabilities ? { capabilities } : {}),
    },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  await sendAndWait(socket, { type: "ping" }, (message) => message.type === "pong");
  return socket;
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = waitForMessage(socket, matches);
  socket.send(JSON.stringify(message));
  return response;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<SocketClose> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("Timed out waiting for WebSocket to close"));
    }, TEST_TIMEOUT_MS);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    };
    socket.once("close", onClose);
  });
}

function waitForMessage(
  socket: WebSocket,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData) => {
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message arrived"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}
