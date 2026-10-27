import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
const root = process.env.PASEO_INSTALL;
const sourceRoot = process.env.PASEO_SOURCE ?? root;
if (!root || !sourceRoot) throw new Error("Set PASEO_INSTALL and optionally PASEO_SOURCE");
const require = createRequire(import.meta.url);
const ts = require(process.env.TYPESCRIPT_PATH ?? join(root, "node_modules/typescript"));
const source = await readFile(
  join(sourceRoot, "packages/app/src/components/tool-call-details.tsx"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const context = vm.createContext({ console });
const jsx = (type, props) => ({ type, props: props ?? {} });
const memo = (f) => f();
let theme = {
  spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
  fontSize: { sm: 12, base: 14, content: 15 },
  fontWeight: { normal: "normal", medium: "500", semibold: "600" },
  borderWidth: { 1: 1 },
  colors: { foreground: "#eeeeee", foregroundMuted: "#999999", border: "#333333" },
};
const nativeTheme = () =>
  new Proxy(theme, { get: (target, key) => target[key] ?? new Proxy({}, { get: () => 16 }) });
const generic = await import(
  pathToFileURL(join(root, "packages/protocol/dist/generic-tool-presentation.js"))
);
const native = await import(
  pathToFileURL(join(root, "packages/protocol/dist/paseo-tool-presentation/index.js"))
);
const mocks = {
  react: { default: {}, useMemo: memo },
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": { View: "View", Text: "Text", ScrollView: "ScrollView" },
  "react-native-gesture-handler": { ScrollView: "ScrollView" },
  "react-native-unistyles": {
    StyleSheet: { create: (f) => new Proxy({}, { get: (_target, key) => f(nativeTheme())[key] }) },
  },
  "react-i18next": { useTranslation: () => ({ t: (x) => x }) },
  "@getpaseo/protocol/generic-tool-presentation": generic,
  "@getpaseo/protocol/paseo-tool-presentation/index": native,
  "@/utils/tool-call-parsers": { buildLineDiff: () => [], parseUnifiedDiff: () => [] },
  "@/utils/diff-highlight": { highlightDiffLines: (x) => x },
  "@/styles/unistyles-inline-style": { inlineUnistylesStyle: (x) => x },
  "@/styles/code-surface": { CODE_SURFACE_DATASET: {} },
  "@/utils/highlight-cache": { extensionFromPath: () => "", highlightToKeyedLines: () => [] },
  "./highlighted-content": { HighlightedLines: "HighlightedLines" },
  "./diff-viewer": { DiffViewer: "DiffViewer" },
  "./code-insets": { getCodeInsets: () => ({ horizontal: 0, vertical: 0 }) },
  "@/constants/platform": { isWeb: true },
};
const module = new vm.SourceTextModule(compiled, {
  context,
  identifier: "production-tool-call-details",
});
await module.link(async (name) => {
  const exports = mocks[name];
  if (!exports) throw new Error(`Unexpected production dependency: ${name}`);
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    },
    { context },
  );
});
await module.evaluate();
const { ToolCallDetailsContent } = module.namespace;
function render(element, nodes = []) {
  if (element === null || element === undefined || element === false) return "";
  if (Array.isArray(element)) return element.map((e) => render(e, nodes)).join("");
  if (typeof element !== "object") return String(element);
  if (typeof element.type === "function") return render(element.type(element.props), nodes);
  nodes.push(element);
  return render(element.props.children, nodes);
}
test("production expanded generic component uses readable fields within bounded scroll area", () => {
  const nodes = [];
  const text = render(
    ToolCallDetailsContent({
      toolName: "future_tool",
      maxHeight: 240,
      detail: {
        type: "unknown",
        input: { question_text: "What next?", choices: ["Review", "Ship"] },
        output: { complete: false, count: 0, future: "retained" },
      },
    }),
    nodes,
  );
  assert.match(text, /Question textWhat next\?/);
  assert.match(text, /Choices• Review\n• Ship/);
  assert.match(text, /CompleteNoCount0Futureretained/);
  assert.doesNotMatch(text, /"question_text"|\{"complete"/);
  const scroll = nodes.find((n) => n.type === "ScrollView");
  assert.ok(scroll);
  assert.ok(scroll.props.style.some((s) => s?.maxHeight === 240));
});
test("production expanded native helper keeps future metadata and prose", () => {
  const text = render(
    ToolCallDetailsContent({
      toolName: "mcp__paseo__list_agents",
      detail: {
        type: "unknown",
        input: { all: true },
        output: {
          content: [{ type: "text", text: "Human report\ntrace; unchanged" }],
          structuredContent: { agents: [] },
          future: "useful",
        },
      },
    }),
  );
  assert.match(text, /Human report\ntrace; unchanged/);
  assert.match(text, /Futureuseful/);
});
test("native compact harness section has no empty header and uses host spacing", () => {
  const nodes = [];
  const text = render(
    ToolCallDetailsContent({
      toolName: "background_job",
      detail: {
        type: "unknown",
        input: { action: "status" },
        output: {
          content: [{ type: "text", text: "Build is running" }],
          details: { name: "Build preview", status: "running" },
        },
      },
    }),
    nodes,
  );
  assert.match(text, /Build preview/);
  assert.ok(
    !nodes.some((n) => n.type === "Text" && n.props.children === ""),
    "no blank section heading",
  );
  const section = nodes.find(
    (n) =>
      n.type === "View" &&
      n.props.style?.paddingHorizontal === 12 &&
      n.props.style?.borderBottomWidth === 1,
  );
  assert.ok(section, "native 12px section inset");
  assert.equal(section.props.style.gap, 8);
});
test("production detail fields wrap at narrow widths and follow both native theme palettes", () => {
  const original = theme;
  try {
    for (const colors of [
      original.colors,
      { foreground: "#202020", foregroundMuted: "#666666", border: "#dddddd" },
    ]) {
      theme = { ...original, colors };
      const nodes = [];
      const text = render(
        ToolCallDetailsContent({
          toolName: "future_tool",
          detail: {
            type: "unknown",
            input: null,
            output: { description: "Preserve this exact payload; no truncation" },
          },
        }),
        nodes,
      );
      assert.match(text, /Preserve this exact payload; no truncation/);
      const row = nodes.find((n) => n.type === "View" && n.props.style?.flexWrap === "wrap");
      assert.ok(row, "field row can wrap instead of squeezing the value");
      assert.equal(row.props.style.columnGap, 12);
      assert.equal(row.props.style.rowGap, 4);
      const label = nodes.find((n) => n.type === "Text" && n.props.children === "Description");
      assert.equal(label.props.style.color, colors.foregroundMuted);
      assert.equal(label.props.style.flexBasis, 96);
      const value = nodes.find(
        (n) =>
          n.type === "Text" &&
          n.props.selectable &&
          typeof n.props.children === "string" &&
          n.props.children.includes("Preserve this exact"),
      );
      assert.equal(value.props.style.color, colors.foreground);
      assert.equal(value.props.style.flexBasis, 160);
      assert.equal(value.props.style.minWidth, 0);
    }
  } finally {
    theme = original;
  }
});
test("production canonical shell and error rendering are not reformatted", () => {
  const text = render(
    ToolCallDetailsContent({
      toolName: "bash",
      detail: { type: "shell", command: 'printf "a;b"', output: '{"payload":"preserved;"}' },
      errorText: "Traceback\nunchanged; punctuation",
    }),
  );
  assert.match(text, /printf "a;b"/);
  assert.match(text, /\{"payload":"preserved;"\}/);
  assert.match(text, /Traceback\nunchanged; punctuation/);
});
