import { highlightCode } from "./highlighter.js";
import type { HighlightToken } from "./types.js";

// Shared, theme-independent tokenization + cache for syntax highlighting.
// Colors are applied at render time, so the cache key is just (extension, code).

export interface KeyedToken {
  key: string;
  token: HighlightToken;
}

export interface KeyedLine {
  key: string;
  tokens: KeyedToken[];
}

// Avoid a visible main-thread stall when a large document is expanded.
export const MAX_HIGHLIGHT_CHARS = 100_000;

class LRUCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

const tokenizationCache = new LRUCache<string, HighlightToken[][]>(200);

// Returns null when highlighting is unavailable; callers then render plain text.
export function tokenizeToLines(code: string, ext: string | null): HighlightToken[][] | null {
  if (!ext || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const cacheKey = `${ext}:${code}`;
  const cached = tokenizationCache.get(cacheKey);
  if (cached) return cached;
  let lines: HighlightToken[][];
  try {
    lines = highlightCode(code, `x.${ext}`);
  } catch {
    return null;
  }
  tokenizationCache.set(cacheKey, lines);
  return lines;
}

function toKeyedLine(tokens: HighlightToken[], lineIndex: number): KeyedLine {
  return {
    key: `line-${lineIndex}`,
    tokens: tokens.map((token, tokenIndex) => ({ key: `${lineIndex}-${tokenIndex}`, token })),
  };
}

export function highlightToKeyedLines(code: string, ext: string | null): KeyedLine[] | null {
  const lines = tokenizeToLines(code, ext);
  return lines ? lines.map(toKeyedLine) : null;
}

// Extension for grammar selection from a file path. Absolute and relative paths
// are equivalent because only the suffix selects a parser.
export function extensionFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
