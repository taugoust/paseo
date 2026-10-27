import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Read-only managed-child classification for notifications and workspace metadata; never runtime ownership. */
export async function isManagedPiChild(agent: {
  id: string;
  provider: string;
  persistence?: { nativeHandle?: string } | null;
}): Promise<boolean> {
  const sessionFile = agent.persistence?.nativeHandle;
  if (agent.provider !== "pi" || !sessionFile || !path.isAbsolute(sessionFile)) return false;
  const normalized = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const key = createHash("sha256").update(normalized(sessionFile)).digest("hex");
  try {
    // The bridge atomically publishes this private, per-session record. Do not
    // infer ancestry from titles, cwd, pane placement, or Paseo parent labels.
    const record = JSON.parse(
      await readFile(
        path.join(homedir(), ".pi", "paseo-bridge", "runtimes", `${key}.json`),
        "utf8",
      ),
    );
    const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
    return (
      record?.schemaVersion === 2 &&
      record.agentId === agent.id &&
      typeof record.sessionFile === "string" &&
      normalized(record.sessionFile) === normalized(sessionFile) &&
      record.managed === true &&
      nonempty(record.runtimeId) &&
      nonempty(record.parentSessionId) &&
      nonempty(record.childId)
    );
  } catch {
    // Missing/unreadable/invalid evidence must not mute ordinary parent agents.
    return false;
  }
}
