/** Pure public presentation entry. These implementations are also used by the
 * Pi provider; plugins bundle them rather than importing daemon runtime. */
import { mapToolDetail, type PiTrackedToolCall, type PiToolResult } from "./tool-call-mapper.js";
import { projectSubagentToolPresentation } from "./extensions/pi-subagents/presentation.js";
export { parseToolArgs, parseToolResult, mapToolDetail } from "./tool-call-mapper.js";
export type { PiTrackedToolCall, PiToolResult } from "./tool-call-mapper.js";
export { nativeToolErrorText } from "./native-tool-error.js";
export { projectSubagentToolPresentation } from "./extensions/pi-subagents/presentation.js";

/** Native adapter presentation precedence, without discovery/hydration/events. */
export function mapPiToolCallDetail(tracked: PiTrackedToolCall, result: PiToolResult, callId = "") {
  return projectSubagentToolPresentation({callId,toolName:tracked.toolName,args:tracked.args,result})?.detail
    ?? mapToolDetail(tracked,result);
}
