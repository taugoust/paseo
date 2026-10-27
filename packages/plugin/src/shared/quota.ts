export type QuotaWindowSlot = "primary_window" | "secondary_window";
export interface QuotaWindowValues {
  used_percent?: number | null;
  reset_at?: number | null;
  limit_window_seconds?: number | null;
}

export interface QuotaWindowNormalizationOptions {
  /** Percent validation varies by provider: some report over-quota values above 100. */
  usedPercent?: "finite" | "nonnegative" | "percentage";
  resetAt?: "finite" | "nonnegative" | "epoch-seconds";
  duration?: "finite" | "positive-safe-integer";
}

function isQuotaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Normalize numeric quota fields without imposing one adapter's schema or invalid-field policy. */
export function normalizeQuotaWindow(
  value: unknown,
  options: QuotaWindowNormalizationOptions = {},
): Partial<Record<keyof QuotaWindowValues, number>> | undefined {
  if (!isQuotaRecord(value)) return undefined;
  const row = value;
  const normalized: Partial<Record<keyof QuotaWindowValues, number>> = {};
  const percent = row.used_percent;
  const percentPolicy = options.usedPercent ?? "finite";
  if (
    isFiniteNumber(percent) &&
    ((percentPolicy !== "nonnegative" && percentPolicy !== "percentage") || percent >= 0) &&
    (percentPolicy !== "percentage" || percent <= 100)
  )
    normalized.used_percent = percent;
  const reset = row.reset_at;
  const resetPolicy = options.resetAt ?? "finite";
  if (
    isFiniteNumber(reset) &&
    (resetPolicy === "finite" || reset >= 0) &&
    (resetPolicy !== "epoch-seconds" || reset <= 8_640_000_000_000)
  )
    normalized.reset_at = reset;
  const duration = row.limit_window_seconds;
  if (
    isFiniteNumber(duration) &&
    (options.duration !== "positive-safe-integer" ||
      (Number.isSafeInteger(duration) && duration > 0))
  )
    normalized.limit_window_seconds = duration;
  return normalized;
}

export interface QuotaWindowMappingOptions {
  scope?: { id: string; label: string };
  summary?: boolean;
}

/** Fields shared by adapters before their SDK-specific usage window constructor runs. */
export interface QuotaWindowDescriptor {
  durationSeconds: number | null;
  unknown: { id: string; label: string; shortLabel: string };
  scope?: { id: string; label: string };
  summary?: boolean;
  utilizationPct: number | null | undefined;
  resetsAt: string | null;
}

/** Map provider slots into shared duration, fallback identity, scope, and reset descriptors. */
export function quotaWindowDescriptors(
  rateLimit:
    | Partial<Record<QuotaWindowSlot, QuotaWindowValues | null | undefined>>
    | null
    | undefined,
  options: QuotaWindowMappingOptions = {},
): QuotaWindowDescriptor[] {
  return extractQuotaWindows(rateLimit, (window, slot, primary) => ({
    durationSeconds: window.limit_window_seconds ?? null,
    unknown: {
      id: primary ? "unknown_primary" : "unknown_secondary",
      label: primary ? "Primary limit" : "Secondary limit",
      shortLabel: "",
    },
    scope: options.scope,
    summary: options.summary,
    utilizationPct: window.used_percent,
    resetsAt: window.reset_at == null ? null : new Date(window.reset_at * 1000).toISOString(),
  }));
}

/** Visit present provider windows in response order for adapters with different output shapes. */
export function extractQuotaWindows<T, U>(
  rateLimit: Partial<Record<QuotaWindowSlot, T | null | undefined>> | null | undefined,
  mapWindow: (window: NonNullable<T>, slot: QuotaWindowSlot, primary: boolean) => U | undefined,
): U[] {
  const result: U[] = [];
  for (const slot of ["primary_window", "secondary_window"] as const) {
    const window = rateLimit?.[slot];
    if (window == null) continue;
    const mapped = mapWindow(window, slot, slot === "primary_window");
    if (mapped !== undefined) result.push(mapped);
  }
  return result;
}
