import { describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import pino from "pino";
import { PiRpcAgentClient } from "./agent.js";
import { FakePi } from "./test-utils/fake-pi.js";
import { streamPiHistory } from "./history-mapper.js";
import {
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
} from "../provider-image-output.js";
import { splitPiToolResultImages, type PiToolResult } from "./tool-call-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

const result = {
  content: [
    { type: "text", text: "created images" },
    {
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
      mimeType: "image/png",
      altText: "first",
    },
    {
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
      mimeType: "image/png",
      altText: "second",
    },
    { type: "image", path: "/tmp/generated.png", altText: "path image" },
    { type: "image", url: "https://example.test/generated.png", altText: "remote image" },
  ],
  structuredContent: {
    nested: {
      type: "image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
    },
  },
};

async function nativeImages(toolResult: PiToolResult, callId: string) {
  const { images } = splitPiToolResultImages(toolResult);
  const items = [];
  for (const [index, image] of images.entries()) {
    const item = await renderProviderImageOutputAsAssistantMarkdown(image, {
      materialize: materializeProviderImage,
    });
    if (item) items.push({ ...item, messageId: `${callId}-image-${index}` });
  }
  return items;
}

async function history(isError = false, prefix = ""): Promise<AgentStreamEvent[]> {
  const messages: PiAgentMessage[] = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-images", name: "custom_image_tool", arguments: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "call-images",
      toolName: "custom_image_tool",
      content: result.content,
      isError,
    },
  ];
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", messages, [], {
    resolveToolCallId: (id) => prefix + id,
  }))
    events.push(event);
  return events;
}

function assistantImages(events: AgentStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item] : [],
  );
}

describe("Pi tool result image timeline", () => {
  test("uses native markdown image entries with deterministic IDs, order, and materialized URIs", async () => {
    const direct = await nativeImages(result, "call-images");
    expect(direct).toHaveLength(4);
    expect(direct.map((item) => item.type === "assistant_message" && item.messageId)).toEqual([
      "call-images-image-0",
      "call-images-image-1",
      "call-images-image-2",
      "call-images-image-3",
    ]);
    expect(direct.every((item) => item.type === "assistant_message")).toBe(true);
    expect(direct.map((item) => item.type === "assistant_message" && item.text)).toEqual([
      expect.stringMatching(/!\[first\]\(file:\/\//),
      expect.stringMatching(/!\[second\]\(file:\/\//),
      expect.stringMatching(/!\[path image\]\(file:\/\//),
      expect.stringMatching(/!\[remote image\]\(https:\/\//),
    ]);
    expect(await nativeImages(result, "call-images")).toEqual(direct);

    const events = await history();
    expect(assistantImages(events)).toEqual(direct);
    const settled = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    expect(JSON.stringify(settled)).not.toContain(result.content[1].data);
    expect(JSON.stringify(settled)).toContain("[image]");
    expect(JSON.stringify(settled)).not.toContain("/tmp/generated.png");
    expect(JSON.stringify(settled)).not.toContain("https://example.test/generated.png");
    expect(
      events.findIndex(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.status === "completed",
      ),
    ).toBeLessThan(
      events.findIndex(
        (event) => event.type === "timeline" && event.item.type === "assistant_message",
      ),
    );
  });

  test("retains useful failure screenshots without changing failed tool status", async () => {
    const failed = await history(true);
    expect(assistantImages(failed)).toEqual(await nativeImages(result, "call-images"));
    expect(
      failed.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.status === "failed",
      ),
    ).toBe(true);
    expect(
      await nativeImages({ content: [{ type: "text", text: "only text" }] }, "text-call"),
    ).toEqual([]);
    expect(
      await nativeImages(
        { content: [{ type: "image", data: "", mimeType: "image/png" }] },
        "empty-call",
      ),
    ).toEqual([]);
    expect(await nativeImages(null, "null-call")).toEqual([]);
  });

  test("history image identities use the resolved child/tool scope", async () => {
    expect(assistantImages(await history(false, "child:"))).toEqual(
      await nativeImages(result, "child:call-images"),
    );
  });

  test("live session final results match history without emitting partial-result images", async () => {
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({ provider: "pi", cwd: "/tmp/pi-image-fixture" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("offline image fixture");
      const fake = pi.latestSession();
      fake.emit({
        type: "tool_execution_start",
        toolCallId: "call-images",
        toolName: "custom_image_tool",
        args: {},
      });
      fake.emit({
        type: "tool_execution_update",
        toolCallId: "call-images",
        toolName: "custom_image_tool",
        partialResult: result,
      });
      expect(assistantImages(events)).toEqual([]);
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "call-images",
        toolName: "custom_image_tool",
        result,
        isError: false,
      });
      await expect.poll(() => assistantImages(events)).toEqual(assistantImages(await history()));
      const successfulImageCount = assistantImages(events).length;
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "failure-images",
        toolName: "custom_image_tool",
        result,
        isError: true,
      });
      await expect
        .poll(() => assistantImages(events).slice(successfulImageCount))
        .toEqual(await nativeImages(result, "failure-images"));
    } finally {
      await session.close();
    }
  });
});
