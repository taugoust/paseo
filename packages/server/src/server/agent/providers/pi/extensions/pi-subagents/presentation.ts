import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { extractTextFromToolResult, mapToolDetail, parseToolArgs, type PiToolResult } from "../../tool-call-mapper.js";

// Existing adapter presentation only. Runtime discovery/hydration and events
// remain in index.ts; this module must stay dependency-free except zod/mapper.
const Args = z.object({
  agent: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
  async: z.boolean().optional(),
  action: z.unknown().optional(),
}).passthrough();
export interface SubagentPresentationCall {
  callId: string; toolName: string; args: unknown; result: PiToolResult;
}
export function projectSubagentToolPresentation(call: SubagentPresentationCall):
  | { managed: true; detail: ToolCallDetail }
  | { managed: false; detail: ToolCallDetail; args: z.infer<typeof Args> & { agent: string; task: string } }
  | undefined {
  if (call.toolName !== "subagent") return;
  if (/::paseo-child::\d+$/.test(call.callId) ||
      (typeof call.args === "object" && call.args !== null && "_paseoWorkAgent" in call.args && call.args._paseoWorkAgent === true) ||
      (typeof call.result === "object" && call.result?.details?.tui_subagent === true)) {
    const { _paseoWorkAgent: _, ...args } = (call.args ?? {}) as Record<string, unknown>;
    return { managed: true, detail: mapToolDetail(parseToolArgs(call.toolName, args), call.result) };
  }
  const args = Args.safeParse(call.args);
  if (!args.success || args.data.action !== undefined || !args.data.agent || !args.data.task) return;
  return { managed: false, args: args.data as z.infer<typeof Args> & { agent: string; task: string }, detail: {
    type: "sub_agent", subAgentType: args.data.agent, description: args.data.task,
    log: extractTextFromToolResult(call.result)?.trim() ?? "",
  } };
}
