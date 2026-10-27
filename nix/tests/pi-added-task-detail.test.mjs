import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

// Compile the *production* reducer and card, not a reimplementation of their
// logic. The tiny host below substitutes RN primitives/hooks; it executes the
// real card's onToggle and renderDetails callbacks without a browser/Expo.
const root = process.env.PASEO_INSTALL;
if (!root) throw new Error("Set PASEO_INSTALL to the compiled Paseo tree");
const source = process.env.PASEO_SOURCE ?? root;
const { default: ts } = await import(
  pathToFileURL(
    join(process.env.TYPESCRIPT_PATH ?? join(root, "node_modules/typescript"), "lib/typescript.js"),
  )
);
const { createPiExtensionHost } = await import(
  pathToFileURL(
    join(root, "packages/server/dist/server/server/agent/providers/pi/extensions/index.js"),
  )
);
function compileDeclarations(file, names, bindings) {
  const sourceText = readFileSync(join(source, file), "utf8");
  const ast = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations = ast.statements.filter((node) => {
    if (node.name && names.includes(node.name.text)) return true;
    return (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) => names.includes(d.name.getText(ast)))
    );
  });
  assert.equal(declarations.length, names.length, `Production declarations missing in ${file}`);
  const code =
    declarations.map((node) => node.getText(ast)).join("\n") +
    `\nexports.selected = {${names.join(",")}};`;
  const compiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const context = { exports: {}, ...bindings };
  vm.runInNewContext(compiled, context, { filename: file });
  return context.exports.selected;
}
const { appendTodoList } = compileDeclarations(
  "packages/app/src/types/stream.ts",
  [
    "simpleHash",
    "createTimelineId",
    "createUniqueTimelineId",
    "appendTodoList",
    "taskStatus",
    "taskKey",
    "deriveTaskActivities",
  ],
  {},
);
function mountCard(initialProps) {
  let state = false;
  let props = initialProps;
  const { TodoListCard } = compileDeclarations(
    "packages/app/src/components/message.tsx",
    ["taskActivityIcon", "TodoListCard"],
    {
      React: {
        createElement: (type, elementProps, ...children) => ({
          type,
          props: elementProps ?? {},
          children: children.flat(),
        }),
      },
      memo: (fn) => fn,
      useTranslation: () => ({ t: (key) => key }),
      useState: () => [
        state,
        (update) => {
          state = typeof update === "function" ? update(state) : update;
        },
      ],
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      View: "View",
      Text: "Text",
      TaskListRow: "TaskListRow",
      ExpandableBadge: "ExpandableBadge",
      Plus: "Plus",
      CircleDot: "CircleDot",
      Check: "Check",
      CheckSquare: "CheckSquare",
      todoListCardStylesheet: { detailsWrapper: {}, list: {}, emptyText: {} },
    },
  );
  return {
    render: () => TodoListCard(props),
    update: (next) => {
      props = next;
    },
    click() {
      const badge = this.render();
      badge.props.onToggle();
      return this.render();
    },
    details() {
      const badge = this.render();
      return badge.props.isExpanded ? badge.props.renderDetails() : null;
    },
  };
}
function nodes(tree) {
  return tree && typeof tree === "object" ? [tree, ...tree.children.flatMap(nodes)] : [];
}
function text(tree) {
  if (tree == null) return "";
  if (typeof tree !== "object") return String(tree);
  return tree.children.map(text).join("");
}
const step = (id, title, status = "pending") => ({ id, text: title, status });
function pipeline() {
  const host = createPiExtensionHost();
  let state = [];
  let tick = 0;
  return {
    get state() {
      return state;
    },
    update(steps, goalId = "goal-one") {
      const result = {
        details: { version: 5, goalId, steps },
        content: [{ type: "text", text: "Machine report is unchanged" }],
      };
      const before = JSON.stringify(result);
      const events = host.mapToolCall({
        callId: `progress-${++tick}`,
        toolName: "update_progress",
        args: { steps },
        status: "completed",
        result,
      }).events;
      const todo = events.find((e) => e.type === "timeline" && e.item.type === "todo").item;
      assert.equal(JSON.stringify(result), before, "machine-facing results are untouched");
      state = appendTodoList(state, "pi", todo.items, new Date(tick));
      return todo;
    },
  };
}
function assertTitleOnly(card, title) {
  assert.equal(card.render().type, "ExpandableBadge");
  assert.equal(card.render().props.secondaryLabel, title);
  const details = card.details();
  assert.equal(text(details), title);
  assert.deepEqual(
    nodes(details).map((n) => n.type),
    ["View", "Text"],
    "no checklist rows, status controls, or machine detail",
  );
  assert.equal(
    nodes(details)[1].props.numberOfLines,
    undefined,
    "full title must not be truncated",
  );
}

test("real mapper → reducer → Added click renders only the immutable individual full title", () => {
  const p = pipeline();
  const original = step("first", "Existing task", "in_progress");
  p.update([original]);
  const title =
    "Simplify all harness output families… punctuation: < > & \" ' ;\nSecond line\n" +
    "Full title, not a truncated label. ".repeat(80);
  const added = step("second", title);
  const todo = p.update([original, added]);
  assert.equal(todo.items.length, 2, "native checklist retains all tasks");
  const historic = p.state.find((item) => item.activity.type === "added");
  assert.equal(historic.activity.task, title);
  const card = mountCard(historic);
  assert.equal(card.details(), null);
  assert.equal(card.click().props.isExpanded, true);
  assertTitleOnly(card, title);
  assert.equal(card.click().props.isExpanded, false);
  assert.equal(card.details(), null);
  card.click();

  const later = p.update([
    step("first", "Existing task", "completed"),
    step("second", "Renamed later"),
    step("third", "Later addition"),
    step("fourth", "Another later task"),
  ]);
  assert.equal(later.items.length, 4);
  card.update({ ...historic, items: later.items }); // Even a live-list prop must not leak.
  assertTitleOnly(card, title);
  p.update([]);
  p.update([step("other", "Other goal task")], "other-goal");
  assertTitleOnly(card, title);
  const replay = mountCard(JSON.parse(JSON.stringify(historic)));
  replay.click();
  assertTitleOnly(replay, title);
});

test("multiple Added rows each own their exact title and do not show siblings", () => {
  const p = pipeline();
  const initial = step("initial", "Initial", "in_progress");
  p.update([initial]);
  const titles = ["Task A: punctuation;\nnew line", "Task B — different <title>"];
  p.update([initial, ...titles.map((title, i) => step(`added-${i}`, title))]);
  const rows = p.state.filter((item) => item.activity.type === "added");
  assert.equal(rows.length, 2);
  rows.forEach((row, i) => {
    const card = mountCard(row);
    card.click();
    assertTitleOnly(card, titles[i]);
  });
  const card = mountCard(rows[0]);
  card.click();
  card.update(rows[1]);
  assertTitleOnly(card, titles[1]); // callback follows the activity prop, not stale title
});

test("blocked Added preserves only its immutable native full title, including native prefix", () => {
  const p = pipeline();
  const initial = step("initial", "Original", "in_progress");
  p.update([initial]);
  const title = "Needs approval;\nkeep punctuation <intact>";
  p.update([initial, step("blocked", title, "blocked")]);
  const row = p.state.find((item) => item.activity.type === "added");
  const card = mountCard(row);
  card.click();
  assertTitleOnly(card, `Blocked · ${title}`);
  const later = p.update([
    initial,
    step("blocked", "Later rename", "pending"),
    step("later", "Unrelated"),
  ]);
  card.update({ ...row, items: later.items });
  assertTitleOnly(card, `Blocked · ${title}`);
});

test("other native activities keep their list rows, icons, and expandable controls", () => {
  const p = pipeline();
  p.update([step("first", "Original", "in_progress"), step("blocked", "Blocked title", "blocked")]);
  p.update([step("first", "Original", "completed"), step("blocked", "Blocked title", "pending")]);
  p.update([
    step("first", "Original", "completed"),
    step("blocked", "Blocked title", "in_progress"),
  ]);
  const rows = p.state.filter((item) => item.activity.type !== "added");
  assert.ok(rows.some((row) => row.activity.type === "created"));
  assert.ok(rows.some((row) => row.activity.type === "completed"));
  assert.ok(rows.some((row) => row.activity.type === "started"));
  for (const row of rows) {
    const before = JSON.stringify(row);
    const card = mountCard(row);
    card.click();
    const taskRows = nodes(card.details()).filter((n) => n.type === "TaskListRow");
    assert.equal(taskRows.length, row.items.length);
    assert.deepEqual(
      taskRows.map((n) => n.props.task),
      Array.from(row.items),
    );
    assert.equal(JSON.stringify(row), before);
    assert.equal(card.click().props.isExpanded, false);
  }
});
