import { createHash } from "node:crypto";
import { z } from "zod";
import type { PiExtension } from "./contract.js";

const Details = z
  .object({
    version: z.literal(5),
    goalId: z.string().min(1).max(128).optional(),
    revision: z.number().int().nonnegative().optional(),
    activationId: z.string().min(1).max(128).optional(),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128).optional(),
            text: z
              .string()
              .min(1)
              .max(16 * 1024),
            status: z.enum(["pending", "in_progress", "completed", "blocked"]),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

/** Use Paseo's native todo timeline, for both streamed results and history replay. */
export const piProgress: PiExtension = {
  id: "pi-progress",
  createSession: () => ({
    mapToolCall(call) {
      if (
        call.toolName !== "update_progress" ||
        call.status !== "completed" ||
        !call.result ||
        typeof call.result === "string"
      )
        return;
      const parsed = Details.safeParse(call.result.details);
      if (!parsed.success) return;
      // Keep the completed snapshot: native Paseo derives its checkmarked
      // completion activities from the transition, and retains checked rows.
      // An explicit empty update still clears the checklist.
      const occurrences = new Map<string, number>();
      return {
        timeline: [
          {
            type: "todo",
            items: parsed.data.steps.map((step) => {
              // Stable across reordering; repeated step labels remain distinct.
              const hash = createHash("sha256").update(step.text).digest("hex").slice(0, 24);
              const occurrence = occurrences.get(hash) ?? 0;
              occurrences.set(hash, occurrence + 1);
              return {
                id: step.id
                  ? `pi-progress-${parsed.data.goalId ?? "standalone"}-${step.id}`
                  : `pi-progress-${hash}-${occurrence}`,
                // Native tasks have no blocked enum. Preserve it explicitly in text,
                // with completed=false, rather than treating it as done or active.
                text: step.status === "blocked" ? `Blocked · ${step.text}` : step.text,
                status: step.status === "blocked" ? ("pending" as const) : step.status,
                completed: step.status === "completed",
              };
            }),
          },
        ],
      };
    },
  }),
};
