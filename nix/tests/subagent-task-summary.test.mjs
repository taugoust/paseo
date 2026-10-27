import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const root = process.env.PASEO_INSTALL;
if (!root) throw new Error("Set PASEO_INSTALL to the compiled Paseo tree");
const { subagentTaskOverviewText, summarizeSubagentTasks } = await import(
  pathToFileURL(join(root, "packages/protocol/dist/generic-tool-presentation.js"))
);

test("latest attempts group by session and task, never the shared title", () => {
  const tasks = [
    { title: "Review", parentSessionId: "p", taskId: "a", attempt: 1, execution: "failed" },
    {
      title: "Review",
      parentSessionId: "p",
      taskId: "a",
      attempt: 2,
      execution: "completed",
      outcome: "delivered",
    },
    { title: "Review", parentSessionId: "p", taskId: "b", attempt: 1, execution: "running" },
    { title: "Review", parentSessionId: "q", taskId: "a", attempt: 3, execution: "lost" },
  ];
  const original = structuredClone(tasks);
  assert.equal(
    subagentTaskOverviewText(tasks),
    "Running\n• Review · Running\n\nNeeds attention\n• Review · Lost\n\nFinished\n• Review · Reported complete",
  );
  assert.deepEqual(tasks, original);
});

test("execution failures stay visible and only explicit verification establishes complete", () => {
  assert.deepEqual(
    summarizeSubagentTasks([
      { title: "partial", execution: "completed", outcome: "partial" },
      { title: "verified", execution: "completed", outcome: "delivered", verified: true },
      { title: "unknown", execution: "completed" },
      { title: "failed", execution: "failed", outcome: "delivered", verified: true },
      { title: "blocked", execution: "completed", outcome: "blocked" },
      { title: "cancelled", execution: "cancelled" },
    ]).map((row) => row.status),
    ["Needs follow-up", "Complete", "Finished — outcome unknown", "Failed", "Blocked", "Cancelled"],
  );
});

test("missing session or malformed attempt cannot merge legacy records", () => {
  assert.equal(
    summarizeSubagentTasks([
      { title: "same", taskId: "a", attempt: 1 },
      { title: "same", taskId: "a", attempt: 2 },
      { title: "same", taskId: "b", parentSessionId: "p", attempt: NaN },
      { title: "same", taskId: "b", parentSessionId: "p", attempt: 2 },
    ]).length,
    4,
  );
  assert.equal(subagentTaskOverviewText([]), "");
});
