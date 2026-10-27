/** Pure human overview projection. Original records remain the diagnostic source. */
export interface SubagentTaskAttempt {
  taskId?: string;
  parentSessionId?: string;
  attempt?: number;
  title: string;
  execution?: string;
  outcome?: string;
  verified?: boolean;
}

export interface SubagentTaskSummary {
  title: string;
  status: string;
  section: "Running" | "Needs attention" | "Finished";
}

export function resolveSubagentTaskStatus(task: SubagentTaskAttempt): SubagentTaskSummary {
  const execution = task.execution?.toLowerCase();
  const row = (status: string, section: SubagentTaskSummary["section"]): SubagentTaskSummary => ({
    title: task.title,
    status,
    section,
  });
  if (["running", "pending", "queued", "starting", "launching"].includes(execution ?? ""))
    return row("Running", "Running");
  if (execution === "waiting-input" || execution === "waiting-permission")
    return row("Needs follow-up", "Needs attention");
  if (execution === "skipped") return row("Skipped", "Finished");
  if (execution === "lost") return row("Lost", "Needs attention");
  if (execution === "failed" || execution === "error") return row("Failed", "Needs attention");
  if (execution === "cancelled" || execution === "canceled") return row("Cancelled", "Finished");
  if (execution === "blocked" || task.outcome === "blocked")
    return row("Blocked", "Needs attention");
  if (task.outcome === "partial" || task.outcome === "checkpointed")
    return row("Needs follow-up", "Needs attention");
  if (task.outcome === "delivered")
    return row(task.verified === true ? "Complete" : "Reported complete", "Finished");
  if (["completed", "finished", "reaped"].includes(execution ?? ""))
    return row("Finished — outcome unknown", "Finished");
  return row("Status unavailable", "Needs attention");
}

/** Only a producer-verified session + task identity and ordered attempt can collapse rows.
 * Missing identity stays separate; display names never establish task identity.
 */
export function summarizeSubagentTasks(
  tasks: readonly SubagentTaskAttempt[],
): SubagentTaskSummary[] {
  const latest = new Map<string, number>();
  const retained: SubagentTaskAttempt[] = [];
  for (const task of tasks) {
    const key =
      task.parentSessionId &&
      task.taskId &&
      Number.isSafeInteger(task.attempt) &&
      (task.attempt ?? 0) > 0
        ? JSON.stringify([task.parentSessionId, task.taskId])
        : undefined;
    const index = key === undefined ? undefined : latest.get(key);
    if (index === undefined) {
      if (key !== undefined) latest.set(key, retained.length);
      retained.push(task);
    } else if (task.attempt! > retained[index].attempt!) retained[index] = task;
  }
  return retained.map(resolveSubagentTaskStatus);
}

export function subagentTaskOverviewText(tasks: readonly SubagentTaskAttempt[]): string {
  const rows = summarizeSubagentTasks(tasks);
  return (["Running", "Needs attention", "Finished"] as const)
    .flatMap((section) => {
      const group = rows.filter((row) => row.section === section);
      return group.length
        ? [
            `${section}\n${group.map((row) => `• ${row.title.replace(/[\r\n]+/g, " ")} · ${row.status}`).join("\n")}`,
          ]
        : [];
    })
    .join("\n\n");
}
