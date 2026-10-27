import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
if (!process.argv[2]) throw new Error("Expected compiled production native-tool-error.js");
const { nativeToolErrorText } = await import(pathToFileURL(process.argv[2]).href);
const combined = "ordinary stdout\nactual diagnostic stderr\n";
const job = (streams, extra = {}) => ({
  content: [{ type: "text", text: combined }],
  isError: true,
  details: {
    action: "wait",
    job_id: `job-${"a".repeat(24)}`,
    status: "failed",
    exit_code: 1,
    streams,
    ...extra,
  },
});

test("failed jobs show captured stderr rather than duplicate combined output, live/history helper leaves result intact", () => {
  const result = job({
    available: true,
    stdout: "ordinary stdout\n",
    stderr: "actual diagnostic stderr\n",
  });
  const before = structuredClone(result);
  assert.equal(nativeToolErrorText(result, "background_job"), "actual diagnostic stderr");
  assert.deepEqual(result, before);
});

test("empty stderr and unavailable legacy/adopted capture use explicit failure fallback, never combined text", () => {
  for (const streams of [
    undefined,
    { available: false, reason: "legacy-or-adopted-job" },
    { available: true, stdout: combined, stderr: "" },
  ]) {
    assert.equal(nativeToolErrorText(job(streams), "background_job"), "Job exited with code 1");
  }
  assert.equal(
    nativeToolErrorText(job(undefined, { exit_code: null, signal: "SIGTERM" }), "background_job"),
    "Job terminated by SIGTERM",
  );
});

test("other tool failures keep their literal diagnostic and do not interpret job-shaped payloads", () => {
  assert.equal(
    nativeToolErrorText(job({ available: true, stderr: "stderr only" }), "another_tool"),
    combined,
  );
  assert.equal(nativeToolErrorText("permission denied", "background_job"), "permission denied");
});
