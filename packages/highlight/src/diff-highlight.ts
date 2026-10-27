import { isLanguageSupported } from "./parsers.js";
import type { HighlightToken } from "./types.js";
import { extensionFromPath, tokenizeToLines } from "./highlight-cache.js";

export interface HighlightDiffLine {
  type: "add" | "remove" | "context" | "header" | "hunk";
  content: string;
  tokens?: HighlightToken[];
}

// The leading diff marker is rendered separately so syntax colors apply only
// to the code. Hunk/header lines do not participate in either source document.
function diffLineCode(line: HighlightDiffLine): string {
  const { content, type } = line;
  if (type === "add" || type === "remove") {
    return content.startsWith(type === "add" ? "+" : "-") ? content.slice(1) : content;
  }
  if (type === "context") return content.startsWith(" ") ? content.slice(1) : content;
  return content;
}

// Reconstruct the old and new documents by diff position before tokenizing so
// parsers retain cross-line context (multi-line strings, comments, etc.).
export function highlightDiffLines<T extends HighlightDiffLine>(
  diffLines: T[],
  filePath: string | null | undefined,
): (T & { tokens?: HighlightToken[] })[] {
  const ext = extensionFromPath(filePath);
  if (!ext || diffLines.length === 0 || !isLanguageSupported(`x.${ext}`)) return diffLines;

  const oldCode: string[] = [];
  const newCode: string[] = [];
  const positions = diffLines.map((line) => {
    const code = diffLineCode(line);
    if (line.type === "context") {
      const position = { oldIndex: oldCode.length, newIndex: newCode.length };
      oldCode.push(code);
      newCode.push(code);
      return position;
    }
    if (line.type === "remove") {
      const position = { oldIndex: oldCode.length, newIndex: -1 };
      oldCode.push(code);
      return position;
    }
    if (line.type === "add") {
      const position = { oldIndex: -1, newIndex: newCode.length };
      newCode.push(code);
      return position;
    }
    return { oldIndex: -1, newIndex: -1 };
  });

  const oldTokens = oldCode.length > 0 ? tokenizeToLines(oldCode.join("\n"), ext) : null;
  const newTokens = newCode.length > 0 ? tokenizeToLines(newCode.join("\n"), ext) : null;
  if (!oldTokens && !newTokens) return diffLines;

  return diffLines.map((line, index) => {
    const { oldIndex, newIndex } = positions[index];
    let tokens: HighlightToken[] | undefined;
    if ((line.type === "add" || line.type === "context") && newTokens) tokens = newTokens[newIndex];
    else if (line.type === "remove" && oldTokens) tokens = oldTokens[oldIndex];
    return (tokens ? { ...line, tokens } : line) as T & { tokens?: HighlightToken[] };
  });
}
