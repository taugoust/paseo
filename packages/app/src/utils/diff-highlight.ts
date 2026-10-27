import type { DiffLine } from "@/utils/tool-call-parsers";
export { highlightDiffLines } from "@getpaseo/highlight";

// The leading diff marker is rendered separately so syntax colors apply only
// to the code. This is a presentation helper; tokenization is package-owned.
export function diffLinePrefix(line: DiffLine): string {
  switch (line.type) {
    case "add":
      return "+";
    case "remove":
      return "-";
    case "context":
      return " ";
    default:
      return "";
  }
}
