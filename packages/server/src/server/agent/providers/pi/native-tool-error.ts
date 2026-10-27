import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";

/** Timeline.error is human presentation. Keep the original provider result in
 * its original machine-facing channel and normalize only this display value so
 * older native clients do not stringify a tool-result envelope. */
export function nativeToolErrorText(error: unknown, toolName?: string): string {
  // Native background jobs retain the combined terminal log in their original
  // result. Error is the independently captured stderr, not a second copy of
  // that combined log. Legacy/adopted jobs cannot reconstruct stderr.
  if (
    toolName === "background_job" &&
    error &&
    typeof error === "object" &&
    !Array.isArray(error)
  ) {
    const details = (error as { details?: Record<string, unknown> }).details;
    if (
      details &&
      ["wait", "output", "status"].includes(String(details.action)) &&
      typeof details.job_id === "string" &&
      /^job-[0-9a-f]{24}$/.test(details.job_id) &&
      details.status === "failed"
    ) {
      const streams = details.streams as { available?: unknown; stderr?: unknown } | undefined;
      if (
        streams?.available === true &&
        typeof streams.stderr === "string" &&
        streams.stderr.trim()
      )
        return streams.stderr.trim();
      if (typeof details.signal === "string" && /^SIG[A-Z0-9]+$/.test(details.signal))
        return `Job terminated by ${details.signal}`;
      if (typeof details.exit_code === "number" && Number.isSafeInteger(details.exit_code))
        return `Job exited with code ${details.exit_code}`;
      return "Job failed";
    }
  }
  return (
    buildToolCallDisplayModel({
      name: "tool",
      status: "failed",
      error,
      detail: { type: "unknown", input: null, output: null },
    }).errorText ?? "Tool call failed"
  );
}
