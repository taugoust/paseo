// Bounded RPC subprocess for production PiCliRuntime integration tests. No model/network.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const file = process.argv[process.argv.indexOf("--session") + 1];
const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
appendFileSync(
  process.env.INDEPENDENT_TEST_LOG,
  JSON.stringify({ type: "spawn", pid: process.pid, file }) + "\n",
);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  let data = {};
  if (command.type === "get_state")
    data = {
      sessionId: header.id,
      sessionFile: file,
      model: null,
      thinkingLevel: "low",
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  if (command.type === "get_commands") data = { commands: [] };
  if (command.type === "get_messages") data = { messages: [] };
  if (command.type === "get_session_stats")
    data = { tokens: { input: 0, output: 0, total: 0 }, cost: 0 };
  if (command.type === "prompt") {
    appendFileSync(
      process.env.INDEPENDENT_TEST_LOG,
      JSON.stringify({ type: "prompt", message: command.message }) + "\n",
    );
    appendFileSync(
      file,
      JSON.stringify({
        type: "message",
        id: "progress",
        parentId: null,
        message: { role: "user", content: command.message },
      }) + "\n",
    );
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type === "prompt") {
    send({ type: "agent_start" });
    send({ type: "agent_end", messages: [] });
  }
});
