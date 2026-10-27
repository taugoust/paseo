import { describe, expect, test } from "vitest";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import pino from "pino";
import { PiRpcAgentClient } from "./agent.js";
import { FakePi } from "./test-utils/fake-pi.js";
import { streamPiHistory } from "./history-mapper.js";
import { mapPiToolResultImages } from "./tool-result-images.js";
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
  ],
};

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
    const direct = mapPiToolResultImages(result, "call-images");
    expect(direct).toHaveLength(2);
    expect(direct.map((item) => item.type === "assistant_message" && item.messageId)).toEqual([
      "call-images-image-0",
      "call-images-image-1",
    ]);
    expect(direct.every((item) => item.type === "assistant_message")).toBe(true);
    expect(direct.map((item) => item.type === "assistant_message" && item.text)).toEqual([
      expect.stringMatching(/!\[first\]\(file:\/\//),
      expect.stringMatching(/!\[second\]\(file:\/\//),
    ]);
    expect(mapPiToolResultImages(result, "call-images")).toEqual(direct);

    const events = await history();
    expect(assistantImages(events)).toEqual(direct);
    const settled = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    expect(
      settled?.type === "timeline" && settled.item.type === "tool_call" && settled.item.detail,
    ).toMatchObject({
      type: "unknown",
      output: { content: result.content },
    });
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
    expect(assistantImages(failed)).toEqual(mapPiToolResultImages(result, "call-images"));
    expect(
      failed.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.status === "failed",
      ),
    ).toBe(true);
    expect(
      mapPiToolResultImages({ content: [{ type: "text", text: "only text" }] }, "text-call"),
    ).toEqual([]);
    expect(
      mapPiToolResultImages(
        { content: [{ type: "image", data: "", mimeType: "image/png" }] },
        "empty-call",
      ),
    ).toEqual([]);
    expect(mapPiToolResultImages(null, "null-call")).toEqual([]);
  });

  test("history image identities use the resolved child/tool scope", async () => {
    expect(assistantImages(await history(false, "child:"))).toEqual(
      mapPiToolResultImages(result, "child:call-images"),
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
      expect(assistantImages(events)).toEqual(assistantImages(await history()));
      fake.emit({
        type: "tool_execution_end",
        toolCallId: "failure-images",
        toolName: "custom_image_tool",
        result,
        isError: true,
      });
      expect(assistantImages(events).slice(2)).toEqual(
        mapPiToolResultImages(result, "failure-images"),
      );
    } finally {
      await session.close();
    }
  });
});
