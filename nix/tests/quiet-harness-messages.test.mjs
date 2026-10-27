// Exercise the shipped Pi provider without starting a provider or touching tmux.
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
const { PiRpcAgentSession } = await import(
  pathToFileURL(
    path.join(
      process.env.PASEO_INSTALL,
      "packages/server/dist/server/server/agent/providers/pi/agent.js",
    ),
  ).href
);
function fixture(activeTurnStarted) {
  const session = Object.create(PiRpcAgentSession.prototype),
    events = [],
    completions = [],
    mapped = [];
  Object.assign(session, {
    activeTurnStarted,
    activeTurnId: "turn",
    pendingExtensionUiRequests: new Map(),
    provider: "pi",
    extensionHost: {
      mapCustomMessage(message) {
        mapped.push(message);
        return undefined;
      },
      mapRuntimeNotification() {
        return undefined;
      },
    },
  });
  session.emit = (event) => events.push(event);
  session.emitExtensionOutput = (output) => {
    if (output) events.push(...(output.events ?? []));
  };
  session.completeTurn = (...args) => completions.push(args);
  session.currentTurnIdForEvent = () => "turn";
  return { session, events, completions, mapped };
}
for (const active of [false, true]) {
  test(`hidden harness state emits neither assistant output nor completion (active=${active})`, () => {
    const f = fixture(active);
    f.session.handleMessageEnd(
      {
        type: "message_end",
        message: { role: "custom", display: false, content: "Internal task update" },
      },
      "turn",
    );
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.completions, []);
    assert.deepEqual(f.mapped, []);
  });
  test(`visible custom output remains visible without prematurely settling active turns (active=${active})`, () => {
    const f = fixture(active);
    f.session.handleMessageEnd(
      { type: "message_end", message: { role: "custom", display: true, content: "Report" } },
      "turn",
    );
    assert.equal(f.events[0].item.type, "tool_call");
    assert.equal(f.events[0].item.detail.text, "Report");
    assert.equal(f.mapped.length, 1);
    assert.equal(f.completions.length, active ? 0 : 1);
  });
}
test("explicit warning/error notifications remain actionable and never finish the turn", () => {
  const f = fixture(true);
  for (const level of ["warning", "error"]) {
    f.session.handleExtensionUiRequest({
      type: "extension_ui_request",
      id: level,
      method: "notify",
      message: "Attention required",
      notifyType: level,
    });
  }
  assert.deepEqual(
    f.events.map((e) => e.item),
    ["warning", "error"].map((level) => ({
      type: "notification",
      level,
      message: "Attention required",
    })),
  );
  assert.deepEqual(f.completions, []);
});
