import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const root = process.env.PASEO_INSTALL;
if (!root) throw new Error("Set PASEO_INSTALL to the compiled Paseo tree");
const load = (path) => import(pathToFileURL(join(root, path)));
const { readableValue, buildGenericToolSections, genericToolText } = await load(
  "packages/protocol/dist/generic-tool-presentation.js",
);
const { buildToolCallDisplayModel } = await load("packages/protocol/dist/tool-call-display.js");
const { buildPaseoToolDetailSections } = await load(
  "packages/protocol/dist/paseo-tool-presentation/detail-sections.js",
);
const { parseToolArgs, mapToolDetail } = await load(
  "packages/server/dist/server/server/agent/providers/pi/tool-call-mapper.js",
);
const { nativeToolErrorText } = await load(
  "packages/server/dist/server/server/agent/providers/pi/native-tool-error.js",
);
const map = (name, input, output) => mapToolDetail(parseToolArgs(name, input), output);
const result = (text, details = {}) => ({ content: [{ type: "text", text }], details });
const display = (name, detail, extra = {}) =>
  buildToolCallDisplayModel({ name, detail, status: "completed", ...extra });

test("Goal controls have native action titles, labeled input and objective-only output", () => {
  for (const action of ["create", "update", "status", "pause", "resume", "clear"]) {
    const output = result('{"goal":{"objective":"Make tools readable","token_budget":1000}}', {
      presentation: { version: 1, tool: "goal_manage", action, objective: "Make tools readable" },
      goal: { objective: "Make tools readable", token_budget: 1000 },
    });
    const before = JSON.stringify(output);
    const detail = map(
      "goal_manage",
      { action, goal_id: "goal-123", user_authorized: true },
      output,
    );
    assert.equal(detail.type, "plain_text");
    const title = display("goal_manage", detail);
    assert.equal(`${title.displayName} ${title.summary}`, `Goal manage ${action}`);
    assert.equal(detail.text, "Objective: Make tools readable");
    assert.doesNotMatch(
      detail.text,
      /goal-123|Goal id|User authorized|Action:|Required tasks|token_budget/,
    );
    assert.equal(JSON.stringify(output), before);
  }
});

test("Goal metadata is versioned and no-goal status never exposes its machine contract", () => {
  const noGoal = map(
    "goal_manage",
    { action: "status" },
    result('{"goal":null,"remaining":999}', {
      presentation: { version: 1, tool: "goal_manage", action: "status" },
    }),
  );
  assert.equal(noGoal.text, "Objective: None");
  for (const presentation of [
    { version: 2, tool: "goal_manage", objective: "Wrong version" },
    { version: 1, tool: "other", objective: "Wrong tool" },
    { version: 1, tool: "goal_manage", objective: 123 },
  ]) {
    const detail = map(
      "goal_manage",
      { action: "status" },
      result("Original human report", { presentation }),
    );
    assert.equal(detail.text, "Objective: Not available");
  }
});

test("running Goal input shows an objective or title only, never machine controls", () => {
  for (const action of ["create", "update", "status", "pause", "resume", "clear"]) {
    const detail = map("goal_manage", { action, goal_id: "goal-123", user_authorized: true }, null);
    assert.equal(detail.text, "");
    assert.equal(display("goal_manage", detail).summary, action);
  }
  assert.equal(
    map(
      "goal_manage",
      { action: "create", objective: "Readable tools", user_authorized: true },
      null,
    ).text,
    "Objective: Readable tools",
  );
});

test("Goal failures keep diagnostics instead of projecting an available objective", () => {
  const error = {
    isError: true,
    ...result("Permission denied\nTraceback: original; punctuation", {
      presentation: { version: 1, tool: "goal_manage", action: "resume", objective: "Not applied" },
    }),
  };
  const detail = map("goal_manage", { action: "resume" }, error);
  assert.match(detail.text, /Permission denied\nTraceback: original; punctuation/);
  const title = display("goal_manage", detail, { status: "failed", error: "Permission denied" });
  assert.equal(title.errorText, "Permission denied");
});

test("native error adapter uses shared production formatter and leaves raw results intact", () => {
  const raw = {
    content: [
      { type: "text", text: "Original traceback\nfile.py:2; failed" },
      { type: "text", text: "Second diagnostic" },
    ],
    details: { exitCode: 1 },
  };
  const before = JSON.stringify(raw);
  const text = nativeToolErrorText(raw);
  assert.match(text, /Original traceback\nfile.py:2; failed/);
  assert.match(text, /Second diagnostic/);
  assert.doesNotMatch(text, /"content"|"type"|"text"/);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(nativeToolErrorText("Original plain error"), "Original plain error");
  assert.equal(nativeToolErrorText(null), "Tool call failed");
});

test("harness families show human prose only while unrelated generic tools retain their fields", () => {
  for (const [name, input] of [
    ["subagent", { operation: "status", job_id: "group-1" }],
    [
      "questionnaire",
      { questions: [{ prompt: "Which scope?", options: [{ label: "Everything", value: "all" }] }] },
    ],
    ["fetch", { method: "POST", url: "https://example.invalid", body: '{"source":"keep exact"}' }],
    ["nativeaccount", { action: "status" }],
    ["control", { action: "abort" }],
    ["update_progress", { steps: [{ text: "Review", status: "blocked" }] }],
    ["sandbox_allow_path", { path: "/workspace" }],
    ["notify_parent", { message: "Needs attention" }],
  ]) {
    const output = result("Human report\nsecond line; untouched", {
      status: "running",
      futureField: { important: false },
      count: 0,
    });
    const before = JSON.stringify({ input, output });
    const detail = map(name, input, output);
    assert.equal(detail.type, "plain_text", name);
    assert.match(detail.text, /Human report\nsecond line; untouched/);
    if (["nativeaccount", "control"].includes(name)) {
      assert.match(detail.text, /Future Field: Important: No/);
      assert.match(detail.text, /Count: 0/);
    } else assert.equal(detail.text, "Human report\nsecond line; untouched");
    assert.equal(JSON.stringify({ input, output }), before);
  }
});

test("subagent tasks preserve native card and outcome semantics while formatting result wrapper", () => {
  const detail = map(
    "subagent",
    { task: "Review UX", acceptance: ["Useful display"] },
    result("All checks pass", {
      task_outcome: { state: "delivered", reported: true },
      future: "retained",
    }),
  );
  assert.equal(detail.type, "sub_agent");
  assert.match(detail.description, /Reported delivered/);
  assert.match(detail.log, /All checks pass/);
  assert.equal(detail.log, "All checks pass");
});

test("canonical files, diff and shell payloads are not parsed or rewritten", () => {
  const json = '{"message":"hello; world"}';
  assert.equal(map("read", { path: "file.json" }, result(json)).content, json);
  assert.equal(map("write", { path: "file.json", content: json }, result("Written")).content, json);
  assert.equal(map("bash", { command: 'printf "a;b"' }, result(json)).output, json);
  assert.match(
    map("fetch", { url: "https://example.invalid" }, result(json)).text,
    /\{"message":"hello; world"\}/,
  );
  assert.match(
    map("background_job", { action: "output" }, result(json)).text,
    /\{"message":"hello; world"\}/,
  );
  const edited = map(
    "edit",
    { path: "file.json", edits: [{ oldText: "old;", newText: "new;" }] },
    result("Edited", { diff: "@@ -1 +1 @@\n-old;\n+new;" }),
  );
  assert.equal(edited.type, "edit");
  assert.match(edited.unifiedDiff, /\+new;/);
});

test("arbitrary textual tools also get native-compatible labeled presentation", () => {
  for (const name of ["future_tool", "pdf_info", "account_status", "runtime_control"]) {
    const detail = map(
      name,
      { action: "inspect", some_option: false },
      result("Human report", { future: 42 }),
    );
    assert.equal(detail.type, "plain_text");
    assert.equal(display(name, detail).summary, "inspect");
    assert.match(detail.text, /Some option: No/);
    assert.match(detail.text, /Future: 42/);
    assert.match(detail.text, /Human report/);
  }
  const native = map("mcp__paseo__list_agents", {}, result('{"agents":[]}'));
  assert.equal(native.type, "unknown", "retain native Paseo catalog path");
});

test("unknown structured results keep every field and nontext block without JSON serialization", () => {
  const output = {
    content: [
      { type: "image", mimeType: "image/png", data: "binary-base64" },
      { type: "text", text: '{"actual":"JSON payload"}' },
    ],
    structuredContent: { zero: 0, enabled: false },
    future: ["one", "two"],
  };
  const detail = map("future_tool", { foo_bar: "value" }, output);
  assert.equal(detail.type, "unknown");
  assert.deepEqual(detail.output, output);
  const text = genericToolText("future_tool", detail.input, detail.output);
  assert.match(text, /Mime Type: image\/png/);
  assert.match(text, /binary-base64/);
  assert.match(text, /\{"actual":"JSON payload"\}/);
  assert.match(text, /Enabled: No/);
  assert.match(text, /Future: • one\n/);
  assert.equal(buildGenericToolSections("future_tool", "plain\ntext", null)[0].text, "plain\ntext");
});

test("native Paseo result catalog does not discard unexpected fields or human content", () => {
  const sections = buildPaseoToolDetailSections(
    "mcp__paseo__list_agents",
    {},
    {
      content: [{ type: "text", text: "Human report" }],
      structuredContent: { agents: [] },
      futureField: "important",
    },
  );
  assert.ok(sections);
  const rendered = sections
    .flatMap((s) =>
      s.kind === "fields" ? s.fields.map((f) => `${f.label}: ${f.value}`) : [s.text],
    )
    .join("\n");
  assert.match(rendered, /Human report/);
  assert.match(rendered, /Future Field: important/);
});

test("legacy non-array tool content remains readable instead of crashing the mapper", () => {
  for (const content of ["Legacy diagnostic", false, 0]) {
    const output = { content, details: { future: "retained" } };
    const before = structuredClone(output);
    const detail = map("future_tool", { query: "example" }, output);
    assert.equal(detail.type, "plain_text");
    assert.match(detail.text, /Future: retained/);
    assert.ok(detail.text.includes(readableValue(content)));
    assert.deepEqual(output, before);
  }
});

const showcase = JSON.parse(
  readFileSync(
    process.env.PASEO_COMPACT_FIXTURES ??
      new URL("./testfixtures/compact-harness-showcase.json", import.meta.url),
    "utf8",
  ),
);
for (const fixture of showcase)
  test(`compact showcase: ${fixture.case}`, () => {
    const before = structuredClone(fixture);
    assert.equal(genericToolText(fixture.name, fixture.input, fixture.before), fixture.after);
    const detail = map(fixture.name, fixture.input, fixture.before);
    assert.equal(detail.type === "sub_agent" ? detail.log : detail.text, fixture.after);
    assert.doesNotMatch(
      fixture.after,
      /Input\n|Output\n|Result details|job_id|task_id|child_id|tmux|resume_after_ms|report_sequence|Synthetic delegated prompt/,
    );
    assert.deepEqual(fixture, before);
  });

test("subagent control families use structured group states, never delegated prompts or bookkeeping", () => {
  const group = structuredClone(
    showcase.find((f) => f.case === "Subagent native wait").before.details.group,
  );
  for (const operation of [
    "start",
    "wait",
    "wait_group",
    "status",
    "cancel",
    "reap",
    "promote",
    "list",
    "tasks",
    "wait_any",
    "wait_all",
  ]) {
    const details = ["list", "tasks", "wait_any", "wait_all"].includes(operation)
      ? { operation, groups: [group] }
      : { operation, group };
    const output = result("generated control report includes internal IDs", details);
    const before = structuredClone(output);
    assert.equal(genericToolText("subagent", { operation }, output), "Worker 1 · Running");
    assert.equal(map("subagent", { operation }, output).text, "Worker 1 · Running");
    assert.deepEqual(output, before);
  }
  group.children[0].status = "failed";
  group.children[0].error = "Worker command authority unavailable";
  assert.equal(
    genericToolText("subagent", { operation: "wait" }, result("raw", { group })),
    "Worker 1 · Failed · Worker command authority unavailable",
  );
  assert.equal(
    genericToolText(
      "subagent",
      { operation: "status" },
      result("Unrecognized future human report", { future: true }),
    ),
    "Unrecognized future human report",
  );
});

test("subagent reap prefers canonical displayName and retains status and outcome", () => {
  const group = structuredClone(
    showcase.find((f) => f.case === "Subagent native wait").before.details.group,
  );
  const child = group.children[0];
  child.status = "completed";
  child.task_outcome = { state: "delivered" };
  for (const [names, expected] of [
    [
      { displayName: "Renderer Review", name: "legacy-name", label: "Old label" },
      "Renderer Review",
    ],
    [{ displayName: "", name: "legacy-name", label: "Old label" }, "legacy-name"],
    [{ displayName: "   ", name: "legacy-name", label: "Old label" }, "legacy-name"],
    [{ displayName: "", label: "Old label" }, "Old label"],
    [{ displayName: "" }, "Worker 1"],
  ]) {
    delete child.displayName;
    delete child.name;
    delete child.label;
    Object.assign(child, names);
    const output = result("Group reaped", { operation: "reap", group });
    const before = structuredClone(output);
    const text = `${expected} · Completed · Reported delivered`;
    assert.equal(genericToolText("subagent", { operation: "reap" }, output), text);
    assert.equal(map("subagent", { operation: "reap" }, output).text, text);
    assert.deepEqual(output, before);
  }
});

test("subagent prompts show verbatim instructions without generated delivery headings", () => {
  const group = structuredClone(
    showcase.find((f) => f.case === "Subagent native wait").before.details.group,
  );
  const message =
    "  Run the requested checks.\n\nSteer · Instruction sent\nKeep this user heading.\n";
  for (const mode of ["steer", "follow_up", "interrupt"]) {
    const input = {
      operation: "prompt",
      child_id: group.children[0].child_id,
      name: "Verifier",
      control_mode: mode,
      message,
    };
    const output = result("Accepted by child", { operation: "prompt", group, receipt: "accepted" });
    const before = structuredClone(output);
    assert.equal(genericToolText("subagent", input, output), message);
    assert.equal(map("subagent", input, output).text, message);
    assert.deepEqual(output, before);
    const failed = {
      ...output,
      isError: true,
      content: [{ type: "text", text: "Permission denied\nOriginal diagnostic" }],
    };
    assert.equal(
      genericToolText("subagent", input, failed),
      "Permission denied\nOriginal diagnostic",
    );
    assert.equal(map("subagent", input, failed).text, "Permission denied\nOriginal diagnostic");
    assert.equal(
      genericToolText(
        "subagent",
        { ...input, name: undefined, label: "Reviewer", mode, control_mode: undefined },
        result("Instruction sent"),
      ),
      message,
    );
  }
  const responseInput = {
    operation: "prompt",
    child_id: group.children[0].child_id,
    message: "Please summarize now.",
  };
  const responseOutput = result("Child response: checks passed", {
    operation: "prompt",
    group,
    receipt: "completed",
    response: "Checks passed.",
  });
  assert.equal(
    genericToolText("subagent", responseInput, responseOutput),
    "Please summarize now.\n\nResponse\nChecks passed.",
  );
});

test("native subagent full answers and JSON logs survive validated wrapper removal", () => {
  const group = structuredClone(
    showcase.find((f) => f.case === "Subagent native wait").before.details.group,
  );
  group.status = "completed";
  group.children[0].status = "completed";
  const log =
    'Full answer.\n{"status":"running","cwd":"user data"}\nInput\nkeep these user headings';
  const raw = `${group.job_id} completed (single, background)\n1. ${group.children[0].child_id} task_id=${group.children[0].task_id} completed\n${log}`;
  for (const operation of ["output", "prompt", "resume", "result"]) {
    const output = result(raw, { operation, group });
    const before = structuredClone(output);
    assert.equal(
      genericToolText("subagent", { operation }, output),
      `Worker 1 · Completed\n\n${log}`,
    );
    assert.deepEqual(output, before);
  }
  assert.equal(
    genericToolText(
      "subagent",
      { operation: "result" },
      result(log, { operation: "result", complete: false }),
    ),
    `${log}\n\n[Report continues; more output is available.]`,
  );
});

test("versioned subagent presentation renders framed multi-worker reports verbatim without control details", () => {
  const log =
    'Original full answer.\n2. subagent-child-user-log task_id=user-log completed\n{"cwd":"user data"}\n';
  const presentation = {
    version: 1,
    tool: "subagent",
    children: [
      { name: "Renderer review", status: "Reported delivered", report: log },
      {
        name: "Focused checks",
        status: "Failed",
        report: "check.ts:4: Expected 2, received 3",
        error: "Process exited with code 1",
      },
    ],
    notice: "Read-only retained result; worker status unavailable.",
  };
  const expected = `Renderer review · Reported delivered\n\n${log}\n\nFocused checks · Failed\n\ncheck.ts:4: Expected 2, received 3\n\nProcess exited with code 1\n\nRead-only retained result; worker status unavailable.`;
  for (const operation of [
    "start",
    "status",
    "wait",
    "wait_group",
    "wait_any",
    "wait_all",
    "output",
    "result",
    "list",
    "prompt",
    "resume",
    "cancel",
    "reap",
  ]) {
    const output = {
      ...result("Legacy full control report with internal IDs", {
        operation,
        presentation,
        job_id: "hidden",
        artifact: "/synthetic/private",
      }),
      isError: operation === "result",
    };
    const before = structuredClone(output);
    assert.equal(genericToolText("subagent", { operation, wait_ms: 1000 }, output), expected);
    assert.equal(map("subagent", { operation }, output).text, expected);
    assert.deepEqual(output, before);
  }
  assert.equal(
    genericToolText(
      "subagent",
      {},
      result("raw", {
        presentation: {
          version: 1,
          tool: "subagent",
          children: [
            {
              name: "Worker",
              status: "Failed",
              report: "Exact diagnostic",
              error: "Exact diagnostic",
            },
          ],
        },
      }),
    ),
    "Worker · Failed\n\nExact diagnostic",
  );
  assert.equal(
    genericToolText(
      "subagent",
      {},
      {
        ...result("Precise raw failure", {
          presentation: {
            version: 1,
            tool: "subagent",
            children: [{ name: "Worker", status: "Failed" }],
          },
        }),
        isError: true,
      },
    ),
    "Precise raw failure",
  );
});

test("unknown presentation schemas and unframed multi-worker output preserve full legacy text as compatibility fallback", () => {
  const legacy =
    "subagent-job-synthetic running (parallel, background)\n1. child-1 task_id=task-1 completed\nOriginal answer\n2. child-2 task_id=task-2 failed\nOriginal diagnostic";
  const group = {
    job_id: "subagent-job-synthetic",
    status: "running",
    mode: "parallel",
    background: true,
    children: [
      { child_id: "child-1", task_id: "task-1", status: "completed" },
      { child_id: "child-2", task_id: "task-2", status: "failed" },
    ],
  };
  for (const presentation of [
    undefined,
    { version: 2, tool: "subagent", children: [] },
    { version: 1, tool: "other", children: [] },
    { version: 1, tool: "subagent", children: [{ name: "Invalid", status: "Failed", report: 42 }] },
  ]) {
    const output = result(legacy, {
      operation: "output",
      group,
      ...(presentation ? { presentation } : {}),
    });
    const before = structuredClone(output);
    assert.equal(genericToolText("subagent", { operation: "output" }, output), legacy);
    assert.equal(map("subagent", { operation: "output" }, output).text, legacy);
    assert.deepEqual(output, before);
  }
  assert.equal(
    genericToolText(
      "subagent",
      {},
      result("Legacy full human report", {
        presentation: { version: 1, tool: "subagent", children: [], notice: "No active workers." },
      }),
    ),
    "No active workers.",
  );
});

test("legacy subagent result page validates byte metadata before removing generated selectors", () => {
  const details = {
    operation: "result",
    job_id: "subagent-job-synthetic",
    child: 1,
    offset: 0,
    bytes: 12,
    total_bytes: 24,
    next_offset: 12,
    complete: false,
  };
  const output = result(
    "[reviewer] bytes 0-12 of 24\n\nFirst answer\n\n[Use operation=result with job_id=subagent-job-synthetic, child=1, offset=12 to continue.]",
    details,
  );
  assert.equal(
    genericToolText("subagent", { operation: "result" }, output),
    "First answer\n\n[Report continues; more output is available.]",
  );
  const mismatch = structuredClone(output);
  mismatch.details.bytes = 11;
  assert.equal(
    genericToolText("subagent", { operation: "result" }, mismatch),
    `${output.content[0].text}\n\n[Report continues; more output is available.]`,
  );
});

test("goal terminal tools, worker reports, notifications and rejected controls preserve useful human diagnostics", () => {
  for (const name of [
    "goal_complete",
    "goal_blocked",
    "goal_wait",
    "subagent",
    "update_progress",
    "task_outcome",
    "notify_parent",
    "sandbox_allow_path",
  ]) {
    const output = {
      ...result("Permission denied\nOriginal diagnostic", {
        goal_id: "internal",
        summary: "Must not display this success blob",
        reason: "Not applied",
      }),
      isError: true,
    };
    const before = structuredClone(output);
    assert.equal(
      genericToolText(name, { goal_id: "internal" }, output),
      "Permission denied\nOriginal diagnostic",
    );
    assert.deepEqual(output, before);
  }
  assert.equal(
    genericToolText(
      "goal_complete",
      {},
      result("Goal complete: All checks passed.", {
        goal_id: "internal",
        summary: "All checks passed.",
      }),
    ),
    "Goal complete: All checks passed.",
  );
  assert.equal(
    genericToolText(
      "goal_blocked",
      {},
      result("Goal blocked: Need review.", {
        reason: "Need review.",
        evidence: "Three checks confirmed no callback.",
        repeated_turns: 3,
      }),
    ),
    "Goal blocked: Need review.\n\nThree checks confirmed no callback.",
  );
  assert.equal(
    genericToolText(
      "goal_complete",
      {},
      result("Goal completion rejected: no active goal.", {
        summary: "Success blob must not appear",
      }),
    ),
    "Goal completion rejected: no active goal.",
  );
  const outcome = {
    version: 1,
    state: "partial",
    summary: "Renderer updated.",
    acceptance: [{ criterion: "Focused checks", status: "passed", evidence: "3 passed" }],
    artifacts: [{ path: "/synthetic/private/report" }],
    remaining: ["Review screenshots"],
    next_action: "Request visual review",
    continuation: "needs_input",
  };
  assert.equal(
    genericToolText(
      "task_outcome",
      {},
      result("Recorded partial; execution completion and explicit reap remain separate.", {
        task_outcome: outcome,
      }),
    ),
    "Needs continuation\nRenderer updated.\n✓ Focused checks — 3 passed\nRemaining:\nReview screenshots\nNext: Request visual review",
  );
});

const jobId = "job-0123456789abcdef01234567";
const jobInput = { action: "wait", job_id: jobId, timeout_ms: 1000, lines: 30 };
const jobDetails = {
  action: "wait",
  job_id: jobId,
  status: "running",
  name: "Build Matebook",
  timed_out: true,
  retention: "until-explicit-reap",
  pane_id: "%42",
  tmux_socket: "/tmp/tmux",
  tmux_session: "session",
  output_source: "log",
};
const jobEnvelope = (log, overrides = {}, headerOverrides = {}) => {
  const details = { ...jobDetails, ...overrides };
  const labels = {
    running: "Running",
    failed: "Failed",
    completed: "Finished",
    cancelled: "Cancelled",
  };
  const header = { ...details, ...headerOverrides };
  const text = `${header.job_id}  ${labels[header.status]}${typeof header.exit_code === "number" ? ` exit=${header.exit_code}` : ""}  17s  ${header.name}\ncwd: /private/workspace\ncommand: secret-build-command\n${details.timed_out ? "Wait timed out; job is still running.\n" : ""}${log}`;
  return result(text, details);
};
const assertJob = (input, output, expected) => {
  const before = structuredClone({ input, output });
  assert.equal(genericToolText("background_job", input, output), expected);
  const detail = map("background_job", input, output);
  assert.equal(detail.type, "plain_text");
  assert.equal(detail.text, expected);
  assert.deepEqual({ input, output }, before, "presentation must not mutate the machine envelope");
  assert.deepEqual(
    buildGenericToolSections("background_job", input, output),
    expected ? [{ kind: "prose", title: "", text: expected }] : [],
  );
  return detail;
};

test("background wait projects only human name, concise state and verbatim requested logs", () => {
  const log = "building system closure...\n  compiler: keep indentation\n";
  const output = jobEnvelope(log);
  const detail = assertJob(jobInput, output, `Build Matebook\nStill running · 17s\n\n${log}`);
  assert.equal(display("background_job", detail).displayName, "Background job");
  assert.equal(display("background_job", detail).summary, "wait");
  assert.doesNotMatch(
    detail.text,
    /Input|Output|Result details|job-0123|cwd:|command:|secret-build|timeout|retention|tmux|Is error/,
  );
});

test("background failure, signal, cancellation and unavailable output retain compact diagnostics", () => {
  const failed = jobEnvelope("reason: Process exited nonzero\nTraceback: original failure", {
    status: "failed",
    exit_code: 23,
    signal: "SIGTERM",
    timed_out: false,
  });
  failed.isError = true;
  assertJob(
    jobInput,
    failed,
    "Build Matebook\nFailed · exit 23 · SIGTERM · 17s\n\nreason: Process exited nonzero\nTraceback: original failure",
  );
  assertJob(
    jobInput,
    jobEnvelope("", { status: "cancelled", signal: "SIGINT", timed_out: false }),
    "Build Matebook\nCancelled · SIGINT · 17s",
  );
  assertJob(
    jobInput,
    jobEnvelope("(no output)", { timed_out: false }),
    "Build Matebook\nRunning · 17s\n\n(no output)",
  );
  assertJob(
    { ...jobInput, lines: undefined },
    jobEnvelope(""),
    "Build Matebook\nStill running · 17s",
  );
  assertJob(
    jobInput,
    { ...result("Permission denied\nOriginal diagnostic", { action: "wait" }), isError: true },
    "Permission denied\nOriginal diagnostic",
  );
});

test("background output keeps JSON and header-like log lines byte-for-byte, including truncation", () => {
  const log = `{"status":"failed","cwd":"user JSON"}\ncwd: user log\ncommand: user log\n${jobId}  Running  17s  Build Matebook\nWait timed out; job is still running.\n[output truncated to the last 50 KiB / 2000 lines]`;
  const output = result(`${jobId}  Running  17s  Build Matebook\n${log}`, {
    ...jobDetails,
    action: "output",
    timed_out: false,
    truncated: true,
  });
  assertJob(
    { action: "output", job_id: jobId, lines: 30 },
    output,
    `Build Matebook\nRunning · 17s\n\n${log}`,
  );
  assertJob(
    jobInput,
    jobEnvelope("tail", { truncated: true }),
    "Build Matebook\nStill running · 17s\n\ntail\n[output truncated to the last 50 KiB / 2000 lines]",
  );
});

test("background unrecognized or mismatched headers and raw JSON payloads are not stripped", () => {
  for (const header of [
    { job_id: "job-aaaaaaaaaaaaaaaaaaaaaaaa" },
    { name: "Different job" },
    { status: "failed" },
  ]) {
    const output = jobEnvelope("cwd: payload\ncommand: payload", {}, header);
    assertJob(jobInput, output, `Build Matebook\nStill running\n\n${output.content[0].text}`);
  }
  for (const text of [
    `${jobId}  Running  17s  Build Matebook\ncwd: user log without producer command\nkeep`,
    "cwd: user log\ncommand: user log",
    '{"job_id":"payload","status":"running"}',
  ]) {
    assertJob(jobInput, result(text, jobDetails), `Build Matebook\nStill running\n\n${text}`);
  }
});

test("background watch, alerts and lifecycle controls do not expose transport metadata", () => {
  const watchDetails = {
    watch_id: "watch-0123456789abcdef01234567",
    log_path: "/synthetic/private/build.log",
  };
  const cases = [
    [
      { action: "watch" },
      result("Generated transport guidance", { action: "watch", ...watchDetails }),
      "Watching log\nStage/match and completion alerts will reach the parent automatically.",
    ],
    [
      { action: "watches" },
      result("Generated rows", {
        action: "watches",
        watches: [{ ...watchDetails, label: "Preview build", status: "running" }],
      }),
      "Preview build\nRunning",
    ],
    [
      { action: "events" },
      result("Generated event transport header", {
        action: "events",
        ...watchDetails,
        overflow: true,
        events: [
          {
            sequence: 2,
            rule: "compile failure",
            text: "error: syntax at demo.ts:3\n  original indentation",
          },
        ],
      }),
      "Some older alerts expired from the retained journal. Inspect the log before assuming full coverage.\n\ncompile failure\nerror: syntax at demo.ts:3\n  original indentation",
    ],
    [
      { action: "ack" },
      result("Generated acknowledgment", {
        action: "ack",
        acknowledged_through: 2,
        ...watchDetails,
      }),
      "Alerts acknowledged through #2. Newer alerts remain unread.",
    ],
    [
      { action: "unwatch" },
      result("Generated stop notice", { action: "unwatch", ...watchDetails }),
      "Stopped watching. The build has NOT been cancelled.",
    ],
    [
      { action: "signal" },
      result(`Sent SIGTERM to ${jobId}.`, {
        ...jobDetails,
        action: "signal",
        signal: "SIGTERM",
        timed_out: false,
      }),
      "Build Matebook\nRunning · SIGTERM\n\nSent SIGTERM.",
    ],
    [
      { action: "reap" },
      result("Job reaped", { action: "reap", job_id: jobId, name: "Build Matebook", reaped: true }),
      "Build Matebook\nJob reaped",
    ],
  ];
  for (const [input, output, expected] of cases) assertJob(input, output, expected);
  assertJob(
    { action: "cancel" },
    jobEnvelope("", { action: "cancel", status: "cancelled", timed_out: false }),
    "Build Matebook\nCancelled · 17s",
  );
  assertJob(
    jobInput,
    result("", {
      ...jobDetails,
      status: "failed",
      timed_out: false,
      error: "Observation socket closed",
    }),
    "Build Matebook\nFailed\n\nObservation socket closed",
  );
});

test("background start, status, adopt and list use compact states instead of key-value dumps", () => {
  for (const action of ["status", "start"]) {
    assertJob(
      { action },
      jobEnvelope(action === "start" ? "Started in a new tmux pane." : "", {
        action,
        timed_out: false,
      }),
      "Build Matebook\nRunning · 17s",
    );
  }
  const observed = { ...jobDetails, action: "adopt", observation_only: true, timed_out: false };
  const adopt = result(
    `${jobId}  Observing  17s  Build Matebook\ncwd: /workspace\ncommand: process\nObservation only: no process control or exit-status guarantee.`,
    observed,
  );
  assertJob(
    { action: "adopt" },
    adopt,
    "Build Matebook\nObserving · 17s\nRead-only observation; no process control or exit-status guarantee.",
  );
  const jobs = [
    { ...jobDetails, timed_out: false },
    { job_id: "job-aaaaaaaaaaaaaaaaaaaaaaaa", name: "Tests", status: "completed", exit_code: 0 },
  ];
  assertJob(
    { action: "list" },
    result(
      `${jobId}  Running  17s  Build Matebook\njob-aaaaaaaaaaaaaaaaaaaaaaaa  Finished exit=0  2m  Tests`,
      { action: "list", jobs },
    ),
    "Build Matebook\nRunning · 17s\n\nTests\nFinished · 2m",
  );
  assertJob(
    { action: "list" },
    result("No background jobs for this Pi session.", { action: "list", jobs: [] }),
    "No background jobs for this Pi session.",
  );
  assertJob({ action: "wait", job_id: jobId }, null, "");
});

test("generic fallback handles malformed JSON, long values, empty values and cycles without loss", () => {
  const long = "x".repeat(20000);
  assert.equal(readableValue(long), long);
  assert.equal(readableValue(false), "No");
  assert.equal(readableValue(0), "0");
  assert.equal(readableValue([]), "None");
  const cycle = {};
  cycle.self = cycle;
  assert.match(readableValue(cycle), /Circular reference/);
  assert.match(genericToolText("background_job", {}, "{not json"), /\{not json/);
  assert.equal(buildGenericToolSections("future_tool", null, null).length, 0);
});
