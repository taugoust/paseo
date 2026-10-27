// Exercise the shipped Pi import method with a header-only session: no models,
// credentials, live sessions or network calls. Explicit setModel stays supported.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.join(process.env.PASEO_INSTALL, "packages/server/dist/server/server/agent");
const { PiRpcAgentClient, PiRpcAgentSession } = await import(
  pathToFileURL(path.join(root, "providers/pi/agent.js"))
);

for (const descriptor of [null, { provider: "openai", modelId: "stale-model" }]) {
  test(`Pi import preserves live selection, descriptor=${JSON.stringify(descriptor)}`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-import-selection-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "session.jsonl");
    const entries = [
      { type: "session", id: "child", cwd: dir, timestamp: new Date().toISOString() },
    ];
    if (descriptor)
      entries.push(
        { type: "model_change", ...descriptor },
        { type: "thinking_level_change", thinkingLevel: "low" },
      );
    await writeFile(file, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const calls = [];
    const session = {
      async *streamHistory() {},
      async getRuntimeInfo() {
        return { provider: "pi", model: "openai/gpt-6-luna", thinkingOptionId: "high" };
      },
      async close() {
        throw new Error("must not close a healthy attachment");
      },
    };
    const client = Object.create(PiRpcAgentClient.prototype);
    Object.assign(client, {
      provider: "pi",
      resumeSession: async (handle, config) => {
        calls.push({ handle, config });
        assert.equal(
          config.model,
          undefined,
          "do not request daemon/default/stale model on attachment",
        );
        assert.equal(config.thinkingOptionId, undefined);
        assert.equal(handle.metadata.model, undefined);
        assert.equal(handle.metadata.thinkingOptionId, undefined);
        return session;
      },
    });
    const defaults = { provider: "pi", cwd: dir, model: "openai/gpt-5.5", thinkingOptionId: "low" };
    const result = await client.importSession(
      { providerHandleId: file, cwd: dir },
      { config: defaults, storedConfig: defaults },
    );
    assert.equal(calls.length, 1);
    assert.equal(result.config.model, "openai/gpt-6-luna");
    assert.equal(result.config.thinkingOptionId, "high");
    assert.equal(result.persistence.metadata.model, "openai/gpt-6-luna");
    assert.equal(result.persistence.metadata.thinkingOptionId, "high");
    assert.equal(defaults.model, "openai/gpt-5.5", "caller config must not be mutated");
  });
}

test("explicit user model changes still reach the runtime", async () => {
  const calls = [];
  const model = { provider: "openai", id: "requested-model" };
  const session = Object.create(PiRpcAgentSession.prototype);
  Object.assign(session, {
    runtimeSession: {
      async setModel(provider, id) {
        calls.push([provider, id]);
        return model;
      },
    },
    state: {},
    config: {},
    refreshState: async () => {},
    refreshThinkingState: async () => {},
    usagePoller: { refreshIdle: async () => {} },
  });
  await session.setModel("openai/requested-model");
  assert.deepEqual(calls, [["openai", "requested-model"]]);
});
