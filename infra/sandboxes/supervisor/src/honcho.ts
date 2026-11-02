import { createHash, randomBytes } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import type Docker from "dockerode";
import { z } from "zod";

const managed = { name: "rakazo-honcho", image: "rakazo/honcho:local" };

export const honchoConfigurationSchema = z.object({
  databaseUrl: z.string().min(1),
  adminToken: z.string().min(32),
  cacheUrl: z.string().min(1),
  models: z.record(z.string(), z.string()),
  deriverWorkers: z.number().int().min(1).max(32).optional().default(1),
  configurationHash: z.string().length(64).optional(),
});
export type HonchoConfiguration = z.infer<typeof honchoConfigurationSchema>;

export function honchoEnvironment(input: HonchoConfiguration): Record<string, string> {
  return {
    DB_CONNECTION_URI: input.databaseUrl,
    CACHE_ENABLED: "true",
    CACHE_URL: input.cacheUrl,
    CACHE_NAMESPACE: "rakazo",
    AUTH_USE_AUTH: "true",
    // Honcho's static admin bearer (Rakazo-side addition); the JWT_SECRET
    // stays unset so the deployment presents exactly one credential.
    AUTH_STATIC_ADMIN_TOKEN: input.adminToken,
    // Run the deriver queue loop inside the API process (Rakazo-side
    // addition): one container serves both roles, and the queue itself is
    // Postgres-backed either way.
    DERIVER_EMBEDDED: "true",
    VECTOR_STORE_TYPE: "pgvector",
    TELEMETRY_ENABLED: "false",
    ...input.models,
  };
}

export async function honchoRedisReachable(cacheUrl: string, overrideHost?: string) {
  const redis = await import("node:net");
  const url = new URL(cacheUrl);
  const host =
    overrideHost || (url.hostname === "host.docker.internal" ? "127.0.0.1" : url.hostname);
  return new Promise<boolean>((resolve) => {
    const socket = redis.createConnection({
      host,
      port: Number(url.port || 6379),
      timeout: 2000,
    });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => {
      socket.write("*1\r\n$4\r\nPING\r\n");
    });
    socket.once("data", (data) => finish(data.toString().startsWith("+PONG")));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** A shared queue across restarts lives in Postgres; stopping only stops its consumers. */
export function createHonchoService(docker: Docker) {
  let pending: Promise<void> | undefined;
  // Resolved by ensureImage, so the schema check can tell whether the running
  // container came from the image being applied.
  let imageDigest: string | undefined;
  const fingerprint = (input: HonchoConfiguration) =>
    createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const appliedFingerprint = (input: HonchoConfiguration) =>
    input.configurationHash ?? fingerprint(input);
  const image = process.env.HONCHO_IMAGE || managed.image;
  const host = process.env.HONCHO_HOST || "127.0.0.1";
  const internalHost = process.env.HONCHO_INTERNAL_HOST || host;
  const port = process.env.HONCHO_PORT || "8000";
  const apiUrl = process.env.HONCHO_URL || `http://${internalHost}:8000`;

  function environment(input: HonchoConfiguration): Record<string, string> {
    return {
      ...honchoEnvironment(input),
      DERIVER_WORKERS: String(input.deriverWorkers),
      LOG_LEVEL: process.env.HONCHO_LOG_LEVEL || "INFO",
      ...(process.env.HONCHO_HTTP_PROXY
        ? {
            HTTP_PROXY: process.env.HONCHO_HTTP_PROXY,
            HTTPS_PROXY: process.env.HONCHO_HTTP_PROXY,
            http_proxy: process.env.HONCHO_HTTP_PROXY,
            https_proxy: process.env.HONCHO_HTTP_PROXY,
            NO_PROXY: "localhost,127.0.0.1,postgres,redis",
            no_proxy: "localhost,127.0.0.1,postgres,redis",
          }
        : {}),
    };
  }

  async function ensureImage() {
    try {
      const info = await docker.getImage(image).inspect();
      imageDigest = info.Id;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      throw new Error("Honcho image is missing. Run `pnpm honcho:build`.");
    }
  }

  async function network() {
    const runtime = process.env.HONCHO_NETWORK;
    if (!runtime) return undefined;
    try {
      const found = await docker.getNetwork(runtime).inspect();
      return found.Name;
    } catch {
      return undefined;
    }
  }

  async function running(container: Docker.Container): Promise<boolean> {
    try {
      return Boolean((await container.inspect()).State.Running);
    } catch {
      return false;
    }
  }

  async function stop(name: string) {
    const container = docker.getContainer(name);
    if (await running(container)) await container.stop({ t: 30 });
  }

  async function replace(name: string, input: HonchoConfiguration, command: string[]) {
    const previous = `${name}-previous`;
    const existing = docker.getContainer(name);
    await stop(previous).catch(() => undefined);
    await docker
      .getContainer(previous)
      .remove({ force: false })
      .catch(() => undefined);
    try {
      const info = await existing.inspect();
      if (info.State.Running) await existing.stop({ t: 30 });
      await existing.rename({ name: previous });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
    const networkName = await network();
    const env = environment(input);
    const container = await docker.createContainer({
      name,
      Image: image,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      ...(command.length ? { Cmd: command } : {}),
      Labels: { "rakazo.managed": "honcho", "rakazo.honcho.config": appliedFingerprint(input) },
      ExposedPorts: { "8000/tcp": {} },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        ...(networkName ? { NetworkMode: networkName } : {}),
        ...(name === `${managed.name}-api`
          ? { PortBindings: { "8000/tcp": [{ HostIp: host, HostPort: port }] } }
          : {}),
      },
    });
    await container.start();
    await stop(previous).catch(() => undefined);
    await docker
      .getContainer(previous)
      .remove({ force: false })
      .catch(() => undefined);
    return container;
  }

  /**
   * Whether Alembic and the schema step still need to run.
   *
   * A running API container proves the schema matches its embedding
   * dimensions: the startup validator refuses to boot otherwise, and Alembic
   * has already migrated this database. So when the previous API ran the exact
   * configuration being applied, both steps are no-ops and starting a
   * migration container only costs time.
   */
  async function schemaUpToDate(input: HonchoConfiguration) {
    try {
      const info = await docker.getContainer(`${managed.name}-api`).inspect();
      if (!info.State.Running) return false;
      if (info.Config.Labels["rakazo.honcho.config"] !== appliedFingerprint(input)) return false;
      // A different image may carry new migrations.
      return info.Image === imageDigest;
    } catch {
      return false;
    }
  }

  /**
   * Remove a deriver container left by a release that ran the deriver as a
   * second container. It has `unless-stopped` restart semantics and would
   * keep consuming the queue alongside the embedded loop, so every apply
   * sweeps it (and its blue-green leftover) away; missing names are fine.
   */
  async function removeLegacyDeriver() {
    for (const name of [`${managed.name}-deriver`, `${managed.name}-deriver-previous`]) {
      const legacy = docker.getContainer(name);
      try {
        if (await running(legacy)) await legacy.stop({ t: 30 });
        await legacy.remove({ force: false });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    }
  }

  async function apply(input: HonchoConfiguration) {
    if (pending) return pending;
    pending = (async () => {
      await ensureImage();
      if (!(await schemaUpToDate(input))) {
        // Alembic owns the schema in its own database. Only one process runs it.
        const migration = docker.getContainer(`${managed.name}-migrate`);
        try {
          const info = await migration.inspect();
          if (info.State.Running) await migration.wait();
          await migration.remove();
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        }
        const networkName = await network();
        const migrate = await docker.createContainer({
          name: `${managed.name}-migrate`,
          Image: image,
          // Alembic creates the default vector(1536) schema; configure_embeddings
          // then ALTERs the columns to EMBEDDING_VECTOR_DIMENSIONS so the
          // startup validators don't crash-loop on a non-default dimension.
          Cmd: ["sh", "-c", "alembic upgrade head && python scripts/configure_embeddings.py --yes"],
          Env: Object.entries(environment(input)).map(([key, value]) => `${key}=${value}`),
          Labels: {
            "rakazo.managed": "honcho",
            "rakazo.honcho.config": appliedFingerprint(input),
          },
          HostConfig: { AutoRemove: false, ...(networkName ? { NetworkMode: networkName } : {}) },
        });
        await migrate.start();
        const result = await migrate.wait();
        await migrate.remove();
        if (result.StatusCode !== 0)
          throw new Error(`Honcho migration failed (${result.StatusCode})`);
      }
      // One container plays both roles: the API serves traffic and its
      // lifespan runs the deriver queue loop (DERIVER_EMBEDDED). Any deriver
      // container from an earlier release is stopped first so it cannot
      // consume from the queue alongside the embedded loop.
      await removeLegacyDeriver();
      await replace(`${managed.name}-api`, input, []);
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await fetch(`${apiUrl}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (response.ok) break;
        } catch {
          // Health is retried below after startup.
        }
        if (attempt === 59) throw new Error("Honcho API did not become healthy");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function status(input?: HonchoConfiguration) {
    // The deriver is embedded in the API process (DERIVER_EMBEDDED), so the
    // API container is the only managed component.
    const components = await Promise.all(
      ["api"].map(async (component) => {
        try {
          const info = await docker.getContainer(`${managed.name}-${component}`).inspect();
          return {
            name: component,
            running: Boolean(info.State.Running),
            configured: input
              ? info.Config.Labels["rakazo.honcho.config"] === appliedFingerprint(input)
              : false,
          };
        } catch {
          return { name: component, running: false };
        }
      }),
    );
    let cache = false;
    try {
      cache = await honchoRedisReachable(
        input?.cacheUrl || process.env.HONCHO_CACHE_URL || "redis://127.0.0.1:6379/1?suppress=true",
        process.env.HONCHO_CACHE_HOST,
      );
    } catch (error) {
      getLogger().warn("Honcho Redis health check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      apiUrl,
      configurationHash: input?.configurationHash,
      configured: Boolean(input),
      applied: Boolean(input && components.every((component) => component.configured)),
      components,
      database: components.some((component) => component.running),
      cache,
    };
  }

  return {
    apply,
    status,
    restart: (input: HonchoConfiguration) => {
      return apply(input);
    },
  };
}

export type HonchoService = ReturnType<typeof createHonchoService>;

export function generateHonchoAdminToken(): string {
  return randomBytes(32).toString("hex");
}

export async function honchoError(error: unknown): Promise<string> {
  getLogger().error("Honcho lifecycle operation failed", error);
  return error instanceof Error ? error.message.slice(0, 500) : "Honcho operation failed";
}
