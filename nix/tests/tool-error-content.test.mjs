// Run against the real built protocol module, never a copied formatter:
// node tool-error-content.test.mjs /path/to/packages/protocol/dist/tool-call-display.js
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Expected compiled production tool-call-display.js path");
const { buildToolCallDisplayModel } = await import(pathToFileURL(process.argv[2]).href);
const traceback =
  'job-123 Failed exit=1\nTraceback (most recent call last):\n  File "job.py", line 1\nRuntimeError: failed\n';
const result = (action) => ({
  content: [{ type: "text", text: traceback }],
  details: { action, job_id: "job-123", status: "failed", exit_code: 1, truncated: false },
  isError: true,
});
const display = (error, status = "failed") =>
  buildToolCallDisplayModel({
    name: "background_job",
    status,
    error,
    detail: { type: "plain_text", text: traceback, label: "wait" },
  });
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

for (const action of ["wait", "output"]) {
  test(`failed background_job ${action} shows readable traceback, not JSON envelope`, () => {
    const error = freeze(result(action));
    const before = structuredClone(error);
    assert.equal(display(error).errorText, traceback, `${action} must expose exact traceback text`);
    assert.deepEqual(error, before, "display must preserve complete structured result");
    assert.equal(error.isError, true);
    assert.equal(error.details.exit_code, 1);
  });
}

test("known nested error envelopes expose text without altering metadata", () => {
  const error = freeze({
    error: { error: result("wait"), code: "JOB_FAILED" },
    requestId: "fixture",
  });
  const before = structuredClone(error);
  assert.equal(display(error).errorText, traceback);
  assert.deepEqual(error, before);
});

test("mixed content shows only text while retaining every non-text payload", () => {
  const error = freeze({
    ...result("output"),
    content: [
      { type: "image", data: "base64", mimeType: "image/png" },
      { type: "text", text: traceback },
      { type: "resource", uri: "fixture://log" },
      { type: "text", text: "second block\n" },
    ],
    structuredContent: { opaque: [1, 2] },
  });
  const before = structuredClone(error);
  assert.equal(display(error).errorText, `${traceback}\nsecond block\n`);
  assert.deepEqual(error, before);
});

test("successful and running jobs never expose an error", () => {
  for (const status of ["completed", "running"]) {
    const error = freeze(result("wait"));
    const before = structuredClone(error);
    assert.equal(display(error, status).errorText, undefined);
    assert.deepEqual(error, before);
  }
});

test("existing direct strings and string-content errors remain verbatim", () => {
  for (const text of [
    "ordinary error\n",
    '{"content":[{"type":"text","text":"do not decode"}]}',
    "  traceback  \n",
    "",
  ]) {
    assert.equal(display(text).errorText, text || undefined);
    assert.equal(display({ content: text, details: { code: 1 } }).errorText, text || undefined);
  }
});

test("unknown objects and non-text errors use readable fields without losing structured data", () => {
  for (const [error, expected] of [
    [{ message: "unrelated error", code: 1 }, "Message: unrelated error\nCode: 1"],
    [{ error: "plain nested diagnostic" }, "Error: plain nested diagnostic"],
    [{ content: [] }, "Content: None"],
    [123, "123"],
  ]) {
    const before = structuredClone(error);
    assert.equal(display(error).errorText, expected);
    assert.deepEqual(error, before);
  }
  for (const error of [
    { details: result("wait") },
    { content: [{ type: "image", data: "base64" }] },
    { content: [{ type: "text", text: 42 }, { text: "not a text block" }] },
  ]) {
    const before = structuredClone(error);
    const text = display(error).errorText;
    assert.equal(typeof text, "string");
    assert.doesNotMatch(text, /"content"|"details"|"type"/);
    assert.deepEqual(error, before);
  }
  assert.equal(display(null).errorText, undefined);
  assert.equal(display(undefined).errorText, undefined);
});

test("nested extraction is bounded and cyclic errors retain the safe fallback", () => {
  const cycle = {};
  cycle.error = cycle;
  assert.equal(display(cycle).errorText, "Error: [Circular reference]");
  let error = result("wait");
  for (let i = 0; i < 10; i++) error = { error };
  assert.match(display(error).errorText, /Error:/);
  assert.doesNotMatch(display(error).errorText, /"content"|"error"/);
});
