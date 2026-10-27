import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import {
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
} from "../provider-image-output.js";
import type { PiToolResult } from "./tool-call-mapper.js";

/**
 * Convert final Pi image result blocks into the same assistant Markdown
 * timeline entries used by native providers. Keep the source result untouched:
 * tool-call detail/history still owns the original image payload.
 */
export function mapPiToolResultImages(result: PiToolResult, callId: string): AgentTimelineItem[] {
  if (!result || typeof result === "string" || !Array.isArray(result.content)) return [];

  const items: AgentTimelineItem[] = [];
  let imageIndex = 0;
  for (const block of result.content) {
    if (!block || typeof block !== "object" || block.type !== "image") continue;
    const candidate = block as {
      path?: unknown;
      url?: unknown;
      data?: unknown;
      mimeType?: unknown;
      altText?: unknown;
    };
    const item = renderProviderImageOutputAsAssistantMarkdown(
      {
        path: typeof candidate.path === "string" ? candidate.path : null,
        url: typeof candidate.url === "string" ? candidate.url : null,
        data: typeof candidate.data === "string" ? candidate.data : null,
        mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : null,
        altText: typeof candidate.altText === "string" ? candidate.altText : null,
      },
      { materialize: materializeProviderImage },
    );
    if (!item || item.type !== "assistant_message") continue;
    items.push({ ...item, messageId: `${callId}-image-${imageIndex}` });
    imageIndex += 1;
  }
  return items;
}
