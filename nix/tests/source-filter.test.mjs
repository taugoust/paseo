import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = process.env.PASEO_SOURCE ?? fileURLToPath(new URL("../..", import.meta.url));
const packageFilter = readFileSync(join(root, "nix/package.nix"), "utf8");
const expected = [
  "packages/server/src/server/agent/providers/pi/agent.test.ts",
  "packages/server/src/server/agent/providers/pi/cli-runtime.test.ts",
  "packages/server/src/server/agent/providers/pi/tool-result-images.test.ts",
  "packages/server/src/server/agent/providers/pi/usage-lifecycle.test.ts",
  "plugins/codex-usage-source/server/stores.test.ts",
  "plugins/codex-usage-source/server/usage.test.ts",
  "nix/copy-highlight-licenses.mjs",
  "nix/tests/highlight-licenses.test.mjs",
  "nix/tests/plugin-hermes-classes.test.mjs",
  "nix/tests/testfixtures/compact-harness-showcase.json",
];
test("Nix build source retains fork-owned checks and focused TypeScript suites", () => {
  for (const file of expected)
    assert.ok(existsSync(join(root, file)), `filtered build source must include ${file}`);
  assert.match(packageFilter, /hasSuffix "\.e2e\.test\.ts"/);
  assert.doesNotMatch(packageFilter, /hasSuffix "\.test\.ts"/);
  for (const excluded of ["node_modules", ".npm-logs", ".git", ".paseo", ".DS_Store"]) {
    assert.ok(
      packageFilter.includes(`baseName != "${excluded}"`),
      `source filter must exclude ${excluded}`,
    );
  }
});
