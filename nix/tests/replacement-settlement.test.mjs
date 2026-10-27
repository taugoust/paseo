import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { AgentManager } = await import(pathToFileURL(process.argv[2]).href);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixture(provider, interruption = Promise.resolve()) {
  const terminal = deferred();
  const run = { token: "original-run", settled: false, settledPromise: terminal.promise };
  let current = run,
    interrupts = 0,
    deadlines = 0;
  const errors = [];
  const agent = {
    provider,
    lifecycle: "running",
    session: {
      interrupt: () => {
        interrupts++;
        return interruption;
      },
    },
  };
  const manager = Object.create(AgentManager.prototype);
  Object.assign(manager, {
    requireSessionAgent: () => agent,
    hasInFlightRun: () => Boolean(current && !current.settled),
    runs: {
      getRun: () => current,
      trackAutonomousRun: () => assert.fail("unexpected new autonomous run"),
    },
    runInterrupts: new WeakMap(),
    rescueTimeouts: { interruptSessionMs: 2000 },
    waitWithTimeout: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, 2000);
      deadlines++;
      return "timed_out";
    },
    logger: { error: (...args) => errors.push(args) },
  });
  return {
    manager,
    run,
    errors,
    get interrupts() {
      return interrupts;
    },
    get deadlines() {
      return deadlines;
    },
    settle() {
      run.settled = true;
      current = null;
      agent.lifecycle = "idle";
      terminal.resolve();
    },
    successor() {
      current = { token: "successor", settled: false, settledPromise: deferred().promise };
      agent.lifecycle = "running";
    },
  };
}

for (const provider of ["pi", "codex", "claude"]) {
  test(`${provider}: replacement stays pending after acknowledgment until the real old terminal`, async () => {
    const f = fixture(provider);
    let admitted = false,
      failure;
    const replacement = f.manager.cancelAgentRunBefore("agent", "replace").then(
      () => {
        admitted = true;
        return undefined;
      },
      (e) => {
        failure = e;
        return undefined;
      },
    );
    await tick();
    await tick();
    assert.equal(f.interrupts, 1);
    assert.equal(f.deadlines, 0, "a user send must not use Stop's two-second response deadline");
    assert.equal(admitted, false);
    assert.equal(failure, undefined);
    assert.equal(f.run.settled, false);
    f.settle();
    await replacement;
    assert.equal(failure, undefined);
    assert.equal(admitted, true);
  });
}

test("replacement can settle before a late interrupt acknowledgment without blocking a successor", async () => {
  const interruption = deferred(),
    f = fixture("pi", interruption.promise);
  const pending = f.manager.cancelAgentRunBefore("agent", "replace");
  await tick();
  f.settle();
  await pending;
  f.successor();
  interruption.resolve();
  await tick();
  assert.equal(f.interrupts, 1);
});

test("the real replacement method admits the new prompt exactly once, after settlement", async () => {
  const f = fixture("pi");
  let started = 0;
  f.manager.requireAgent = f.manager.requireSessionAgent;
  f.manager.touchUpdatedAt = () => {};
  f.manager.emitState = () => {};
  f.manager.streamAgent = (id, prompt, options) => {
    assert.equal(id, "agent");
    assert.equal(prompt, "Works great");
    assert.equal(options.clientMessageId, "once");
    assert.equal(f.run.settled, true);
    started++;
    return (async function* () {})();
  };
  const replacement = f.manager.replaceAgentRun("agent", "Works great", {
    clientMessageId: "once",
  });
  await tick();
  assert.equal(started, 0);
  f.settle();
  await replacement;
  assert.equal(started, 1);
});

test("real settlement wins a racing late provider failure, which remains logged", async () => {
  const interruption = deferred(),
    f = fixture("pi", interruption.promise);
  const pending = f.manager.cancelAgentRunBefore("agent", "replace");
  await tick();
  f.settle();
  interruption.reject(new Error("late old-run failure"));
  await pending;
  await tick();
  assert.equal(f.errors.length, 1);
});

test("late interrupt failure rejects a pending replacement instead of silently starting it", async () => {
  const interruption = deferred(),
    f = fixture("pi", interruption.promise);
  const pending = f.manager.cancelAgentRunBefore("agent", "replace");
  const rejected = assert.rejects(pending, /interrupt failed.*provider refused/);
  await tick();
  interruption.reject(new Error("provider refused"));
  await rejected;
  assert.equal(f.run.settled, false);
  assert.equal(f.errors.length, 1);
  f.settle();
});

test("concurrent/repeated Stop remains bounded and shares one interrupt with pending replacement", async () => {
  const interruption = deferred(),
    f = fixture("pi", interruption.promise);
  const pending = f.manager.cancelAgentRunBefore("agent", "replace");
  await tick();
  assert.deepEqual(await f.manager.cancelAgentRun("agent"), { status: "in_progress" });
  assert.deepEqual(await f.manager.cancelAgentRun("agent"), { status: "in_progress" });
  assert.equal(f.interrupts, 1);
  assert.equal(f.deadlines, 2);
  assert.equal(f.run.settled, false);
  f.settle();
  await pending;
  interruption.resolve();
});

for (const action of ["reload", "rewind", "archive"]) {
  test(`${action} retains bounded fail-closed cancellation, unlike a queued replacement`, async () => {
    const interruption = deferred(),
      f = fixture("pi", interruption.promise);
    await assert.rejects(
      f.manager.cancelAgentRunBefore("agent", action),
      /cancellation is still in progress/,
    );
    assert.equal(f.deadlines, 1);
    assert.equal(f.run.settled, false);
    f.settle();
    interruption.resolve();
  });
}

test("an old cancellation cannot dispatch its interrupt into an already-admitted successor", async () => {
  const f = fixture("pi");
  const pending = f.manager.cancelAgentRun("agent", true);
  f.settle();
  f.successor();
  assert.deepEqual(await pending, { status: "settled" });
  assert.equal(f.interrupts, 0);
});
