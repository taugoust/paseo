import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Require the built production store: this regression must never silently skip.
const modulePath = process.env.PASEO_SUBAGENT_STORE_MODULE;
assert(
  modulePath,
  "PASEO_SUBAGENT_STORE_MODULE must point to the built provider-subagents/store.js",
);
const { ProviderSubagentStore } = await import(pathToFileURL(modulePath).href);

test("parent deletion clears descriptorless hides and retained history only for that parent", () => {
  const store = new ProviderSubagentStore();
  const options = { direction: "tail", limit: 100 };
  for (const parent of ["parent", "parent-other"]) {
    for (const id of ["descriptorless", "described"]) {
      if (id === "described") store.apply(parent, "pi", { type: "upsert", id, title: id });
      store.apply(parent, "pi", {
        type: "timeline",
        id,
        item: { type: "assistant_message", text: "retained answer" },
      });
      const before = store.fetchTimeline(parent, id, options);
      store.apply(parent, "pi", { type: "hide", id });
      assert.deepEqual(store.fetchTimeline(parent, id, options), before);
    }
  }
  store.deleteParent("parent");
  for (const id of ["descriptorless", "described"]) {
    assert.throws(() => store.fetchTimeline("parent", id, options), /Unknown agent/);
    assert.equal(store.apply("parent", "pi", { type: "upsert", id }).type, "upsert");
    assert.match(
      JSON.stringify(store.fetchTimeline("parent-other", id, options)),
      /retained answer/,
    );
    assert.equal(store.apply("parent-other", "pi", { type: "upsert", id }).type, "remove");
  }
  assert.equal(store.list("parent").length, 2);
  assert.deepEqual(store.list("parent-other"), []);
});
