import { importSessionFromPersistence } from "./provider-session-import.js";
import type { ImportedProviderSession } from "./agent-sdk-types.js";

/** Import is attachment, not a request to change an existing Pi's selection.
 * A fresh session may not have flushed model_change yet; daemon defaults and
 * even an older on-disk descriptor must not replace the live runtime state.
 */
export async function importPiSessionPreservingSelection(
  input: Parameters<typeof importSessionFromPersistence>[0],
): Promise<ImportedProviderSession> {
  const imported = await importSessionFromPersistence({
    ...input,
    config: { ...input.config, model: undefined, thinkingOptionId: undefined },
  });
  try {
    const live = await imported.session.getRuntimeInfo();
    const selection = {
      model: live.model ?? undefined,
      thinkingOptionId: live.thinkingOptionId ?? undefined,
    };
    return {
      ...imported,
      config: { ...imported.config, ...selection },
      persistence: {
        ...imported.persistence,
        metadata: { ...imported.persistence.metadata, ...selection },
      },
    };
  } catch (error) {
    await imported.session.close().catch(() => undefined);
    throw error;
  }
}
