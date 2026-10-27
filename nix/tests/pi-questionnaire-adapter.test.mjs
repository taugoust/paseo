import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const paseoLib = process.argv[2];
const fixturePath = process.argv[3];
if (!paseoLib || !fixturePath)
  throw new Error("Pass the composed Paseo build and isolated fixture paths");
const { piQuestionnaire } = await import(
  pathToFileURL(
    join(
      paseoLib,
      "packages/server/dist/server/server/agent/providers/pi/extensions/pi-questionnaire-adapter.js",
    ),
  )
);
const { createPiExtensionHost } = await import(
  pathToFileURL(
    join(paseoLib, "packages/server/dist/server/server/agent/providers/pi/extensions/index.js"),
  )
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const host = () => createPiExtensionHost(undefined, [piQuestionnaire]);
const call = (id = "call-q", args = fixture.args) => ({
  callId: id,
  toolName: "questionnaire",
  args,
  status: "running",
  result: null,
});
const metadata = (toolCallId = "call-q", index = 0, input = true) => ({
  v: 1,
  toolCallId,
  index,
  input,
});
const frame = (
  id,
  method,
  options,
  title,
  {
    toolCallId = "call-q",
    index = 0,
    input = true,
    placeholder = "Type your answer",
    tagged = true,
  } = {},
) => ({
  id,
  method,
  options,
  title,
  ...(method === "input" ? { placeholder } : {}),
  ...(tagged ? { paseoQuestionnaire: metadata(toolCallId, index, input) } : {}),
});
const answered = (overrides = {}) => ({
  behavior: "allow",
  updatedInput: {
    answers: {
      "1. Scope · scope": "2. Shared",
      "2. Mode · mode": "2. Other (write an answer)",
      ...overrides,
    },
  },
});
const title1 =
  "Question 1 of 2 · Scope\n\nWhich scope?\n\nOptions:\n1. Shared\n   First meaning\n2. Shared\n   Second meaning";
const title2 = "Question 2 of 2 · Mode\n\nWhich mode?\n\nOptions:\n1. Fast\n   Quick";
const pickerOptions = [
  "1. Shared",
  "2. Shared",
  "Other (write an answer)",
  "Answer in terminal",
  "Cancel questionnaire",
];
const firstFrame = (id = "d1", options = pickerOptions, title = title1, fields = {}) =>
  frame(id, "select", options, title, fields);

test("onToolStart stores valid questionnaire state without creating premature UI", () => {
  const h = host();
  assert.equal(h.onToolStart(call()), undefined);
  h.close();
});

test("first compatible frame creates one native batch with descriptions and capability-gated Other options", () => {
  const h = host();
  assert.equal(h.onToolStart(call()), undefined);
  const permission = h.mapDialog(firstFrame());
  assert.equal(permission.type, "permission");
  assert.equal(permission.toolCallId, "call-q");
  assert.deepEqual(h.mapDialog(firstFrame()), {
    type: "deferred",
    requestId: "pi-questionnaire:call-q",
    toolCallId: "call-q",
  });
  assert.deepEqual(permission.request.input.questions[0].options, [
    { label: "1. Shared", description: "First meaning" },
    { label: "2. Shared", description: "Second meaning" },
    { label: "3. Other (write an answer)" },
  ]);
  assert.equal(permission.request.input.questions[0].allowOther, false);
  assert.deepEqual(
    permission.request.input.questions[1].options.map((option) => option.label),
    ["1. Fast", "2. Other (write an answer)"],
  );
  h.close();
});

test("batch answers map by index and custom text stays literal through a correlated input frame", () => {
  const h = host();
  h.onToolStart(call());
  const initial = h.mapDialog(firstFrame());
  assert.deepEqual(h.respondToPermission(initial.request, answered()), {
    responses: [{ id: "d1", response: { value: "2. Shared" } }],
  });
  const next = frame(
    "d2",
    "select",
    ["1. Fast", "Other (write an answer)", "Answer in terminal", "Cancel questionnaire"],
    title2,
    { index: 1 },
  );
  assert.deepEqual(h.mapDialog(next), {
    type: "response",
    response: { value: "Other (write an answer)" },
  });
  const literal = "  Shared\n\t";
  const input = h.mapDialog(frame("d3", "input", [], title2, { index: 1 }));
  assert.equal(input.type, "permission");
  assert.equal(input.toolCallId, "call-q");
  assert.deepEqual(input.request.input.questions, [
    {
      question: title2,
      header: "custom.2.mode",
      options: [],
      multiSelect: false,
      allowOther: false,
      allowEmpty: true,
      placeholder: "Type your answer",
    },
  ]);
  assert.deepEqual(
    h.respondToPermission(input.request, {
      behavior: "allow",
      updatedInput: { answers: { "custom.2.mode": literal } },
    }),
    {
      responses: [{ id: "d3", response: { value: literal } }],
    },
  );
  h.close();
});

test("real option named Other remains distinct from the appended sentinel", () => {
  const h = host();
  const args = {
    questions: [
      {
        id: "collision",
        label: "Choice",
        prompt: "Choose?",
        allowOther: true,
        options: [{ value: "literal", label: "Other (write an answer)" }],
      },
    ],
  };
  h.onToolStart(call("collision", args));
  const title = "Question · Choice\n\nChoose?";
  const options = [
    "1. Other (write an answer)",
    "Other (write an answer)",
    "Answer in terminal",
    "Cancel questionnaire",
  ];
  const permission = h.mapDialog(
    frame("d1", "select", options, title, { toolCallId: "collision" }),
  );
  assert.equal(permission.type, "permission");
  assert.deepEqual(
    h.respondToPermission(permission.request, {
      behavior: "allow",
      updatedInput: { answers: { "1. Choice · collision": "2. Other (write an answer)" } },
    }),
    {
      responses: [{ id: "d1", response: { value: "Other (write an answer)" } }],
    },
  );
  const input = h.mapDialog(frame("d2", "input", [], title, { toolCallId: "collision" }));
  assert.equal(input.type, "permission");
  h.close();
});

test("input capability is global and allowOther remains question-specific", () => {
  const h = host();
  const args = {
    questions: [
      {
        id: "fixed",
        label: "Fixed",
        prompt: "Fixed?",
        allowOther: false,
        options: [{ value: "x", label: "X" }],
      },
      {
        id: "custom",
        label: "Custom",
        prompt: "Custom?",
        allowOther: true,
        options: [{ value: "y", label: "Y" }],
      },
    ],
  };
  h.onToolStart(call("capability", args));
  const title = "Question 1 of 2 · Fixed\n\nFixed?";
  const permission = h.mapDialog(
    frame("fixed", "select", ["1. X", "Answer in terminal", "Cancel questionnaire"], title, {
      toolCallId: "capability",
      input: true,
    }),
  );
  assert.equal(permission.type, "permission");
  assert.deepEqual(
    permission.request.input.questions.map((question) =>
      question.options.map((option) => option.label),
    ),
    [["1. X"], ["1. Y", "2. Other (write an answer)"]],
  );
  h.close();
});

test("input capability gates Other globally while allowOther remains question-specific", () => {
  const h = host();
  h.onToolStart(call());
  const options = ["1. Shared", "2. Shared", "Answer in terminal", "Cancel questionnaire"];
  const permission = h.mapDialog(firstFrame("no-input", options, title1, { input: false }));
  assert.equal(permission.type, "permission");
  assert.deepEqual(
    permission.request.input.questions.map((question) =>
      question.options.map((option) => option.label),
    ),
    [["1. Shared", "2. Shared"], ["1. Fast"]],
  );
  h.close();
});

test("legacy bridge frames without metadata remain unclaimed and do not create a batch form", () => {
  const h = host();
  assert.equal(h.onToolStart(call()), undefined);
  assert.equal(
    h.mapDialog(firstFrame("legacy", pickerOptions, title1, { tagged: false })),
    undefined,
  );
  h.close();
});

test("unrelated and mismatched dialogs pass through; incomplete batches cancel the matching frame", () => {
  const h = host();
  h.onToolStart(call());
  assert.equal(
    h.mapDialog(frame("foreign", "select", ["yes", "no"], "Unrelated question")),
    undefined,
  );
  assert.equal(h.mapDialog(firstFrame("mismatch", ["1. Shared"], title1)), undefined);
  const matching = firstFrame("deferred");
  const permission = h.mapDialog(matching);
  assert.equal(permission.type, "permission");
  assert.deepEqual(
    h.respondToPermission(permission.request, {
      behavior: "allow",
      updatedInput: { answers: { "1. Scope · scope": "2. Shared" } },
    }),
    {
      responses: [{ id: "deferred", response: { cancelled: true } }],
    },
  );
  h.close();
});

test("custom input cancellation declines only its correlated input frame", () => {
  const h = host();
  h.onToolStart(call());
  const initial = h.mapDialog(firstFrame());
  h.respondToPermission(initial.request, answered());
  const title = title2;
  h.mapDialog(
    frame(
      "select-custom",
      "select",
      ["1. Fast", "Other (write an answer)", "Answer in terminal", "Cancel questionnaire"],
      title,
      { index: 1 },
    ),
  );
  const input = h.mapDialog(frame("input-custom", "input", [], title, { index: 1 }));
  assert.equal(input.type, "permission");
  assert.deepEqual(h.respondToPermission(input.request, { behavior: "deny" }), {
    responses: [{ id: "input-custom", response: { cancelled: true } }],
  });
  h.close();
});

test("unrelated concurrent tools do not cancel the active questionnaire", () => {
  const h = host();
  h.onToolStart(call("active"));
  assert.equal(h.onToolStart({ ...call("parallel-other"), toolName: "read" }), undefined);
  const permission = h.mapDialog(
    firstFrame("active-select", pickerOptions, title1, { toolCallId: "active" }),
  );
  assert.equal(permission.type, "permission");
  assert.equal(permission.toolCallId, "active");
  h.close();
});

test("overlapping questionnaire calls fail closed rather than misattributing dialogs", () => {
  const h = host();
  h.onToolStart(call("active"));
  assert.equal(h.onToolStart(call("second")), undefined);
  assert.deepEqual(
    h.mapDialog(firstFrame("cancelled", pickerOptions, title1, { toolCallId: "active" })),
    { type: "response", response: { cancelled: true } },
  );
  h.close();
});
