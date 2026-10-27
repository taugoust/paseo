import type { PiExtensionCustomMapping } from "../contract.js";

export const NATIVE_SUBAGENTS_PREFIX = "PI_NATIVE_SUBAGENTS_V1:";
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_BINDINGS = 128;
const MAX_ID_LENGTH = 1024;
const MAX_TASK_ID_LENGTH = 1024;
const MAX_CHILD_ID_LENGTH = 1024;
const MAX_RUNTIME_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_AGENT_LENGTH = 256;
const MAX_TASK_LENGTH = 4096;
const STATUSES = ["running", "completed", "failed", "cancelled", "lost"] as const;

interface Binding {
  id: string;
  taskId: string;
  childId: string;
  attempt: number;
  runtimeId: string | null;
  sessionFile?: string;
  hidden?: boolean;
  status: (typeof STATUSES)[number];
  agent: string;
  task?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function hasForbiddenControlCharacter(value: string, allowTaskWhitespace = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x7f || code <= 0x1f) {
      if (allowTaskWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
  }
  return false;
}

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !hasForbiddenControlCharacter(value)
  );
}

function nativeId(value: unknown, prefix: "task" | "child", max: number): value is string {
  return boundedString(value, max) && new RegExp(`^subagent-${prefix}-[0-9a-f]{24}$`).test(value);
}

function boundedTask(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TASK_LENGTH &&
    value.trim() === value &&
    !hasForbiddenControlCharacter(value, true)
  );
}

function validBindingIdentity(
  id: unknown,
  taskId: unknown,
  childId: unknown,
  attempt: unknown,
  runtimeId: unknown,
  status: unknown,
  agent: unknown,
): boolean {
  return (
    boundedString(id, MAX_ID_LENGTH) &&
    nativeId(taskId, "task", MAX_TASK_ID_LENGTH) &&
    nativeId(childId, "child", MAX_CHILD_ID_LENGTH) &&
    Number.isSafeInteger(attempt) &&
    (attempt as number) >= 1 &&
    (runtimeId === null || boundedString(runtimeId, MAX_RUNTIME_ID_LENGTH)) &&
    STATUSES.includes(status as Binding["status"]) &&
    boundedString(agent, MAX_AGENT_LENGTH)
  );
}

function validBindingOptions(sessionFile: unknown, hidden: unknown, task: unknown): boolean {
  return (
    (sessionFile === undefined ||
      (boundedString(sessionFile, MAX_PATH_LENGTH) && sessionFile.startsWith("/"))) &&
    (hidden === undefined || typeof hidden === "boolean") &&
    (task === undefined || boundedTask(task))
  );
}

function parseBinding(entry: unknown, ids: Set<string>): Binding | undefined {
  if (
    !isRecord(entry) ||
    !exactKeys(
      entry,
      ["id", "taskId", "childId", "attempt", "runtimeId", "status", "agent"],
      ["sessionFile", "task", "hidden"],
    )
  )
    return undefined;
  const { id, taskId, childId, attempt, runtimeId, sessionFile, status, agent, task, hidden } =
    entry;
  if (!validBindingIdentity(id, taskId, childId, attempt, runtimeId, status, agent))
    return undefined;
  if (!validBindingOptions(sessionFile, hidden, task) || ids.has(id as string)) return undefined;
  ids.add(id as string);
  return {
    id: id as string,
    taskId: taskId as string,
    childId: childId as string,
    hidden: hidden === true,
    attempt: attempt as number,
    runtimeId: runtimeId as string | null,
    ...(sessionFile === undefined ? {} : { sessionFile: sessionFile as string }),
    status: status as Binding["status"],
    agent: agent as string,
    ...(task === undefined ? {} : { task: task as string }),
  };
}

function parsePayload(message: string): Binding[] | undefined | null {
  if (!message.startsWith(NATIVE_SUBAGENTS_PREFIX)) return undefined;
  if (message.length > MAX_MESSAGE_LENGTH) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(message.slice(NATIVE_SUBAGENTS_PREFIX.length));
  } catch {
    return null;
  }
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["version", "bindings"]) ||
    raw.version !== 1 ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length > MAX_BINDINGS
  )
    return null;
  const ids = new Set<string>();
  const bindings: Binding[] = [];
  for (const entry of raw.bindings) {
    const binding = parseBinding(entry, ids);
    if (!binding) return null;
    bindings.push(binding);
  }
  return bindings;
}

/** Retire legacy bridge descriptors without deleting their retained timelines.
 * New bridges never publish this protocol. Old/reconnecting bridges can only
 * hide existing rows, never register workers or start native session readers.
 */
export function createNativeSubagentMapper(
  _alreadyHydratedFiles: Set<string> = new Set(),
): (message: string) => PiExtensionCustomMapping | undefined {
  return (message) => {
    const bindings = parsePayload(message);
    if (bindings === undefined) return undefined;
    // A claimed but invalid protocol marker is deliberately swallowed, never shown as user text.
    if (bindings === null) return { subagents: [] };
    return { subagents: bindings.map(({ id }) => ({ type: "hide", id })) };
  };
}
