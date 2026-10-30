import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const directory = join(
  process.env.PASEO_INSTALL,
  "packages/server/dist/server/server/agent/providers/pi",
);
const { createPiExtensionHost } = await import(
  pathToFileURL(join(directory, "extensions/index.js"))
);
const { PiHistoryMapper } = await import(pathToFileURL(join(directory, "history-mapper.js")));
const steps = [
  { id: "task-1", text: "Inspect", status: "completed" },
  { id: "task-2", text: "Implement", status: "in_progress" },
  { id: "task-3", text: "Approve release", status: "blocked" },
];
const producerDetails = {
  version: 5,
  steps,
  goalId: "goal-stable",
  revision: 17,
  activationId: "activation-stable",
};
const call = (details = producerDetails) => ({
  callId: "progress-1",
  toolName: "update_progress",
  args: { steps },
  status: "completed",
  result: { details },
});
const todos = (mapping) =>
  (mapping?.events ?? [])
    .filter((event) => event.type === "timeline" && event.item.type === "todo")
    .map((event) => event.item);
test("registered mapper emits native tasks, preserving blocked and completion semantics", () => {
  const host = createPiExtensionHost();
  const [todo] = todos(host.mapToolCall(call()));
  assert.ok(todo);
  assert.equal(todo.items.length, 3);
  assert.deepEqual(
    todo.items.map(({ text, status, completed }) => ({ text, status, completed })),
    [
      { text: "Inspect", status: "completed", completed: true },
      { text: "Implement", status: "in_progress", completed: false },
      { text: "Blocked · Approve release", status: "pending", completed: false },
    ],
  );
  const reversed = todos(host.mapToolCall(call({ ...producerDetails, steps: [...steps].toReversed() })))[0];
  assert.deepEqual(
    reversed.items.map((x) => x.id),
    todo.items.map((x) => x.id).toReversed(),
  );
  assert.deepEqual(todos(host.mapToolCall(call({ ...producerDetails, steps: [] })))[0].items, []);
});
test("producer v5 supports eight simultaneous active tasks with stable IDs and history replay", async () => {
  const activeSteps = Array.from({ length: 8 }, (_, index) => ({
    id: `task-${index + 1}`,
    text: `Task ${index + 1}`,
    status: "in_progress",
  }));
  const details = { ...producerDetails, steps: activeSteps };
  const host = createPiExtensionHost();
  const [live] = todos(host.mapToolCall(call(details)));
  assert.equal(live.items.length, 8);
  assert.deepEqual(
    live.items.map(({ id }) => id),
    activeSteps.map(({ id }) => `pi-progress-goal-stable-${id}`),
  );
  const events = await new PiHistoryMapper("pi").mapMessages([
    {
      role: "toolResult",
      toolCallId: "restored-eight",
      toolName: "update_progress",
      content: [{ type: "text", text: "Updated" }],
      details,
      isError: false,
    },
  ]);
  assert.deepEqual(
    events.find((event) => event.type === "timeline" && event.item.type === "todo").item,
    live,
  );
});
test("completion retains checked native rows for activity and history replay", async () => {
  const host = createPiExtensionHost();
  const complete = steps.map((step) => ({ ...step, status: "completed" }));
  const details = { ...producerDetails, steps: complete };
  const before = JSON.stringify(details);
  const completed = todos(host.mapToolCall(call(details)))[0].items;
  assert.deepEqual(
    completed.map(({ text, status, completed: isCompleted }) => ({
      text,
      status,
      completed: isCompleted,
    })),
    complete.map(({ text, status }) => ({ text, status, completed: true })),
  );
  assert.equal(JSON.stringify(details), before, "Activity source remains intact");
  for (const status of ["pending", "in_progress", "blocked"]) {
    const unfinished = [...complete.slice(0, 2), { text: "More work", status }];
    assert.equal(
      todos(host.mapToolCall(call({ version: 5, steps: unfinished })))[0].items.length,
      3,
    );
  }
  const events = await new PiHistoryMapper("pi").mapMessages([
    {
      role: "toolResult",
      toolCallId: "restored",
      toolName: "update_progress",
      content: [{ type: "text", text: "Complete" }],
      details,
      isError: false,
    },
  ]);
  assert.deepEqual(
    events.find((e) => e.type === "timeline" && e.item.type === "todo").item.items,
    completed,
    "history replay retains the same checked rows and stable identities",
  );
});
test("running, failed, other tools, malformed and unsupported snapshots stay ordinary tool calls", () => {
  const host = createPiExtensionHost();
  for (const input of [
    { ...call(), status: "running" },
    { ...call(), status: "failed" },
    { ...call(), toolName: "other" },
    call({ version: 4, steps }),
    call({ ...producerDetails, steps: [{ text: "bad", status: "invented" }] }),
    call({ ...producerDetails, unexpected: true }),
    call({ ...producerDetails, revision: "17" }),
  ])
    assert.equal(todos(host.mapToolCall(input)).length, 0);
});
test("native tasks restore from persisted Pi history and match streamed mapping", async () => {
  const mapper = new PiHistoryMapper("pi");
  const events = await mapper.mapMessages([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "progress-1", name: "update_progress", arguments: { steps } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "progress-1",
      toolName: "update_progress",
      content: [{ type: "text", text: "Updated" }],
      details: producerDetails,
      isError: false,
    },
  ]);
  const todo = events.find((e) => e.type === "timeline" && e.item.type === "todo");
  assert.ok(todo);
  assert.deepEqual(todo.item, todos(createPiExtensionHost().mapToolCall(call()))[0]);
});
