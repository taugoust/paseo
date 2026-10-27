import { describe, expect, test } from "vitest";
import { PiUsagePoller } from "./usage-poller.js";
import type { PiSessionStats } from "./rpc-types.js";

function fixture() {
  const pending: Array<{ resolve(stats: PiSessionStats): void; reject(error: unknown): void }> = [];
  const published: unknown[] = [];
  const poller = new PiUsagePoller({
    readStats: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    onUsage: (usage) => published.push(usage),
    onPollError: () => {
      throw new Error("idle read errors must not become turn errors");
    },
    scheduler: { schedulePoll: () => () => {} },
  });
  return { poller, pending, published };
}
const stats = (tokens: number): PiSessionStats => ({
  contextUsage: { contextWindow: 2_000, tokens },
  tokens: { input: 20, output: 5, cacheRead: 2 },
  cost: 0.25,
});

describe("Pi idle usage lifecycle", () => {
  test("newer idle refresh wins without losing cumulative accounting", async () => {
    const { poller, pending, published } = fixture();
    const old = poller.refreshIdle();
    const fresh = poller.refreshIdle();
    pending[1]!.resolve(stats(50));
    await fresh;
    pending[0]!.resolve(stats(800));
    await old;
    expect(published).toEqual([
      {
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 5,
        totalCostUsd: 0.25,
        contextWindowMaxTokens: 2_000,
        contextWindowUsedTokens: 50,
      },
    ]);
    poller.close();
  });

  for (const boundary of ["close", "new turn"] as const) {
    test(`drops an idle response after ${boundary}`, async () => {
      const { poller, pending, published } = fixture();
      const refresh = poller.refreshIdle();
      if (boundary === "close") poller.close();
      else poller.startTurn();
      pending[0]!.resolve(stats(800));
      await refresh;
      expect(published).toEqual([]);
      poller.close();
    });
  }

  test("a failed idle read does not publish invented zeros and can recover", async () => {
    const { poller, pending, published } = fixture();
    const failed = poller.refreshIdle();
    pending[0]!.reject(new Error("synthetic unavailable stats"));
    await failed;
    expect(published).toEqual([]);
    const recovered = poller.refreshIdle();
    pending[1]!.resolve(stats(50));
    await recovered;
    expect(published).toHaveLength(1);
    poller.close();
  });
});
