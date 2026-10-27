import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { compilePlugin } = await import(pathToFileURL(process.argv[2]));
const root = await mkdtemp(join(tmpdir(), "paseo-native-compiler-"));
try {
  await mkdir(join(root, "client"));
  // Cross Babel's automatic compact threshold: preserve the existing Hermes
  // eager named-import correction even when class lowering reformats the code.
  const source =
    'import {View,Text} from "react-native"; var from=1,key=2; export const collision=[from,key]; class NativeOnlyProbe extends Error {} export default function(){return [View,Text,new NativeOnlyProbe("native")]} export const padding=' +
    JSON.stringify("x".repeat(500001)) +
    ";";
  const entry = join(root, "client/index.tsx");
  await writeFile(entry, source);
  const { clientBundle } = await compilePlugin({ client: entry, server: null });
  assert.doesNotMatch(clientBundle, /\bclass\s+(?:extends|NativeOnlyProbe)/);
  assert.doesNotMatch(clientBundle, /get:\s*\(\)\s*=>\s*from\d*\[key\d*\]/);
  const view = {},
    text = {};
  const module = (0, eval)(clientBundle)((name) => {
    assert.equal(name, "react-native");
    return { View: view, Text: text };
  });
  const result = module.default();
  assert.equal(result[0], view);
  assert.equal(result[1], text);
  assert.ok(result[2] instanceof Error);
  assert.equal(result[2].message, "native");
  await writeFile(
    entry,
    `import { highlightDiffLines } from "@getpaseo/highlight";
import type { HighlightDiffLine } from "@getpaseo/highlight";
export default function () {
  const lines: HighlightDiffLine[] = [{ type: "add", content: "+const value = 1;" }];
  return highlightDiffLines(lines, "example.ts")[0].tokens;
}`,
  );
  const shared = await compilePlugin({ client: entry, server: null });
  const sharedModule = (0, eval)(shared.clientBundle)((name) => {
    throw new Error(`Bundled highlighting must not require host module ${name}`);
  });
  assert.ok(sharedModule.default().some((token) => token.style === "keyword"));
  await writeFile(
    entry,
    `import * as helpers from "@getpaseo/plugin/shared";
import type * as SharedTypes from "@getpaseo/plugin/shared";
const shared: typeof SharedTypes = helpers;
export default function listHelpers() { return Object.keys(shared); }`,
  );
  const bundled = await compilePlugin({ client: entry, server: null });
  const helpersModule = (0, eval)(bundled.clientBundle)((name) => {
    throw new Error(`Bundled shared helpers must not require host module ${name}`);
  });
  assert.ok(helpersModule.default().length > 0);
  console.log(
    "PASS: native class lowering, eager host imports, bundled highlighting and shared helpers with installed declarations",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
