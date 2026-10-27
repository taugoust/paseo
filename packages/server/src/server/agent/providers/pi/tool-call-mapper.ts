import { z } from "zod";
import {
  genericToolText,
  hasGenericToolPresentation,
} from "@getpaseo/protocol/generic-tool-presentation";
import { isPaseoToolName } from "@getpaseo/protocol/tool-name-normalization";

import type { ToolCallDetail } from "../../agent-sdk-types.js";

interface BashToolInput {
  command: string;
  timeout?: number;
}

interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

interface EditToolInput {
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}

interface WriteToolInput {
  path: string;
  content: string;
}

interface FindToolInput {
  pattern: string;
  path?: string;
  limit?: number;
}

interface GrepToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface LsToolInput {
  path?: string;
  limit?: number;
}

interface PiToolResultObject {
  output?: string;
  stdout?: string;
  text?: string;
  content?: PiToolResultContent[];
  exitCode?: number;
  code?: number;
  details?: PiToolResultDetails;
  structuredContent?: unknown;
}

interface PiToolResultDetails {
  diff?: string;
  [key: string]: unknown;
}

interface PiToolResultTextContent {
  type: "text";
  text: string;
}

interface PiToolResultUnknownContent {
  type: string;
}

type PiToolResultContent = PiToolResultTextContent | PiToolResultUnknownContent;
export type PiToolResult = string | PiToolResultObject | null;

interface PiBashToolCall {
  kind: "bash";
  toolName: "bash";
  args: BashToolInput;
}

interface PiReadToolCall {
  kind: "read";
  toolName: "read";
  args: ReadToolInput;
}

interface PiEditToolCall {
  kind: "edit";
  toolName: "edit";
  args: EditToolInput;
}

interface PiWriteToolCall {
  kind: "write";
  toolName: "write";
  args: WriteToolInput;
}

interface PiFindToolCall {
  kind: "find";
  toolName: "find";
  args: FindToolInput;
}

interface PiGrepToolCall {
  kind: "grep";
  toolName: "grep";
  args: GrepToolInput;
}

interface PiLsToolCall {
  kind: "ls";
  toolName: "ls";
  args: LsToolInput;
}

interface PiWebSearchToolCall {
  kind: "web_search";
  toolName: string;
  args: unknown;
  query: string;
}

interface PiUnknownToolCall {
  kind: "unknown";
  toolName: string;
  args: unknown;
}

export type PiTrackedToolCall =
  | PiBashToolCall
  | PiReadToolCall
  | PiEditToolCall
  | PiWriteToolCall
  | PiFindToolCall
  | PiGrepToolCall
  | PiLsToolCall
  | PiWebSearchToolCall
  | PiUnknownToolCall;

interface ToolCallOutputSummary {
  output?: string;
  exitCode?: number | null;
}

const PiToolResultTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const PiToolResultUnknownContentSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const PiToolResultContentSchema = z.union([
  PiToolResultTextContentSchema,
  PiToolResultUnknownContentSchema,
]);

const PiToolResultDetailsSchema = z
  .object({
    diff: z.string().optional(),
  })
  .passthrough();

const PiToolResultObjectSchema = z
  .object({
    output: z.string().optional(),
    stdout: z.string().optional(),
    text: z.string().optional(),
    content: z.array(PiToolResultContentSchema).optional(),
    exitCode: z.number().optional(),
    code: z.number().optional(),
    details: PiToolResultDetailsSchema.optional(),
  })
  .passthrough();

const PiToolResultSchema = z.union([z.string(), PiToolResultObjectSchema, z.null()]);

const BashToolInputSchema: z.ZodType<BashToolInput> = z.object({
  command: z.string(),
  timeout: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined),
});

const ReadToolInputSchema: z.ZodType<ReadToolInput> = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const EditToolInputSchema: z.ZodType<EditToolInput> = z.object({
  path: z.string(),
  edits: z.array(
    z.object({
      oldText: z.string(),
      newText: z.string(),
    }),
  ),
});

const LegacyEditToolInputSchema = z.object({
  path: z.string(),
  old_string: z.string().optional(),
  oldString: z.string().optional(),
  new_string: z.string().optional(),
  newString: z.string().optional(),
});

const WriteToolInputSchema: z.ZodType<WriteToolInput> = z.object({
  path: z.string(),
  content: z.string(),
});

const FindToolInputSchema: z.ZodType<FindToolInput> = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  limit: z.number().optional(),
});

const GrepToolInputSchema: z.ZodType<GrepToolInput> = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().optional(),
  limit: z.number().optional(),
});

const LsToolInputSchema: z.ZodType<LsToolInput> = z.object({
  path: z.string().optional(),
  limit: z.number().optional(),
});

export function parseToolResult(rawResult: unknown): PiToolResult {
  const parsed = PiToolResultSchema.safeParse(rawResult);
  if (parsed.success) {
    return parsed.data;
  }
  return null;
}

function stripFinalNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function piToolRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function webSearchQuery(name: string, args: unknown): string | undefined {
  const input = piToolRecord(args);
  if (!input) return undefined;
  const localName = name.toLowerCase().split("__").at(-1)!;
  const explicit = [
    "web_search",
    "websearch",
    "web_search_exa",
    "brave_web_search",
    "tavily_search",
  ].includes(localName);
  const webBatch = (name === "web" || name === "web.run") && Array.isArray(input.search_query);
  if (!explicit && !webBatch) return undefined;
  const direct = input.query ?? input.q ?? input.search_term;
  if (typeof direct === "string" && direct.trim()) return direct;
  const values = Array.isArray(input.search_query)
    ? input.search_query.map((value) => piToolRecord(value)?.q)
    : input.queries;
  if (
    !Array.isArray(values) ||
    !values.length ||
    !values.every((value) => typeof value === "string" && value.trim())
  )
    return undefined;
  return values.join("; ");
}

function nativeWebSearchDetail(result: PiToolResult): Record<string, unknown> | undefined {
  const root = piToolRecord(result);
  const native = piToolRecord(root?.structuredContent) ?? root;
  if (
    !native ||
    typeof native.query !== "string" ||
    !Array.isArray(native.results) ||
    typeof native.durationSeconds !== "number" ||
    !Number.isFinite(native.durationSeconds)
  )
    return undefined;
  // This is the existing Paseo Claude WebSearch schema, not a guessed URL/result
  // convention: rows are annotation strings or tool_use_id/content hit groups.
  const valid = native.results.every((entry) => {
    if (typeof entry === "string") return true;
    const row = piToolRecord(entry);
    const content = row?.content;
    return (
      typeof row?.tool_use_id === "string" &&
      Array.isArray(content) &&
      content.every((hit) => {
        const hitRecord = piToolRecord(hit);
        return typeof hitRecord?.title === "string" && typeof hitRecord.url === "string";
      })
    );
  });
  if (!valid) return undefined;
  const webResults = native.results.flatMap((entry) =>
    typeof entry === "string"
      ? []
      : (piToolRecord(entry)!.content as unknown[]).map((hit) => {
          const row = piToolRecord(hit)!;
          return { title: row.title, url: row.url };
        }),
  );
  const annotations = native.results.filter((entry): entry is string => typeof entry === "string");
  return {
    ...(webResults.length ? { webResults } : {}),
    ...(annotations.length ? { annotations } : {}),
    durationSeconds: native.durationSeconds,
  };
}

function webSearchOutput(result: PiToolResult): string | undefined {
  const root = piToolRecord(result);
  const structured = piToolRecord(root?.structuredContent);
  const results = structured?.results ?? root?.results;
  if (Array.isArray(results)) {
    const blocks = results.flatMap((value) => {
      const row = piToolRecord(value);
      if (!row || typeof row.url !== "string") return [];
      try {
        if (!["http:", "https:"].includes(new URL(row.url).protocol)) return [];
      } catch {
        return [];
      }
      let snippet = "";
      if (typeof row.snippet === "string") snippet = row.snippet;
      else if (typeof row.description === "string") snippet = row.description;
      return [
        [typeof row.title === "string" ? row.title : "", row.url, snippet]
          .filter(Boolean)
          .join("\n"),
      ];
    });
    if (blocks.length) return stripFinalNewline(blocks.join("\n\n"));
  }
  return extractTextFromToolResult(result);
}

export function extractTextFromToolResult(result: PiToolResult): string | undefined {
  if (typeof result === "string") {
    return stripFinalNewline(result);
  }
  if (!result) {
    return undefined;
  }

  const directText = result.output ?? result.stdout ?? result.text;
  if (directText) {
    return stripFinalNewline(directText);
  }
  const structured = piToolRecord(result.structuredContent);
  if (typeof structured?.output === "string") {
    const output = stripFinalNewline(structured.output);
    const contentText = result.content
      ?.flatMap((block) => (block.type === "text" && "text" in block ? [block.text] : []))
      .join("\n");
    const readableContent = contentText ? stripFinalNewline(contentText) : "";
    return readableContent.startsWith(output) ? readableContent : output;
  }
  if (!result.content) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && "text" in block) {
      textParts.push(block.text);
    }
  }

  return textParts.length > 0 ? stripFinalNewline(textParts.join("\n")) : undefined;
}

export function parseToolArgs(toolName: string, rawArgs: unknown): PiTrackedToolCall {
  const query = webSearchQuery(toolName, rawArgs);
  if (query !== undefined) return { kind: "web_search", toolName, args: rawArgs, query };
  if (toolName === "edit") {
    return parseEditToolArgs(rawArgs);
  }
  const schema = SIMPLE_TOOL_SCHEMAS[toolName as SimpleToolKind];
  if (schema) {
    // Pi/MCP nullable optional arguments mean "unspecified", not malformed.
    const record = piToolRecord(rawArgs);
    const displayArgs = record
      ? Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null))
      : rawArgs;
    const parsed = schema.safeParse(displayArgs);
    if (parsed.success) {
      return { kind: toolName as SimpleToolKind, toolName, args: parsed.data } as PiTrackedToolCall;
    }
  }
  return { kind: "unknown", toolName, args: rawArgs ?? null };
}

export function mapToolDetail(toolCall: PiTrackedToolCall, result?: PiToolResult): ToolCallDetail {
  const parsedResult = result ?? null;

  if (isTaskToolCall(toolCall)) {
    return mapTaskToolDetail(toolCall.args, parsedResult);
  }

  if (hasGenericToolPresentation(toolCall.toolName)) {
    return mapGenericToolDetail(toolCall, parsedResult);
  }
  return mapKnownToolDetail(toolCall, parsedResult);
}

function mapGenericToolDetail(
  toolCall: PiTrackedToolCall,
  parsedResult: PiToolResult | null,
): ToolCallDetail {
  const args = isRecord(toolCall.args) ? toolCall.args : {};
  const action = genericToolAction(toolCall.toolName, args);
  const context = genericToolContext(args);
  const actionLabel = genericToolActionLabel(toolCall.toolName, action, args);
  const partialWatchEvents = hasPartialWatchEvents(toolCall.toolName, action, parsedResult);
  return {
    type: "plain_text",
    label: [actionLabel, context].filter(Boolean).join(" · "),
    text: partialWatchEvents
      ? (extractTextFromToolResult(parsedResult) ?? "")
      : genericToolText(toolCall.toolName, toolCall.args, parsedResult),
  };
}

function genericToolAction(toolName: string, args: Record<string, unknown>): unknown {
  const action = readNonEmptyString(args.action) ?? readNonEmptyString(args.operation);
  if (action !== undefined) return action;
  if (toolName === "fetch") return readNonEmptyString(args.method) ?? "GET";
  return undefined;
}

function genericToolContext(args: Record<string, unknown>): string | undefined {
  const firstQuestion =
    Array.isArray(args.questions) && isRecord(args.questions[0]) ? args.questions[0] : {};
  return (
    readNonEmptyString(args.url) ??
    readNonEmptyString(args.name) ??
    readNonEmptyString(firstQuestion.prompt)?.split(/\r?\n/, 1)[0].slice(0, 160) ??
    (Array.isArray(args.steps) ? `${args.steps.length} steps` : undefined)
  );
}

function genericToolActionLabel(
  toolName: string,
  action: unknown,
  args: Record<string, unknown>,
): unknown {
  if (toolName !== "background_job" && toolName !== "subagent") return action;
  if (action === "adopt")
    return typeof args.pane_id === "string" ? "Manage existing tmux pane" : "Read-only observation";
  const labels: Record<string, string> = {
    watch: "Log watch",
    watches: "Watches",
    events: "Build alerts",
    ack: "Acknowledge alerts",
    unwatch: "Stop watching — not the build",
    tasks: "Tasks",
    prompt: "Child instruction",
    result: "Task report",
    status: "Status",
    output: "Output",
  };
  return labels[String(action ?? "")] ?? action;
}

function hasPartialWatchEvents(
  toolName: string,
  action: unknown,
  result: PiToolResult | null,
): boolean {
  if (toolName !== "background_job" || action !== "events" || !isRecord(result)) return false;
  const details = isRecord(result.details) ? result.details : {};
  return (
    Array.isArray(details.events) &&
    !details.events.every(
      (event) =>
        isRecord(event) && (typeof event.text === "string" || typeof event.status === "string"),
    )
  );
}

function mapKnownToolDetail(
  toolCall: PiTrackedToolCall,
  parsedResult: PiToolResult | null,
): ToolCallDetail {
  switch (toolCall.kind) {
    case "web_search":
      return {
        type: "search",
        query: toolCall.query,
        toolName: "web_search",
        content: webSearchOutput(parsedResult),
        ...nativeWebSearchDetail(parsedResult),
      };
    case "bash": {
      const summary = resolveToolCallOutput(parsedResult);
      return {
        type: "shell",
        command: toolCall.args.command,
        output: summary.output,
        exitCode: summary.exitCode,
      };
    }
    case "read":
      return {
        type: "read",
        filePath: toolCall.args.path,
        content: extractTextFromToolResult(parsedResult),
        offset: toolCall.args.offset,
        limit: toolCall.args.limit,
      };
    case "edit": {
      const firstEdit = toolCall.args.edits[0];
      const unifiedDiff =
        parsedResult && typeof parsedResult !== "string" ? parsedResult.details?.diff : undefined;

      return {
        type: "edit",
        filePath: toolCall.args.path,
        oldString: firstEdit?.oldText,
        newString: firstEdit?.newText,
        unifiedDiff,
      };
    }
    case "write":
      return { type: "write", filePath: toolCall.args.path, content: toolCall.args.content };
    case "find":
      return mapFindToolDetail(toolCall.args, parsedResult);
    case "grep":
      return mapGrepToolDetail(toolCall.args, parsedResult);
    case "ls":
      return mapLsToolDetail(toolCall.args, parsedResult);
    default:
      return mapUnknownToolDetail(toolCall, parsedResult);
  }
}

function mapUnknownToolDetail(
  toolCall: PiTrackedToolCall,
  parsedResult: PiToolResult | null,
): ToolCallDetail {
  const hasRichContent =
    parsedResult &&
    typeof parsedResult !== "string" &&
    Array.isArray(parsedResult.content) &&
    parsedResult.content.some((block) => block.type !== "text");
  if (!hasRichContent && !isPaseoToolName(toolCall.toolName)) {
    const args = isRecord(toolCall.args) ? toolCall.args : {};
    return {
      type: "plain_text",
      label: readNonEmptyString(args.action) ?? readNonEmptyString(args.operation),
      text: genericToolText(toolCall.toolName, toolCall.args, parsedResult),
    };
  }
  return { type: "unknown", input: toolCall.args, output: parsedResult };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTaskToolCall(toolCall: PiTrackedToolCall): boolean {
  if (toolCall.toolName !== "subagent" || !isRecord(toolCall.args)) return false;
  return (
    toolCall.args.action === undefined &&
    (readNonEmptyString(toolCall.args.agent) !== undefined ||
      readNonEmptyString(toolCall.args.task) !== undefined ||
      (toolCall.args.background === true &&
        (Array.isArray(toolCall.args.tasks) || Array.isArray(toolCall.args.chain))) ||
      (toolCall.args.operation === "resume" && typeof toolCall.args.task_id === "string"))
  );
}

function taskToolLabel(
  details: Record<string, unknown>,
  outcomes: Record<string, unknown>[],
): string | undefined {
  const labels: Record<string, string> = {
    partial: "Needs continuation",
    blocked: "Blocked",
    checkpointed: "Checkpoint saved",
    unreported: "Outcome not reported",
  };
  let label: string | undefined;
  if (details.background_subagent === true && details.operation === "start")
    label = "Started in background";
  else if (outcomes.length) {
    const incomplete = outcomes.find(
      (outcome) => outcome.state !== "delivered" || outcome.reported !== true,
    );
    label = incomplete
      ? (labels[String(incomplete.state)] ?? "Outcome not reported")
      : "Reported delivered";
  }
  if (details.stopReason === "aborted" || details.status === "cancelled") return "Cancelled";
  if (
    details.failed === true ||
    (typeof details.exitCode === "number" && details.exitCode > 0) ||
    readNonEmptyString(details.errorMessage)
  )
    return `Execution failed${label && label !== "Started in background" ? ` · ${label}` : ""}`;
  return label;
}

function taskToolTitle(
  args: Record<string, unknown>,
  details: Record<string, unknown>,
): string | undefined {
  let count: number | undefined;
  if (Array.isArray(args.tasks)) count = args.tasks.length;
  else if (Array.isArray(args.chain)) count = args.chain.length;
  let title = readNonEmptyString(args.task) ?? readNonEmptyString(details.task_title);
  if (title === undefined && count) title = `${count} background tasks`;
  else if (title === undefined && args.operation === "resume") title = "Saved task";
  const firstLine = title?.split(/\r?\n/, 1)[0];
  return firstLine && firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
}

function taskToolAttempt(
  details: Record<string, unknown>,
  outcomes: Record<string, unknown>[],
): unknown {
  return details.attempt ?? (outcomes.length === 1 ? outcomes[0]?.attempt : undefined);
}

function mapTaskToolDetail(args: unknown, result: PiToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const details: Record<string, unknown> =
    result && typeof result !== "string" && isRecord(result.details) ? result.details : {};
  let outcomes: Record<string, unknown>[] = [];
  if (Array.isArray(details.task_outcomes)) outcomes = details.task_outcomes.filter(isRecord);
  else if (isRecord(details.task_outcome)) outcomes = [details.task_outcome];
  const label = taskToolLabel(details, outcomes);
  const shortTitle = taskToolTitle(argRecord, details);
  const attemptNumber = taskToolAttempt(details, outcomes);
  const attempt =
    typeof attemptNumber === "number" && Number.isSafeInteger(attemptNumber)
      ? ` · attempt ${attemptNumber}`
      : "";
  return {
    type: "sub_agent",
    subAgentType: readNonEmptyString(argRecord.agent) ?? readNonEmptyString(details.model),
    description: label ? `${label}${attempt}${shortTitle ? ` — ${shortTitle}` : ""}` : shortTitle,
    log: genericToolText("subagent", args, result),
  };
}

function resolveToolCallOutput(result: PiToolResult): ToolCallOutputSummary {
  if (typeof result === "string") {
    return { output: stripFinalNewline(result) };
  }
  if (!result) {
    return {};
  }

  // MCP-backed Pi tools retain their native content plus structured metadata.
  // Render the text once, preserving any truncation notice in content; never
  // serialize the whole envelope as shell output or invent a successful exit.
  const structured =
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  const exitCode = [
    result.exitCode,
    result.code,
    structured.exit_code,
    structured.exitCode,
    result.details?.exitCode,
  ].find((value) => typeof value === "number" && Number.isSafeInteger(value));
  return {
    output:
      extractTextFromToolResult(result) ??
      (typeof structured.output === "string" ? stripFinalNewline(structured.output) : undefined),
    exitCode: typeof exitCode === "number" ? exitCode : null,
  };
}

function normalizeLegacyEditArgs(rawArgs: unknown): EditToolInput | null {
  const parsed = LegacyEditToolInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return null;
  }

  const oldText = parsed.data.old_string ?? parsed.data.oldString;
  const newText = parsed.data.new_string ?? parsed.data.newString;
  if (!oldText || newText === undefined) {
    return null;
  }

  return {
    path: parsed.data.path,
    edits: [{ oldText, newText }],
  };
}

function parseEditToolArgs(rawArgs: unknown): PiTrackedToolCall {
  const parsed = EditToolInputSchema.safeParse(rawArgs);
  if (parsed.success) {
    return { kind: "edit", toolName: "edit", args: parsed.data };
  }
  const legacyArgs = normalizeLegacyEditArgs(rawArgs);
  if (legacyArgs) {
    return { kind: "edit", toolName: "edit", args: legacyArgs };
  }
  return { kind: "unknown", toolName: "edit", args: rawArgs ?? null };
}

type SimpleToolKind = "bash" | "read" | "write" | "find" | "grep" | "ls";
const SIMPLE_TOOL_SCHEMAS: {
  [K in SimpleToolKind]: { safeParse: (data: unknown) => { success: boolean; data?: unknown } };
} = {
  bash: BashToolInputSchema,
  read: ReadToolInputSchema,
  write: WriteToolInputSchema,
  find: FindToolInputSchema,
  grep: GrepToolInputSchema,
  ls: LsToolInputSchema,
};

function mapFindToolDetail(args: FindToolInput, result: PiToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.pattern,
    toolName: "search",
    content: extractTextFromToolResult(result),
  };
}

function mapGrepToolDetail(args: GrepToolInput, result: PiToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.pattern,
    toolName: "grep",
    content: extractTextFromToolResult(result),
  };
}

function mapLsToolDetail(args: LsToolInput, result: PiToolResult): ToolCallDetail {
  return {
    type: "search",
    query: args.path ?? "ls",
    content: extractTextFromToolResult(result),
  };
}
