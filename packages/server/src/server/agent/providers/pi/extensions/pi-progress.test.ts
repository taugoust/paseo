import { describe, expect, test } from "vitest";
import { PiHistoryMapper } from "../history-mapper.js";
import { createPiExtensionHost } from "./index.js";

const steps = Array.from({ length: 8 }, (_, index) => ({
  id: `task-${index + 1}`,
  text: `Task ${index + 1}`,
  status: "in_progress" as const,
}));

// Shape emitted by pi-agent-extensions/progress/progress-widget.ts (v5).
const producerDetails = {
  version: 5,
  steps,
  goalId: "goal-stable",
  revision: 17,
  activationId: "activation-stable",
};

function toolCall(
  details: unknown,
  overrides: { status?: "running" | "completed" | "failed" } = {},
) {
  return {
    callId: "progress-call",
    toolName: "update_progress",
    args: {},
    status: "completed" as const,
    result: { details },
    ...overrides,
  };
}

function mappedTodos(mapping: ReturnType<ReturnType<typeof createPiExtensionHost>["mapToolCall"]>) {
  return (
    mapping?.events
      .filter((event) => event.type === "timeline" && event.item.type === "todo")
      .map((event) =>
        event.type === "timeline" && event.item.type === "todo" ? event.item : null,
      ) ?? []
  );
}

describe("Pi progress adapter", () => {
  test("maps producer v5 metadata and eight simultaneous active tasks with stable identities", () => {
    const mapping = createPiExtensionHost().mapToolCall(toolCall(producerDetails));
    const [todo] = mappedTodos(mapping);
    expect(todo?.items).toHaveLength(8);
    expect(todo?.items.map((item) => item.id)).toEqual(
      steps.map((step) => `pi-progress-goal-stable-${step.id}`),
    );
    expect(todo?.items.map((item) => item.status)).toEqual(Array(8).fill("in_progress"));

    const reversed = createPiExtensionHost().mapToolCall(
      toolCall({ ...producerDetails, steps: [...steps].reverse() }),
    );
    expect(mappedTodos(reversed)[0]?.items.map((item) => item.id)).toEqual(
      todo?.items.map((item) => item.id).reverse(),
    );
  });

  test("preserves blocked and completed meaning, explicit empty snapshots, and historical projection", async () => {
    const snapshot = {
      ...producerDetails,
      steps: [
        { id: "done", text: "Finished", status: "completed" },
        { id: "blocked", text: "Waiting", status: "blocked" },
      ],
    };
    const host = createPiExtensionHost();
    const [todo] = mappedTodos(host.mapToolCall(toolCall(snapshot)));
    expect(todo?.items).toEqual([
      { id: "pi-progress-goal-stable-done", text: "Finished", status: "completed", completed: true },
      { id: "pi-progress-goal-stable-blocked", text: "Blocked · Waiting", status: "pending", completed: false },
    ]);
    expect(mappedTodos(host.mapToolCall(toolCall({ ...producerDetails, steps: [] })))[0]?.items).toEqual([]);

    const history = await new PiHistoryMapper("pi").mapMessages([
      {
        role: "toolResult",
        toolCallId: "progress-call",
        toolName: "update_progress",
        content: [{ type: "text", text: "Updated" }],
        details: snapshot,
        isError: false,
      },
    ]);
    expect(history.find((event) => event.type === "timeline" && event.item.type === "todo")).toEqual({
      type: "timeline",
      provider: "pi",
      item: todo,
    });
  });

  test("rejects failed, malformed, and unknown-field results", () => {
    const host = createPiExtensionHost();
    for (const input of [
      toolCall(producerDetails, { status: "failed" }),
      toolCall({ ...producerDetails, revision: "17" }),
      toolCall({ ...producerDetails, activationId: "" }),
      toolCall({ ...producerDetails, unexpected: true }),
      toolCall({ ...producerDetails, steps: [{ id: "bad", text: "bad", status: "invented" }] }),
    ]) {
      expect(mappedTodos(host.mapToolCall(input))).toEqual([]);
    }
  });
});
