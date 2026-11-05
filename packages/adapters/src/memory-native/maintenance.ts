import type { JobPublisher } from "@rakazo/adapter-kit";
import { memoryConsolidateJob, memoryDreamJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { observersDueForConsolidation } from "./consolidate.js";
import { observersDueForDream } from "./dream.js";

/** How often the sweep looks for observers whose facts are due (self-throttled). */
const SWEEP_INTERVAL_MS = 15 * 60_000;

export interface MemoryMaintenanceDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
}

/**
 * Sweeps Spaces with the native provider configured and enqueues consolidation and
 * dream work for observers that crossed their thresholds. Runs from the reconciler's
 * elected leader, so concurrent instances never duplicate the sweep; each enqueued job
 * is keyed per observer, so a slow pass folds into the next one.
 */
export function createMemoryMaintenance(
  deps: MemoryMaintenanceDeps,
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  let lastRun: number | undefined;

  return async () => {
    const now = Date.now();
    if (lastRun !== undefined && now - lastRun < intervalMs) return;
    lastRun = now;

    // Only Spaces that connected the built-in provider have facts to maintain.
    const configs = await runAsSystem("native memory maintenance scan", () =>
      deps.prisma.spaceMemoryConfig.findMany({
        where: { provider: "native" },
        select: { spaceId: true, userId: true },
      }),
    );
    for (const config of configs) {
      try {
        const [consolidate, dreams] = await Promise.all([
          observersDueForConsolidation(deps.prisma, config.spaceId),
          observersDueForDream(deps.prisma, config.spaceId),
        ]);
        await Promise.all([
          ...consolidate.map((botId) =>
            deps.jobs.enqueue({
              ...memoryConsolidateJob(config.spaceId, config.userId, botId),
              keepExisting: true,
            }),
          ),
          ...dreams.map((botId) =>
            deps.jobs.enqueue({
              ...memoryDreamJob(config.spaceId, config.userId, botId),
              keepExisting: true,
            }),
          ),
        ]);
      } catch (error) {
        getLogger().error("native memory maintenance failed", { spaceId: config.spaceId, error });
      }
    }
  };
}
