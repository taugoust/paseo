import { getPaseoToolLeafName } from "../tool-name-normalization.js";
import { buildGenericToolSections } from "../generic-tool-presentation.js";
import { getPaseoToolEntry, type PaseoToolDetailSpec } from "./catalog.js";

export interface PaseoToolDetailField {
  label: string;
  value: string;
}

export type PaseoToolDetailSection =
  | {
      kind: "prose";
      title: string;
      text: string;
    }
  | {
      kind: "fields";
      title: string;
      fields: PaseoToolDetailField[];
    };

const FIELD_LABELS: Readonly<Record<string, string>> = {
  agentId: "Agent",
  archivedAgentIds: "Archived agents",
  baseBranch: "Base branch",
  branchName: "New branch",
  browserId: "Browser tab",
  clearExpires: "Clear expiry",
  currentModeId: "Current mode",
  cwd: "Working directory",
  deltaX: "Horizontal delta",
  deltaY: "Vertical delta",
  doubleClick: "Double click",
  expiresIn: "Expires in",
  expiresAt: "Expires",
  filePaths: "Files",
  fullPage: "Full page",
  initialPrompt: "Prompt",
  id: "ID",
  lastMessage: "Last message",
  maxEntries: "Maximum entries",
  maxRuns: "Maximum runs",
  modeId: "Mode",
  newMode: "New mode",
  nextRunAt: "Next run",
  notifyOnFinish: "Notify on finish",
  internal: "Internal",
  prNumber: "Change request",
  projectId: "Project",
  removedDirectory: "Removed directory",
  requestId: "Request",
  scriptName: "Script",
  sessionMode: "Session mode",
  sinceHours: "Since (hours)",
  sourceRef: "Source",
  targetRef: "Target",
  terminalId: "Terminal",
  thinkingOptionId: "Thinking",
  timeoutMs: "Timeout (ms)",
  updateCount: "Updates",
  workspaceId: "Workspace",
  worktreeSlug: "Worktree",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeKey(key: string): string {
  const known = FIELD_LABELS[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const sentence = words.join(" ").toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

function formatValue(value: unknown, depth = 0): string {
  if (value === null) return "None";
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    return value.map((item) => `• ${indentMultiline(formatValue(item, depth + 1), 2)}`).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    if (entries.length === 0) return "None";
    return entries
      .map(([key, child]) => {
        const formatted = formatValue(child, depth + 1);
        return `${humanizeKey(key)}: ${indentMultiline(formatted, 2)}`;
      })
      .join("\n");
  }
  return String(value);
}

function indentMultiline(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return value.replace(/\n/g, `\n${indentation}`);
}

function orderedEntries(
  value: Record<string, unknown>,
  order: readonly string[] = [],
  omittedKey?: string,
  includedKeys?: readonly string[],
): Array<[string, unknown]> {
  const included = includedKeys ? new Set(includedKeys) : null;
  const keys = Object.keys(value).filter(
    (key) => key !== omittedKey && value[key] !== undefined && (!included || included.has(key)),
  );
  const rank = new Map(order.map((key, index) => [key, index]));
  keys.sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
  return keys.map((key) => [key, value[key]]);
}

function fieldsFromValue(
  value: unknown,
  order?: readonly string[],
  omittedKey?: string,
  includedKeys?: readonly string[],
): PaseoToolDetailField[] {
  if (value === null || value === undefined) return [];
  if (!isRecord(value)) {
    const formatted = formatValue(value);
    return formatted ? [{ label: "Value", value: formatted }] : [];
  }
  return orderedEntries(value, order, omittedKey, includedKeys).map(([key, child]) => ({
    label: humanizeKey(key),
    value: formatValue(child),
  }));
}

export function buildPaseoToolDetailSections(
  toolName: string,
  input: unknown,
  output: unknown,
): PaseoToolDetailSection[] | null {
  const leafName = getPaseoToolLeafName(toolName);
  if (!leafName) return null;

  const spec: PaseoToolDetailSpec = getPaseoToolEntry(leafName)?.detail ?? {};
  const sections: PaseoToolDetailSection[] = [];
  if (spec.promptField && isRecord(input)) {
    const prompt = input[spec.promptField];
    if (typeof prompt === "string" && prompt.length > 0) {
      sections.push({ kind: "prose", title: "Prompt", text: prompt });
    }
  }

  const inputFields = fieldsFromValue(input, spec.inputOrder, spec.promptField);
  if (inputFields.length > 0) {
    sections.push({ kind: "fields", title: "Details", fields: inputFields });
  }

  // Keep prose, nontext blocks and unexpected fields rather than projecting a
  // catalog whitelist or replacing the full envelope with structuredContent.
  sections.push(
    // Each generated section is shared; preserve copy-on-write when relabeling.
    // eslint-disable-next-line oxc/no-map-spread
    ...buildGenericToolSections("paseo_result", null, output).map((section) => ({
      ...section,
      title: section.title === "Output" ? "Result" : section.title,
    })),
  );
  return sections;
}
