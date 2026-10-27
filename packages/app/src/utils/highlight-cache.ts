// Preserve the app-local import path while the implementation lives in the
// reusable highlight package shared with bundled plugin consumers.
export {
  extensionFromPath,
  highlightToKeyedLines,
  MAX_HIGHLIGHT_CHARS,
  tokenizeToLines,
} from "@getpaseo/highlight";
export type { KeyedLine, KeyedToken } from "@getpaseo/highlight";
