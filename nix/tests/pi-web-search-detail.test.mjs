import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mapperPath = process.argv[2];
if (!mapperPath)
  throw new Error("usage: node pi-web-search-detail.test.mjs <compiled-tool-call-mapper.js>");
const { mapToolDetail, parseToolArgs, parseToolResult } = await import(
  pathToFileURL(resolve(mapperPath))
);
const args = parseToolArgs("web_search", { query: "literal query" });
const raw = {
  structuredContent: {
    query: "server-side query is metadata; input remains canonical query",
    results: [
      {
        tool_use_id: "tu_1",
        content: [{ title: "Exact title", url: "not-rewritten://literal", vendorField: 0 }],
      },
      'Provider annotation: exact punctuation; {"not":"parsed"}',
    ],
    durationSeconds: 0,
    futureMetadata: { retainedByOriginal: true },
  },
  content: [{ type: "text", text: 'Literal response text: {"keep": true}' }],
};
const original = structuredClone(raw);
const parsed = parseToolResult(raw);
const detail = mapToolDetail(args, parsed);
assert.equal(detail.type, "search");
assert.equal(detail.query, "literal query");
assert.deepEqual(detail.webResults, [{ title: "Exact title", url: "not-rewritten://literal" }]);
assert.deepEqual(detail.annotations, ['Provider annotation: exact punctuation; {"not":"parsed"}']);
assert.equal(detail.durationSeconds, 0);
assert.deepEqual(parsed.structuredContent.futureMetadata, { retainedByOriginal: true });
assert.deepEqual(raw, original, "presentation must not mutate the original result");
assert.equal(
  Object.hasOwn(detail, "structuredContent"),
  false,
  "do not invent fields the native wire schema drops",
);
assert.equal(detail.content, 'Literal response text: {"keep": true}');
// Unsupported/heterogeneous variants must not be partially projected as native hits.
const malformed = parseToolResult({
  structuredContent: {
    query: "q",
    durationSeconds: 1,
    results: [{ tool_use_id: "tu_2", content: [{ title: "missing URL" }] }],
  },
  content: [{ type: "text", text: "unchanged malformed result text" }],
});
const fallback = mapToolDetail(args, malformed);
assert.equal(fallback.webResults, undefined);
assert.equal(fallback.annotations, undefined);
assert.equal(fallback.content, "unchanged malformed result text");
// Text-only output containing JSON-looking content is never interpreted.
const textual = mapToolDetail(
  args,
  parseToolResult('{"results":[{"title":"fake","url":"https://example.invalid"}]}'),
);
assert.equal(textual.content, '{"results":[{"title":"fake","url":"https://example.invalid"}]}');
assert.equal(textual.webResults, undefined);
console.log("Pi web-search structured detail tests passed");
