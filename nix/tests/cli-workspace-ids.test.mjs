// v0.8 removed the lossy terminal row mapper; retain an executable regression
// before dropping its downstream patch. Never connects to a live daemon.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const terminal = path.join(process.env.PASEO_INSTALL, "packages/cli/dist/commands/terminal");
test("CLI terminal list preserves workspace identity without a downstream mapper", async (t) => {
  const row = { id: "trm_tmux_test", name: "shell", cwd: "/same", workspaceId: "wks_tmux_test" };
  let closed = false;
  t.mock.module(pathToFileURL(path.join(terminal, "shared.js")).href, {
    namedExports: {
      connectTerminalClient: async () => ({
        client: {
          terminals: {
            list: async (args) => {
              assert.equal(args.workspaceId, row.workspaceId);
              return { entries: [row] };
            },
          },
        },
        close: async () => {
          closed = true;
        },
      }),
      toTerminalCommandError: () => assert.fail("unexpected list error"),
    },
  });
  const { runLsCommand } = await import(pathToFileURL(path.join(terminal, "ls.js")).href);
  const result = await runLsCommand({ workspace: row.workspaceId }, {});
  assert.deepEqual(result.data, [row]);
  assert.equal(closed, true);
  assert.ok(result.schema.columns.some((column) => column.field === "workspaceId"));
});
