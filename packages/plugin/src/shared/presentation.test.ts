import { describe, expect, test } from "vitest";
import {
  getMarkdownCodeMetrics,
  getMarkdownHeadingMetrics,
  getMarkdownTextMetrics,
  getSpinnerDotOpacity,
  getSpinnerStep,
  SPINNER_DOT_COUNT,
  SPINNER_DURATION_MS,
} from "./presentation";

describe("shared presentation metrics", () => {
  test("keeps the six spinner steps aligned to the 950ms wall-clock cycle boundaries", () => {
    expect(SPINNER_DOT_COUNT).toBe(6);
    expect(SPINNER_DURATION_MS).toBe(950);
    expect(
      [0, 158, 159, 316, 317, 474, 475, 633, 634, 791, 792, 949, 950].map(getSpinnerStep),
    ).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0]);
  });

  test("retains every opacity in the original six-state matrix and safe out-of-range behavior", () => {
    const states: number[][] = [];
    for (let step = 0; step < 6; step++) {
      states.push(Array.from({ length: 6 }, (_, dot) => getSpinnerDotOpacity(step, dot)));
    }
    expect(states).toEqual([
      [1, 0, 0.78, 0, 0.56, 0.34],
      [0.78, 1, 0.56, 0, 0.34, 0],
      [0.56, 0.78, 0.34, 1, 0, 0],
      [0.34, 0.56, 0, 0.78, 0, 1],
      [0, 0.34, 0, 0.56, 1, 0.78],
      [0, 0, 1, 0.34, 0.78, 0.56],
    ]);
    expect(getSpinnerDotOpacity(-1, 0)).toBe(0);
    expect(getSpinnerDotOpacity(6, 0)).toBe(0);
  });

  test("shares standard text, heading, and code metrics while supporting app compact sizing", () => {
    expect(getMarkdownTextMetrics(15)).toEqual({ fontSize: 15, lineHeight: 21 });
    expect(getMarkdownHeadingMetrics(15, 1)).toEqual({ fontSize: 24, lineHeight: 31 });
    expect(getMarkdownHeadingMetrics(15, 6)).toEqual({ fontSize: 15, lineHeight: 20 });
    expect(getMarkdownCodeMetrics(12, 15)).toEqual({ fontSize: 12, lineHeight: 21 });
    expect(getMarkdownTextMetrics(14)).toEqual({ fontSize: 14, lineHeight: 20 });
    expect(getMarkdownHeadingMetrics(14, 1)).toEqual({ fontSize: 22, lineHeight: 29 });
  });
});
