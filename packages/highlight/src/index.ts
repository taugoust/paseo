export type { HighlightStyle, HighlightToken } from "./types.js";
export {
  getLanguageForFile,
  getParserForFile,
  isLanguageSupported,
  getSupportedExtensions,
} from "./parsers.js";
export { createCodeMirrorHighlightStyle } from "./syntax-roles.js";
export { highlightCode, highlightCodeInSteps, highlightLine } from "./highlighter.js";
export {
  extensionFromPath,
  highlightToKeyedLines,
  MAX_HIGHLIGHT_CHARS,
  tokenizeToLines,
} from "./highlight-cache.js";
export type { KeyedLine, KeyedToken } from "./highlight-cache.js";
export { highlightDiffLines } from "./diff-highlight.js";
export type { HighlightDiffLine } from "./diff-highlight.js";
export { darkHighlightColors, lightHighlightColors } from "./colors.js";
export type { SyntaxThemeId, SyntaxThemeOption, SyntaxColors } from "./themes.js";
export {
  SYNTAX_THEME_IDS,
  SYNTAX_THEME_OPTIONS,
  isSyntaxThemeId,
  resolveSyntaxColors,
} from "./themes.js";
