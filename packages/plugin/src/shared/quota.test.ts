import { describe, expect, it } from "vitest";
import { extractQuotaWindows, normalizeQuotaWindow, quotaWindowDescriptors } from "./quota";

describe("normalizeQuotaWindow", () => {
  it("applies adapter-specific numeric bounds without coercion", () => {
    expect(normalizeQuotaWindow({ used_percent: 125, reset_at: -1 })).toEqual({
      used_percent: 125,
      reset_at: -1,
    });
    expect(
      normalizeQuotaWindow(
        { used_percent: 125, reset_at: 8_640_000_000_001 },
        { usedPercent: "percentage", resetAt: "epoch-seconds" },
      ),
    ).toEqual({});
    expect(normalizeQuotaWindow({ used_percent: "12" })).toEqual({});
  });
});

describe("quotaWindowDescriptors", () => {
  it("normalizes duration, unknown identity, scope, summary, and reset time together", () => {
    expect(
      quotaWindowDescriptors(
        {
          primary_window: {
            used_percent: 25,
            reset_at: 2_000_000_000,
            limit_window_seconds: 3600,
          },
          secondary_window: { used_percent: 8 },
        },
        { scope: { id: "limit:x", label: "Feature X" }, summary: false },
      ),
    ).toEqual([
      {
        durationSeconds: 3600,
        unknown: { id: "unknown_primary", label: "Primary limit", shortLabel: "" },
        scope: { id: "limit:x", label: "Feature X" },
        summary: false,
        utilizationPct: 25,
        resetsAt: new Date(2_000_000_000_000).toISOString(),
      },
      {
        durationSeconds: null,
        unknown: { id: "unknown_secondary", label: "Secondary limit", shortLabel: "" },
        scope: { id: "limit:x", label: "Feature X" },
        summary: false,
        utilizationPct: 8,
        resetsAt: null,
      },
    ]);
  });
});

describe("extractQuotaWindows", () => {
  it("visits only present windows in stable provider slot order", () => {
    expect(
      extractQuotaWindows(
        { secondary_window: { used_percent: 2 }, primary_window: { used_percent: 1 } },
        (window, slot, primary) => ({ slot, primary, value: window.used_percent }),
      ),
    ).toEqual([
      { slot: "primary_window", primary: true, value: 1 },
      { slot: "secondary_window", primary: false, value: 2 },
    ]);
    expect(extractQuotaWindows(null, () => "unused")).toEqual([]);
  });
});
