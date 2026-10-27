import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
const modulePath = process.argv[2];
if (!modulePath) throw new Error("Pass the compiled native-subagent-links.js path");
const { createNativeSubagentMapper, NATIVE_SUBAGENTS_PREFIX } = await import(
  pathToFileURL(modulePath)
);
const binding = (overrides = {}) => ({
  id: "binding-1",
  taskId: `subagent-task-${"a".repeat(24)}`,
  childId: `subagent-child-${"b".repeat(24)}`,
  attempt: 1,
  runtimeId: "owned",
  status: "running",
  agent: "worker",
  ...overrides,
});
const message = (bindings) => NATIVE_SUBAGENTS_PREFIX + JSON.stringify({ version: 1, bindings });

test("legacy live/history/reconnect snapshots only hide: no registration or file readers", () => {
  const files = new Set();
  const map = createNativeSubagentMapper(files);
  for (const status of ["running", "completed", "failed", "cancelled", "lost"]) {
    for (const sessionFile of [undefined, "/private/retained-session.jsonl"]) {
      const snapshot = message([binding({ status, ...(sessionFile ? { sessionFile } : {}) })]);
      for (let reconnect = 0; reconnect < 2; reconnect++) {
        assert.deepEqual(map(snapshot), { subagents: [{ type: "hide", id: "binding-1" }] });
      }
    }
  }
  assert.equal(files.size, 0);
});

test("strict private payload validation retained", () => {
  const map = createNativeSubagentMapper();
  assert.equal(map("unrelated provider notification"), undefined);
  for (const invalid of [
    NATIVE_SUBAGENTS_PREFIX + "{",
    NATIVE_SUBAGENTS_PREFIX + " ".repeat(64 * 1024),
    message([binding({ taskId: "foreign" })]),
    message([binding({ task: "unsafe\u001btext" })]),
    message([binding({ sessionFile: "relative/path" })]),
    message([binding({ status: "unknown" })]),
    message([binding({ extra: true })]),
    message([binding(), binding()]),
  ])
    assert.deepEqual(map(invalid), { subagents: [] });
});
