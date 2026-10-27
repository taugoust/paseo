import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const mapper = await import(pathToFileURL(process.argv[2]).href);
const task = mapper.parseToolArgs("subagent", { task: "Close timing", agent: "Astra" });
const result = (state) =>
  mapper.parseToolResult({
    content: [{ type: "text", text: "Readable report" }],
    details: { task_outcome: { state, reported: true }, attempt: 2, exitCode: 0 },
  });
assert.match(
  mapper.mapToolDetail(task, result("partial")).description,
  /Needs continuation · attempt 2/,
);
assert.match(mapper.mapToolDetail(task, result("blocked")).description, /Blocked/);
assert.match(mapper.mapToolDetail(task, result("delivered")).description, /Reported delivered/);
const unreported = mapper.parseToolResult({
  content: [{ type: "text", text: "Response" }],
  details: { task_outcome: { state: "delivered", reported: false } },
});
assert.doesNotMatch(mapper.mapToolDetail(task, unreported).description, /Reported delivered/);
const backgroundStart = mapper.parseToolArgs("background_job", {
  action: "start",
  command: "printf ok",
});
assert.equal(
  mapper.mapToolDetail(
    backgroundStart,
    mapper.parseToolResult({ content: [{ type: "text", text: "started" }] }),
  ).label,
  "start",
);
const job = mapper.parseToolArgs("background_job", { action: "events", watch_id: "watch-test" });
const view = mapper.mapToolDetail(
  job,
  mapper.parseToolResult({
    content: [{ type: "text", text: "Stage changed" }],
    details: { events: [{ kind: "match" }] },
  }),
);
assert.equal(view.type, "plain_text");
assert.equal(view.text, "Stage changed");
assert.equal(view.label, "Build alerts");
const background = mapper.parseToolArgs("subagent", {
  background: true,
  tasks: [{ task: "one" }, { task: "two" }],
});
assert.match(
  mapper.mapToolDetail(
    background,
    mapper.parseToolResult({
      content: [{ type: "text", text: "Started" }],
      details: { background_subagent: true, operation: "start", status: "running" },
    }),
  ).description,
  /Started in background.*2 background tasks/,
);
const pane = mapper.parseToolArgs("background_job", { action: "adopt", pane_id: "%329" });
assert.equal(
  mapper.mapToolDetail(
    pane,
    mapper.parseToolResult({ content: [{ type: "text", text: "Linked existing pane" }] }),
  ).label,
  "Manage existing tmux pane",
);
const resumed = mapper.parseToolArgs("subagent", { operation: "resume", task_id: "task" });
assert.match(
  mapper.mapToolDetail(
    resumed,
    mapper.parseToolResult({
      content: [{ type: "text", text: "Started" }],
      details: {
        background_subagent: true,
        operation: "start",
        task_title: "Existing task",
        attempt: 3,
      },
    }),
  ).description,
  /attempt 3.*Existing task/,
);
console.log("Paseo task-outcome rendering checks passed");
