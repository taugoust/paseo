/** Wall-clock-aligned spinner state shared by the app and bundled plugin clients. */
export const SPINNER_DURATION_MS = 950;
export const SPINNER_DOT_COUNT = 6;

const SPINNER_OPACITY_STATES = [
  [1, 0, 0.78, 0, 0.56, 0.34],
  [0.78, 1, 0.56, 0, 0.34, 0],
  [0.56, 0.78, 0.34, 1, 0, 0],
  [0.34, 0.56, 0, 0.78, 0, 1],
  [0, 0.34, 0, 0.56, 1, 0.78],
  [0, 0, 1, 0.34, 0.78, 0.56],
] as const;

export function getSpinnerStep(nowMs: number): number {
  "worklet";
  const elapsedMs = nowMs % SPINNER_DURATION_MS;
  return Math.floor((elapsedMs * SPINNER_DOT_COUNT) / SPINNER_DURATION_MS);
}

export function getSpinnerDotOpacity(step: number, dot: number): number {
  "worklet";
  return SPINNER_OPACITY_STATES[step]?.[dot] ?? 0;
}

const MARKDOWN_HEADING_SCALES = [1.6, 1.4, 1.2, 1.1, 1, 1] as const;

/** Shared text metrics; renderers remain responsible for colors and block spacing. */
export function getMarkdownTextMetrics(fontSize: number): { fontSize: number; lineHeight: number } {
  return { fontSize, lineHeight: Math.round(fontSize * 1.4) };
}

export function getMarkdownHeadingMetrics(
  baseFontSize: number,
  level: number,
): { fontSize: number; lineHeight: number } {
  const scale = MARKDOWN_HEADING_SCALES[Math.min(5, Math.max(0, level - 1))]!;
  return {
    fontSize: Math.round(baseFontSize * scale),
    lineHeight: Math.round(baseFontSize * scale * 1.3),
  };
}

/** Code uses its own font size and the paragraph line height in both renderers. */
export function getMarkdownCodeMetrics(
  codeFontSize: number,
  baseFontSize: number,
): { fontSize: number; lineHeight: number } {
  return { fontSize: codeFontSize, lineHeight: getMarkdownTextMetrics(baseFontSize).lineHeight };
}
