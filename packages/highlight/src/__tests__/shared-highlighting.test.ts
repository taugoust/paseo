import { describe, expect, it } from "vitest";
import {
  extensionFromPath,
  highlightDiffLines,
  highlightToKeyedLines,
  MAX_HIGHLIGHT_CHARS,
  tokenizeToLines,
} from "../index.js";

describe("shared highlighting helpers", () => {
  it("extracts extensions and returns stable keyed tokens for source lines", () => {
    expect(extensionFromPath("/repo/src/Index.TS")).toBe("ts");
    const lines = highlightToKeyedLines("const a = 1;", "ts");
    expect(lines?.[0].key).toBe("line-0");
    expect(lines?.[0].tokens[0].key).toBe("0-0");
    expect(lines?.[0].tokens.some(({ token }) => token.style === "keyword")).toBe(true);
  });

  it("keeps tokenization cached and falls back above the document size cap", () => {
    const first = tokenizeToLines("const cached = true;", "ts");
    expect(tokenizeToLines("const cached = true;", "ts")).toBe(first);
    expect(tokenizeToLines("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ts")).toBeNull();
  });

  it("highlights added, removed, and context diff lines using reconstructed documents", () => {
    const diff = [
      { type: "header" as const, content: "@@" },
      { type: "remove" as const, content: "-const old = 1;" },
      { type: "add" as const, content: "+const next = 2;" },
      { type: "context" as const, content: " const keep = 3;" },
    ];
    const result = highlightDiffLines(diff, "/repo/example.ts");
    expect(result[1].tokens?.map((token) => token.text).join("")).toBe("const old = 1;");
    expect(result[2].tokens?.map((token) => token.text).join("")).toBe("const next = 2;");
    expect(result[3].tokens?.map((token) => token.text).join("")).toBe("const keep = 3;");
    expect(result[2].tokens?.some((token) => token.style === "keyword")).toBe(true);
    expect(result[0].tokens).toBeUndefined();
  });

  it("returns unsupported diffs unchanged", () => {
    const diff = [{ type: "add" as const, content: "+one" }];
    expect(highlightDiffLines(diff, "file.unknownext")).toBe(diff);
  });
});
