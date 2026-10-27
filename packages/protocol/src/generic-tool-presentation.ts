import type { ToolCallDetail } from "./agent-types.js";
import { subagentTaskOverviewText, type SubagentTaskAttempt } from "./subagent-task-summary.js";
import type { PaseoToolDetailSection } from "./paseo-tool-presentation/detail-sections.js";
export {
  resolveSubagentTaskStatus,
  summarizeSubagentTasks,
  subagentTaskOverviewText,
} from "./subagent-task-summary.js";
export type { SubagentTaskAttempt, SubagentTaskSummary } from "./subagent-task-summary.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readableLabel(key: string): string {
  const text = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Strings are payloads, not JSON wrappers. Never parse file contents, commands or prose. */
export function readableValue(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "None";
  if (value === undefined) return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "object") return String(value);
  if (ancestors.has(value)) return "[Circular reference]";
  const next = new Set(ancestors).add(value);
  const indent = (text: string) => text.replace(/\n/g, "\n  ");
  if (Array.isArray(value)) {
    return value.length
      ? value.map((item) => `• ${indent(readableValue(item, next))}`).join("\n")
      : "None";
  }
  const entries = Object.entries(value);
  return entries.length
    ? entries
        .map(([key, child]) => `${readableLabel(key)}: ${indent(readableValue(child, next))}`)
        .join("\n")
    : "None";
}

const ACTION_TOOLS = new Set(["goal_manage", "background_job", "subagent"]);
const STRUCTURED_TOOLS = new Set([
  ...ACTION_TOOLS,
  "update_progress",
  "questionnaire",
  "fetch",
  "notify_parent",
  "task_outcome",
  "sandbox_allow_path",
  "sandbox_allow_read_path",
  "sandbox_allow_domain",
  "sandbox_allow_unix_socket",
  "goal_complete",
  "goal_blocked",
  "goal_wait",
]);

export function buildGenericToolDisplay(
  name: string,
  detail: ToolCallDetail,
): { displayName: string; summary?: string } | null {
  if (detail.type !== "unknown") return null;
  const input = record(detail.input) ? detail.input : {};
  let action: string | undefined;
  if (typeof input.action === "string") action = input.action;
  else if (typeof input.operation === "string") action = input.operation;
  const displayName = readableLabel(name);
  if (ACTION_TOOLS.has(name) || action) {
    const context = (
      name === "background_job" || name === "subagent"
        ? [input.name]
        : [input.name, input.command, input.job_id, input.task_id, input.child_id]
    ).find((value) => typeof value === "string" && value.length);
    return {
      displayName: `${displayName}${action ? ` ${action}` : ""}`,
      ...(typeof context === "string"
        ? { summary: context.split(/\r?\n/, 1)[0].slice(0, 160) }
        : {}),
    };
  }
  if (name === "questionnaire" && Array.isArray(input.questions)) {
    const first = input.questions[0];
    return {
      displayName,
      summary:
        record(first) && typeof first.prompt === "string"
          ? first.prompt.slice(0, 160)
          : `${input.questions.length} questions`,
    };
  }
  if (name === "fetch" && typeof input.url === "string") {
    return {
      displayName: `Fetch${typeof input.method === "string" ? ` ${input.method}` : ""}`,
      summary: input.url,
    };
  }
  if (name === "update_progress" && Array.isArray(input.steps))
    return { displayName, summary: `${input.steps.length} steps` };
  return null;
}

function parseStructuredText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) || Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/** Native MCP control results encode structured values as text. Other text is
 * a payload (including JSON responses and logs), not a result envelope. */
export function presentOutput(name: string, output: unknown): unknown {
  const textValue = name === "paseo_result" ? parseStructuredText : (value: unknown) => value;
  if (typeof output === "string") return textValue(output);
  if (!record(output)) return output;
  const result: Record<string, unknown> = { ...output };
  if (Array.isArray(result.content)) {
    result.content = result.content.map((block) =>
      record(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      Object.keys(block).every((key) => key === "type" || key === "text")
        ? textValue(block.text)
        : block,
    );
  }
  return result;
}

function section(title: string, value: unknown): PaseoToolDetailSection[] {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") return [{ kind: "prose", title, text: value }];
  if (record(value))
    return Object.keys(value).length
      ? [
          {
            kind: "fields",
            title,
            fields: Object.entries(value).map(([key, child]) => ({
              label: readableLabel(key),
              value: readableValue(child),
            })),
          },
        ]
      : [];
  return [{ kind: "prose", title, text: readableValue(value) }];
}

function goalPresentation(output: unknown): { objective?: string } | undefined {
  if (!record(output) || !record(output.details)) return undefined;
  const presentation = output.details.presentation;
  if (!record(presentation) || presentation.version !== 1 || presentation.tool !== "goal_manage")
    return undefined;
  if (presentation.objective !== undefined && typeof presentation.objective !== "string")
    return undefined;
  return typeof presentation.objective === "string" ? { objective: presentation.objective } : {};
}

const JOB_LABELS: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  lost: "Execution status unavailable",
  unavailable: "Temporarily unavailable",
};

function jobLabel(job: Record<string, unknown>): string {
  if (job.status === "unavailable") return JOB_LABELS.unavailable;
  if (job.observation_only === true)
    return job.status === "running" || job.status === "starting"
      ? "Observing"
      : "Observation ended — exit status unknown";
  return JOB_LABELS[String(job.status)] ?? String(job.status ?? "Status unavailable");
}

/** Validate only the producer's first record line. Never search inside log payloads. */
function jobHeader(
  text: string,
  job: Record<string, unknown>,
): { age: string; rest: string } | undefined {
  if (
    typeof job.job_id !== "string" ||
    !/^job-[0-9a-f]{24}$/.test(job.job_id) ||
    typeof job.name !== "string"
  )
    return undefined;
  const newline = text.indexOf("\n");
  const line = newline < 0 ? text : text.slice(0, newline);
  const prefix = `${job.job_id}  ${jobLabel(job)}${typeof job.exit_code === "number" ? ` exit=${job.exit_code}` : ""}  `;
  if (!line.startsWith(prefix)) return undefined;
  const tail = line.slice(prefix.length);
  const match = /^(\d+[smh])  (.*)$/.exec(tail);
  if (!match || match[2] !== job.name) return undefined;
  return { age: match[1], rest: newline < 0 ? "" : text.slice(newline + 1) };
}

function jobSummary(job: Record<string, unknown>, age?: string): string {
  const label =
    job.status === "running" && job.timed_out === true && job.observation_only !== true
      ? "Still running"
      : jobLabel(job);
  const state = [
    label,
    ...(typeof job.exit_code === "number" && (job.exit_code !== 0 || job.status === "failed")
      ? [`exit ${job.exit_code}`]
      : []),
    ...(typeof job.signal === "string" && job.signal ? [job.signal] : []),
    ...(age ? [age] : []),
  ].join(" · ");
  return [
    typeof job.name === "string" ? job.name : "",
    state,
    ...(job.observation_only === true
      ? ["Read-only observation; no process control or exit-status guarantee."]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}

function backgroundJobActionText(
  action: unknown,
  details: Record<string, unknown>,
  texts: string[],
  output: Record<string, unknown>,
): string | undefined {
  if (action === "list" && Array.isArray(details.jobs)) {
    const jobs = details.jobs;
    const lines = texts.length === 1 ? texts[0].split("\n") : [];
    if (
      jobs.length &&
      jobs.length === lines.length &&
      jobs.every((job, i) => record(job) && jobHeader(lines[i], job))
    )
      return jobs.map((job, i) => jobSummary(job, jobHeader(lines[i], job)!.age)).join("\n\n");
    return texts.join("\n\n");
  }
  if (output.isError === true) return undefined;
  return backgroundLifecycleText(action, details, output);
}

function backgroundLifecycleText(
  action: unknown,
  details: Record<string, unknown>,
  output: Record<string, unknown>,
): string | undefined {
  if (action === "watches" && Array.isArray(details.watches))
    return (
      details.watches
        .map((watch) =>
          record(watch)
            ? `${watch.label ?? "Log watch"}\n${readableLabel(String(watch.status ?? "watching"))}`
            : "",
        )
        .join("\n\n") || "No watches for this task/session."
    );
  if (action === "watch" && details.watch_id)
    return "Watching log\nStage/match and completion alerts will reach the parent automatically.";
  if (action === "unwatch" && details.watch_id)
    return "Stopped watching. The build has NOT been cancelled.";
  if (action === "ack" && details.acknowledged_through !== undefined)
    return `Alerts acknowledged through #${details.acknowledged_through}. Newer alerts remain unread.`;
  if (action === "events" && Array.isArray(details.events)) return backgroundEventsText(details);
  if (action === "reap" && details.reaped === true)
    return [details.name, "Job reaped"].filter(Boolean).join("\n");
  if (action === "signal" && bodyText(output) === `Sent ${details.signal} to ${details.job_id}.`)
    return `${jobSummary(details)}\n\nSent ${details.signal}.`;
  return undefined;
}

function backgroundEventsText(details: Record<string, unknown>): string {
  const events = details.events as unknown[];
  return (
    [
      details.overflow
        ? "Some older alerts expired from the retained journal. Inspect the log before assuming full coverage."
        : "",
      ...events.map((event) =>
        record(event)
          ? [event.rule ?? event.kind, event.text ?? event.status].filter(Boolean).join("\n")
          : "",
      ),
    ]
      .filter(Boolean)
      .join("\n\n") || "No unread alerts."
  );
}

function normalizeBackgroundJobBody(
  action: unknown,
  details: Record<string, unknown>,
  texts: string[],
): { age?: string; body: string } {
  let age: string | undefined;
  let body = texts.join("\n\n");
  if (
    !["wait", "output", "status", "start", "adopt", "cancel"].includes(String(action)) ||
    texts.length !== 1
  )
    return { body };
  const header = jobHeader(body, details);
  if (!header) return { body };
  const layout = /^(cwd: [^\n]*)\n(command: [^\n]*)(?:\n|$)/.exec(header.rest);
  if (action !== "output" && !layout) return { body };
  age = header.age;
  body = action === "output" ? header.rest : header.rest.slice(layout![0].length);
  if (action === "wait" && details.timed_out === true) body = stripWaitDeadline(body, details);
  if (action === "start" && body === "Started in a new tmux pane.") body = "";
  if (action === "adopt") body = normalizeAdoptBody(body, details);
  return { age, body };
}

function stripWaitDeadline(body: string, details: Record<string, unknown>): string {
  const deadline =
    details.status === "running" || details.status === "starting"
      ? "Wait timed out; job is still running.\n"
      : "Job completed just after the wait deadline.\n";
  return body.startsWith(deadline) ? body.slice(deadline.length) : body;
}

function normalizeAdoptBody(body: string, details: Record<string, unknown>): string {
  if (body === "Observation only: no process control or exit-status guarantee.") return "";
  if (
    details.tracking_kind === "tmux-pane" &&
    body.startsWith(
      "Adopted the existing pane without restarting it. Tracks the pane’s root process, not individual commands inside an interactive shell.\nTo re-adopt after Pi restarts: pane_id=",
    )
  )
    return "Tracks the pane’s root process, not individual commands inside an interactive shell.";
  return body;
}

function appendBackgroundDiagnostics(body: string, details: Record<string, unknown>): string {
  for (const diagnostic of [details.error, details.reason, details.observation_error]) {
    if (typeof diagnostic === "string" && diagnostic && !body.includes(diagnostic))
      body += `${body ? "\n" : ""}${diagnostic}`;
  }
  const truncation = "[output truncated to the last 50 KiB / 2000 lines]";
  if (details.truncated === true && !body.endsWith(truncation))
    body += `${body ? "\n" : ""}${truncation}`;
  return body;
}

function backgroundJobText(input: unknown, output: unknown): string {
  if (output === null || output === undefined)
    return record(input) && typeof input.name === "string" ? input.name : "";
  if (!record(output)) return typeof output === "string" ? output : readableValue(output);
  const details = record(output.details) ? output.details : {};
  let action: unknown;
  if (typeof details.action === "string") action = details.action;
  else if (record(input)) action = input.action;
  const blocks = Array.isArray(output.content) ? output.content : [];
  const texts = blocks.map((block) =>
    record(block) && block.type === "text" && typeof block.text === "string"
      ? block.text
      : readableValue(block),
  );
  if (!Array.isArray(output.content) && output.content !== undefined)
    texts.push(readableValue(output.content));
  const actionText = backgroundJobActionText(action, details, texts, output);
  if (actionText !== undefined) return actionText;
  if (typeof details.status !== "string")
    return texts.join("\n\n") || (output.isError === true ? "Background job failed" : "");
  const normalized = normalizeBackgroundJobBody(action, details, texts);
  const body = appendBackgroundDiagnostics(normalized.body, details);
  return [jobSummary(details, normalized.age), body].filter(Boolean).join("\n\n");
}

function bodyText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!record(output)) return output == null ? "" : readableValue(output);
  if (Array.isArray(output.content))
    return output.content
      .map((block) =>
        record(block) && block.type === "text" && typeof block.text === "string"
          ? block.text
          : readableValue(block),
      )
      .join("\n\n");
  if (output.content !== undefined) return readableValue(output.content);
  if (typeof output.message === "string") return output.message;
  if (typeof output.error === "string") return output.error;
  return "";
}

const TASK_STATES: Record<string, string> = {
  delivered: "Reported delivered",
  partial: "Needs continuation",
  blocked: "Blocked",
  checkpointed: "Checkpoint saved",
  unreported: "Outcome not reported",
};
function acceptanceStatusMark(status: unknown): string {
  if (status === "passed") return "✓";
  if (status === "failed") return "✗";
  return "○";
}
function taskOutcomeText(value: Record<string, unknown>): string {
  return [
    TASK_STATES[String(value.state)] ?? "",
    value.summary,
    ...(Array.isArray(value.acceptance)
      ? value.acceptance.flatMap((a) =>
          record(a)
            ? [
                `${acceptanceStatusMark(a.status)} ${a.criterion}${a.evidence ? ` — ${a.evidence}` : ""}`,
              ]
            : [],
        )
      : []),
    ...(Array.isArray(value.remaining) && value.remaining.length
      ? ["Remaining:", ...value.remaining]
      : []),
    value.next_action ? `Next: ${value.next_action}` : "",
  ]
    .filter((v) => typeof v === "string" && v.length)
    .join("\n");
}
function childSummary(child: Record<string, unknown>, index: number): string {
  const outcome = record(child.task_outcome) ? child.task_outcome : undefined;
  let name: string;
  if (typeof child.displayName === "string" && child.displayName.trim()) name = child.displayName;
  else if (typeof child.name === "string") name = child.name;
  else if (typeof child.label === "string") name = child.label;
  else name = `Worker ${index + 1}`;
  return [
    name,
    readableLabel(String(child.status ?? "Status unavailable")),
    outcome ? TASK_STATES[String(outcome.state)] : "",
    typeof child.error === "string" ? child.error : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
/** Optional producer-owned human projection. This is not a replacement for the
 * machine envelope. Reports are already delimited here, so never regex their
 * contents. Status/notice are human labels, not control codes or inferred state.
 * Legacy unframed multi-child output remains full human text for compatibility.
 */
export interface SubagentPresentationV1 {
  version: 1;
  tool: "subagent";
  children: { name: string; status: string; report?: string; error?: string }[];
  notice?: string;
}

function subagentPresentationText(value: unknown): string | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.tool !== "subagent" ||
    !Array.isArray(value.children) ||
    (value.notice !== undefined && typeof value.notice !== "string")
  )
    return undefined;
  if (
    !value.children.every(
      (child) =>
        record(child) &&
        typeof child.name === "string" &&
        typeof child.status === "string" &&
        (child.report === undefined || typeof child.report === "string") &&
        (child.error === undefined || typeof child.error === "string"),
    )
  )
    return undefined;
  const children = value.children as SubagentPresentationV1["children"];
  return [
    ...children.map((child) =>
      [
        [child.name, child.status].filter(Boolean).join(" · "),
        child.report,
        // Only exact duplicate blocks are collapsed; never search/strip report text.
        child.error !== child.report ? child.error : "",
      ]
        .filter((v) => typeof v === "string" && v.length)
        .join("\n\n"),
    ),
    value.notice,
  ]
    .filter((v) => typeof v === "string" && v.length)
    .join("\n\n");
}

function subagentPromptText(input: unknown, output: unknown, action: unknown): string | undefined {
  if (action !== "prompt" || !record(input) || typeof input.message !== "string") return undefined;
  const outputDetails = record(output) && record(output.details) ? output.details : {};
  const response = typeof outputDetails.response === "string" ? outputDetails.response : undefined;
  return [input.message, response ? `Response\n${response}` : ""].filter(Boolean).join("\n\n");
}

function subagentResultText(
  details: Record<string, unknown>,
  action: unknown,
  text: string,
  nativeGroupReport: boolean,
): string | undefined {
  if (action !== "result" || nativeGroupReport) return undefined;
  let answer = text;
  if (
    typeof details.offset === "number" &&
    typeof details.bytes === "number" &&
    typeof details.total_bytes === "number"
  ) {
    const header =
      /^\[[^\n]+\] bytes (\d+)-(\d+) of (\d+)(?:; retained \d+ of \d+ source bytes)?\n\n/.exec(
        answer,
      );
    if (
      header &&
      Number(header[1]) === details.offset &&
      Number(header[2]) === details.offset + details.bytes &&
      Number(header[3]) === details.total_bytes
    ) {
      answer = answer.slice(header[0].length);
      const selector = details.child_id ? `child_id=${details.child_id}` : `child=${details.child}`;
      const suffix = `\n\n[Use operation=result with job_id=${details.job_id}, ${selector}, offset=${details.next_offset}${details.diagnostics ? ", diagnostics=true" : ""} to continue.]`;
      if (answer.endsWith(suffix)) answer = answer.slice(0, -suffix.length);
    }
  }
  return [answer, details.complete === false ? "[Report continues; more output is available.]" : ""]
    .filter(Boolean)
    .join("\n\n");
}

function subagentNativeGroupReport(details: Record<string, unknown>, text: string): boolean {
  return (
    record(details.group) &&
    typeof details.group.job_id === "string" &&
    text.startsWith(`${details.group.job_id} `)
  );
}

function subagentGroups(details: Record<string, unknown>): unknown[] {
  if (record(details.group)) return [details.group];
  if (Array.isArray(details.groups)) return details.groups;
  if (Array.isArray(details.jobs)) return details.jobs;
  return Array.isArray(details.children) ? [details] : [];
}

function validSubagentGroups(groups: unknown[]): boolean {
  return groups.every(
    (group) =>
      record(group) &&
      typeof group.status === "string" &&
      (!Array.isArray(group.children) ||
        group.children.every((child) => record(child) && typeof child.status === "string")),
  );
}

function subagentGroupSummaries(groups: unknown[]): string[] {
  return groups.filter(record).map((group) => {
    if (Array.isArray(group.children) && group.children.length)
      return group.children.filter(record).map(childSummary).join("\n");
    return readableLabel(String(group.status ?? "Status unavailable"));
  });
}

function stripNativeChildRows(
  text: string,
  group: Record<string, unknown>,
  summaries: string[],
): string | undefined {
  if (!Array.isArray(group.children)) return undefined;
  const children = group.children.filter(record);
  if (children.length !== 1 && group.background_subagent !== true) return text;
  const firstLine = `${group.job_id} ${group.status} (${group.mode}${group.background ? ", background" : ", foreground staged"})`;
  if (!text.startsWith(`${firstLine}\n`)) return undefined;
  let rest = text.slice(firstLine.length + 1);
  for (const [index, child] of children.entries()) {
    const row = `${index + 1}. ${child.child_id} task_id=${child.task_id} ${child.status}${child.reaped ? " [reaped]" : ""}${child.error ? `: ${child.error}` : ""}`;
    if (rest === row) rest = "";
    else if (rest.startsWith(`${row}\n`)) rest = rest.slice(row.length + 1);
    else break;
  }
  return [...summaries, rest].filter(Boolean).join("\n\n");
}

function stripBackgroundChildRows(
  text: string,
  group: Record<string, unknown>,
  summaries: string[],
): string | undefined {
  if (
    group.background_subagent !== true ||
    typeof group.job_id !== "string" ||
    !Array.isArray(group.children)
  )
    return undefined;
  const first = text.split("\n", 1)[0];
  const prefix = `${group.job_id}  ${group.status}  `;
  if (
    !first.startsWith(prefix) ||
    !/^\d+[smh]  (native|agentsh)\/(single|parallel|chain)  /.test(first.slice(prefix.length))
  )
    return undefined;
  let rest = text.slice(first.length + (text.length > first.length ? 1 : 0));
  for (const child of group.children.filter(record)) {
    const rowPrefix = `${group.job_id} child ${child.child}${child.child_id ? `  ${child.child_id}` : ""}${child.task_id ? `  ${child.task_id}` : ""}  ${child.status}  ${child.label}`;
    const row = rest.split("\n", 1)[0];
    if (row === rowPrefix || row.startsWith(`${rowPrefix}  `))
      rest = rest.slice(row.length + (rest.length > row.length ? 1 : 0));
    else break;
  }
  rest = stripTaskOutcomeRows(rest, group);
  rest = stripResultArtifactRows(rest, group);
  return [...summaries, rest].filter(Boolean).join("\n\n");
}

function stripTaskOutcomeRows(text: string, group: Record<string, unknown>): string {
  if (!Array.isArray(group.task_outcomes)) return text;
  let rest = text;
  for (const outcome of group.task_outcomes.filter(record)) {
    const row = `Task child ${outcome.child}: ${outcome.state} (${outcome.reported ? "model-reported" : "unreported"}) — ${outcome.summary}`;
    if (rest === row) rest = "";
    else if (rest.startsWith(`${row}\n`)) rest = rest.slice(row.length + 1);
  }
  return rest;
}

function stripResultArtifactRows(text: string, group: Record<string, unknown>): string {
  if (!Array.isArray(group.result_children)) return text;
  let rest = text;
  for (const artifact of group.result_children.filter(record).toReversed()) {
    const row = `result child ${artifact.child} [${artifact.label}]: ${artifact.bytes}/${artifact.total_bytes} bytes${artifact.complete ? "" : " (incomplete)"}`;
    if (rest.endsWith(`\n${row}`)) rest = rest.slice(0, -row.length - 1);
  }
  return rest;
}

function subagentGroupText(
  groups: unknown[],
  details: Record<string, unknown>,
  action: unknown,
  nativeGroupReport: boolean,
  text: string,
): string {
  if (!validSubagentGroups(groups)) return text;
  const summaries = subagentGroupSummaries(groups);
  const isReportAction =
    action === "output" ||
    action === "prompt" ||
    action === "resume" ||
    (nativeGroupReport && action !== "list" && action !== "tasks");
  if (!isReportAction) return legacySubagentGroupText(groups, details, summaries, text);
  const group = groups.length === 1 && record(groups[0]) ? groups[0] : undefined;
  if (!group) return text;
  const ordinary = stripNativeChildRows(text, group, summaries);
  if (ordinary !== undefined) return ordinary;
  const background = stripBackgroundChildRows(text, group, summaries);
  return background ?? text;
}

function legacySubagentGroupText(
  groups: unknown[],
  details: Record<string, unknown>,
  summaries: string[],
  text: string,
): string {
  const children = groups.filter(record).flatMap((group) =>
    Array.isArray(group.children)
      ? group.children.filter(record).map((child) =>
          Object.assign({}, child, {
            parentSessionId: subagentParentSession(child) ?? subagentParentSession(group),
          }),
        )
      : [],
  );
  const retained = [details.tasks, details.foreground_tasks].flatMap((tasks) =>
    Array.isArray(tasks) ? tasks.filter(record) : [],
  );
  if (children.length || retained.length) return subagentOverview([...children, ...retained]);
  const diagnosticAt = details.background_subagent === true ? text.indexOf("\nerror: ") : -1;
  return [
    ...summaries,
    details.timed_out === true ? "Still running" : "",
    diagnosticAt >= 0 ? text.slice(diagnosticAt + 1) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function subagentParentSession(task: Record<string, unknown>): string | undefined {
  return [
    task.parentSessionId,
    task.ownerSessionId,
    task.parent_session_id,
    task.owner_session_id,
  ].find((value): value is string => typeof value === "string" && value.length > 0);
}

function subagentOverview(tasks: Record<string, unknown>[]): string {
  return subagentTaskOverviewText(
    tasks.map((task, index): SubagentTaskAttempt => {
      const outcome = record(task.task_outcome) ? task.task_outcome.state : task.outcome;
      return {
        taskId: [task.task_id, task.taskId].find(
          (value): value is string => typeof value === "string",
        ),
        // Native list/tasks producers filter groups/tasks/foreground_tasks by the requesting
        // owner session; descendants are intentionally not included. This fallback is local
        // to this single tool result (the resolver retains no cross-result state). Explicit
        // parent identities, including group-level identities, always remain separate.
        parentSessionId: JSON.stringify(
          subagentParentSession(task) === undefined
            ? ["producer-scoped-parent"]
            : ["explicit-parent", subagentParentSession(task)],
        ),
        attempt: typeof task.attempt === "number" ? task.attempt : undefined,
        title:
          [task.displayName, task.title, task.name, task.label].find(
            (value): value is string => typeof value === "string" && !!value.trim(),
          ) ?? `Worker ${index + 1}`,
        execution: [task.execution, task.status, task.state].find(
          (value): value is string => typeof value === "string",
        ),
        outcome: typeof outcome === "string" ? outcome : undefined,
        // accepted_delivery alone also means no verification was configured.
        verified:
          task.accepted_delivery === true &&
          record(task.verification) &&
          task.verification.status === "passed",
      };
    }),
  );
}

function subagentTaskListText(details: Record<string, unknown>, fallback: string): string {
  const arrays = [details.tasks, details.foreground_tasks].filter(Array.isArray);
  if (!arrays.every((tasks) => tasks.every(record))) return fallback;
  return (
    subagentOverview(
      [details.tasks, details.foreground_tasks].flatMap((tasks) =>
        Array.isArray(tasks) ? tasks.filter(record) : [],
      ),
    ) || "No retained tasks in this session yet."
  );
}

function subagentText(input: unknown, output: unknown): string {
  const text = bodyText(output);
  if (!record(output) || !record(output.details)) return text;
  const details = output.details;
  if (details.presentation !== undefined) {
    const projected = subagentPresentationText(details.presentation);
    if (projected === undefined) return text;
    const presentation = details.presentation as SubagentPresentationV1;
    if (
      output.isError === true &&
      !presentation.children.some((child) => child.report || child.error)
    )
      return text;
    return projected;
  }
  if (output.isError === true) return text;
  const action = details.operation ?? (record(input) ? input.operation : undefined);
  const prompt = subagentPromptText(input, output, action);
  if (prompt !== undefined) return prompt;
  const nativeGroupReport = subagentNativeGroupReport(details, text);
  const result = subagentResultText(details, action, text, nativeGroupReport);
  if (result !== undefined) return result;
  if (
    action === "idle_decision" &&
    record(input) &&
    text ===
      `Resolved idle decision ${details.request_id} for ${details.child_id}: ${input.choice}.`
  )
    return `Idle decision: ${input.choice}`;
  if (
    action === "reap" &&
    details.reaped === true &&
    text ===
      `Reaped legacy native group ${details.job_id}: removed retained record/reports only. No processes or panes were touched.`
  )
    return "Removed retained records and reports only. No processes or panes were touched.";
  const groups = subagentGroups(details);
  if (groups.length) return subagentGroupText(groups, details, action, nativeGroupReport, text);
  if ([details.tasks, details.foreground_tasks].some(Array.isArray))
    return subagentTaskListText(details, text);
  return text;
}

function progressText(
  details: Record<string, unknown>,
  input: unknown,
  output: unknown,
  text: string,
): string {
  let steps: unknown[] | undefined;
  if (Array.isArray(details.steps)) steps = details.steps;
  else if (output == null && record(input) && Array.isArray(input.steps)) steps = input.steps;
  if (
    !steps ||
    !steps.every(
      (step) =>
        record(step) &&
        typeof step.text === "string" &&
        ["completed", "in_progress", "blocked", "pending"].includes(String(step.status)),
    )
  )
    return text;
  return (
    steps
      .filter(record)
      .map(
        (step) =>
          `${({ completed: "✓", in_progress: "…", blocked: "⊘", pending: "○" } as Record<string, string>)[String(step.status)] ?? "○"} ${step.text}`,
      )
      .join("\n") || "Progress cleared."
  );
}

function questionnaireText(details: Record<string, unknown>, text: string): string {
  if (
    !Array.isArray(details.answers) ||
    !Array.isArray(details.questions) ||
    !details.answers.length
  )
    return text;
  return details.answers
    .filter(record)
    .map((answer) => {
      const question = (details.questions as unknown[]).find(
        (q) => record(q) && q.id === answer.id,
      );
      return [
        record(question) && typeof question.prompt === "string" ? question.prompt : "Answer",
        typeof answer.label === "string" ? answer.label : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function taskOutcomeHarnessText(
  details: Record<string, unknown>,
  input: unknown,
  output: unknown,
  text: string,
): string {
  let outcome: Record<string, unknown> | undefined;
  if (record(details.task_outcome)) outcome = details.task_outcome;
  else if (output == null && record(input)) outcome = input;
  return outcome ? taskOutcomeText(outcome) : text;
}

function goalWaitText(details: Record<string, unknown>, text: string): string | undefined {
  if (typeof details.reason !== "string") return undefined;
  const report = `Goal waiting: ${details.reason}`;
  const clamp = `\nRequested resume_after_ms ${details.requested_resume_after_ms} was clamped to ${details.resume_after_ms}.`;
  return text === report || text === report + clamp ? report : undefined;
}

function harnessText(name: string, input: unknown, output: unknown): string {
  const text = bodyText(output);
  const details = record(output) && record(output.details) ? output.details : {};
  if (name === "subagent") return subagentText(input, output);
  if (record(output) && output.isError === true) return text;
  if (name === "update_progress") return progressText(details, input, output, text);
  if (name === "questionnaire") return questionnaireText(details, text);
  if (name === "task_outcome") return taskOutcomeHarnessText(details, input, output, text);
  if (name === "notify_parent")
    return record(input) &&
      typeof input.message === "string" &&
      (output == null || text === "Queued for the parent; no reply yet.")
      ? input.message
      : text;
  if (name === "goal_wait") return goalWaitText(details, text) ?? text;
  if (
    name === "goal_blocked" &&
    typeof details.reason === "string" &&
    text === `Goal blocked: ${details.reason}`
  )
    return [text, details.evidence].filter((v) => typeof v === "string" && v.length).join("\n\n");
  return text;
}

/** Presentation only. The timeline detail and machine-facing results remain untouched. */
export function buildGenericToolSections(
  name: string,
  input: unknown,
  output: unknown,
): PaseoToolDetailSection[] {
  if (name === "background_job") {
    const text = backgroundJobText(input, output);
    return text ? [{ kind: "prose", title: "", text }] : [];
  }
  if (STRUCTURED_TOOLS.has(name) && name !== "goal_manage") {
    const text = harnessText(name, input, output);
    return text ? [{ kind: "prose", title: "", text }] : [];
  }
  const displayed = presentOutput(name, output);
  if (name === "goal_manage") {
    if (output === null || output === undefined) {
      return record(input) && typeof input.objective === "string"
        ? [
            {
              kind: "fields",
              title: "Input",
              fields: [{ label: "Objective", value: input.objective }],
            },
          ]
        : [];
    }
    if (record(output) && output.isError === true) {
      const text = bodyText(output);
      return text ? [{ kind: "prose", title: "", text }] : [];
    }
    const presentation = goalPresentation(output);
    return [
      {
        kind: "fields",
        title: "Output",
        fields: [
          {
            label: "Objective",
            value: presentation ? (presentation.objective ?? "None") : "Not available",
          },
        ],
      },
    ];
  }
  const sections = section("Input", input);
  if (record(displayed) && Array.isArray(displayed.content)) {
    const { content, ...metadata } = displayed;
    const blocks = content.flatMap((block, index) =>
      section(content.length === 1 ? "Output" : `Output ${index + 1}`, block),
    );
    return [...sections, ...blocks, ...section("Result details", metadata)];
  }
  return [...sections, ...section("Output", displayed)];
}

export function genericToolText(name: string, input: unknown, output: unknown): string {
  return buildGenericToolSections(name, input, output)
    .map((part) =>
      part.kind === "prose"
        ? `${part.title ? `${part.title}\n` : ""}${part.text}`
        : `${name === "goal_manage" ? "" : `${part.title}\n`}${part.fields.map((field) => `${field.label}: ${field.value}`).join("\n")}`,
    )
    .join("\n\n");
}

export function hasGenericToolPresentation(name: string): boolean {
  return STRUCTURED_TOOLS.has(name);
}
