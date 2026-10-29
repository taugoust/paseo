import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(
  process.env.PASEO_PLUGIN_COMPILER || process.env.PASEO_INSTALL,
  "PASEO_INSTALL or PASEO_PLUGIN_COMPILER required",
);
const compiler =
  process.env.PASEO_PLUGIN_COMPILER ??
  join(process.env.PASEO_INSTALL, "packages/server/dist/server/server/plugins/compiler.js");
const { compilePlugin } = await import(pathToFileURL(compiler));
const { piPresentationPurityError } = await import(
  new URL("./compiler-build.js", pathToFileURL(compiler))
);
const require = createRequire(compiler);
const load = (specifier) => import(pathToFileURL(require.resolve(specifier)));
const generic = await load("@getpaseo/protocol/generic-tool-presentation");
const paseo = await load("@getpaseo/protocol/paseo-tool-presentation/index");
const native = await load("@getpaseo/server/pi-tool-presentation");
const display = await load("@getpaseo/protocol/tool-call-display");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bundled-tool-presentation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["client", "server", "shared"]) await mkdir(join(root, dir));
  return root;
}

test("native public mapper and display helpers bundle into both targets without new host modules", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "shared", "presentation.ts"),
    `import { buildGenericToolSections, buildGenericToolDisplay } from "@getpaseo/protocol/generic-tool-presentation";
import { buildPaseoToolDetailSections, buildPaseoToolDisplay } from "@getpaseo/protocol/paseo-tool-presentation/index";
import {mapToolDetail,parseToolArgs,parseToolResult} from "@getpaseo/server/pi-tool-presentation";
import {buildToolCallDisplayModel} from "@getpaseo/protocol/tool-call-display";
export function present(name, input, output) {
 const unknown = {type:"unknown", input, output};
 const detail=mapToolDetail(parseToolArgs(name,input),parseToolResult(output));
 return { sections: buildPaseoToolDetailSections(name,input,output) ?? buildGenericToolSections(name,input,output), display: buildPaseoToolDisplay({toolName:name,detail:unknown}) ?? buildGenericToolDisplay(name,unknown), native:{detail,display:buildToolCallDisplayModel({name,detail,status:"completed",error:null})} };
}`,
  );
  for (const target of ["client", "server"])
    await writeFile(
      join(root, `index.${target}.ts`),
      'export { present } from "./shared/presentation";',
    );
  const bundles = await compilePlugin({
    client: join(root, "index.client.ts"),
    server: join(root, "index.server.ts"),
  });
  const cases = [
    [
      "subagent",
      { operation: "prompt", message: "Review the real output" },
      { content: [{ type: "text", text: "Accepted" }], details: { receipt: "accepted" } },
    ],
    [
      "fetch",
      { url: "https://example.test" },
      { content: [{ type: "text", text: '{"literal":"JSON response"}' }] },
    ],
    [
      "goal_manage",
      { action: "status" },
      {
        content: [{ type: "text", text: "machine output" }],
        details: { presentation: { version: 1, tool: "goal_manage", objective: "Review parity" } },
      },
    ],
    [
      "mcp__paseo__send_agent_prompt",
      { agentId: "agent", prompt: "Hello" },
      { content: [{ type: "text", text: "Sent" }] },
    ],
    [
      "read",
      { path: "example.ts", offset: 41 },
      { content: [{ type: "text", text: "const value = 1;" }] },
    ],
  ];
  for (const [target, code] of Object.entries(bundles)) {
    assert.ok(code);
    const required = [];
    const compiled = (0, eval)(code)((name) => {
      required.push(name);
      assert.equal(name, "zod", "only existing public zod host dependency is allowed");
      return require(name);
    });
    for (const [name, input, output] of cases) {
      const unknown = { type: "unknown", input, output };
      const detail = native.mapToolDetail(
        native.parseToolArgs(name, input),
        native.parseToolResult(output),
      );
      assert.deepEqual(compiled.present(name, input, output), {
        sections:
          paseo.buildPaseoToolDetailSections(name, input, output) ??
          generic.buildGenericToolSections(name, input, output),
        display:
          paseo.buildPaseoToolDisplay({ toolName: name, detail: unknown }) ??
          generic.buildGenericToolDisplay(name, unknown),
        native: {
          detail,
          display: display.buildToolCallDisplayModel({
            name,
            detail,
            status: "completed",
            error: null,
          }),
        },
      });
    }
    assert.ok(!required.some((name) => name.startsWith("@getpaseo/")));
    if (target === "clientBundle" && process.env.HERMESC) {
      const source = join(root, "emitted-client.js"),
        bytecode = join(root, "emitted-client.hbc");
      await writeFile(source, code);
      execFileSync(process.env.HERMESC, ["-emit-binary", "-out", bytecode, source], {
        stdio: "pipe",
      });
      assert.ok((await stat(bytecode)).size > 0);
    }
  }
});

test("reachable subagent adapter presentation is pure and preserves native running/failure/managed precedence", () => {
  for (const result of [null, "  failure text\\n"]) {
    const detail = native.mapPiToolCallDetail(
      native.parseToolArgs("subagent", { agent: " worker ", task: " task body\\nnext line " }),
      result,
      "call",
    );
    assert.deepEqual(detail, {
      type: "sub_agent",
      subAgentType: "worker",
      description: "task body\\nnext line",
      log: typeof result === "string" ? result.trim() : "",
    });
  }
  const input = { agent: "worker", task: "Task" },
    result = { content: [{ type: "text", text: "managed" }], details: { tui_subagent: true } };
  assert.deepEqual(
    native.mapPiToolCallDetail(native.parseToolArgs("subagent", input), result, "call"),
    native.mapToolDetail(native.parseToolArgs("subagent", input), result),
  );
  assert.deepEqual(
    native.mapPiToolCallDetail(
      native.parseToolArgs("subagent", input),
      null,
      "call::paseo-child::1",
    ),
    native.mapToolDetail(native.parseToolArgs("subagent", input), null),
  );
});

test("pure mapper boundary rejects ambient I/O and dynamic loading", () => {
  assert.equal(
    piPresentationPurityError("export function map(value){return JSON.stringify(value)}"),
    null,
  );
  for (const source of [
    "export const value=process.env.TOKEN",
    'export const value=globalThis.fetch("https://invalid")',
    'export const value=require("node:fs")',
    'export const value=import("./credentials.js")',
    'export const value=Buffer.from("secret")',
  ])
    assert.ok(piPresentationPurityError(source), source);
});

test("exact aliases do not open server internals, protocol traversal or weaken transitive shared boundaries", async (t) => {
  const root = await fixture(t);
  const entry = join(root, "index.client.ts");
  for (const specifier of [
    "@getpaseo/protocol/agent-types",
    "@getpaseo/protocol/generic-tool-presentation/private",
    "@getpaseo/protocol/paseo-tool-presentation/index/../../agent-types",
    "@getpaseo/server",
    "@getpaseo/server/daemon-control",
    "@getpaseo/server/pi-tool-presentation/../credentials",
    "@getpaseo/server/pi-tool-presentation/private-transport",
  ]) {
    await writeFile(
      entry,
      `import * as hidden from ${JSON.stringify(specifier)}; export function probe() { return hidden; }`,
    );
    await assert.rejects(compilePlugin({ client: entry, server: null }), undefined, specifier);
  }
  await writeFile(entry, 'export { probe } from "./shared/presentation";');
  await writeFile(
    join(root, "shared", "presentation.ts"),
    'import {mapToolDetail,parseToolArgs} from "@getpaseo/server/pi-tool-presentation"; import {readFileSync} from "node:fs"; export function probe() { return mapToolDetail(parseToolArgs("read",{}),readFileSync("secret","utf8")); }',
  );
  await assert.rejects(
    compilePlugin({ client: entry, server: null }),
    /Node module cannot be imported/,
  );
});
