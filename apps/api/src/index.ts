import { serve } from "@hono/node-server";
import { loadEnv } from "@mailpelican/config";
import { closeDb, createDb, relays } from "@mailpelican/db";
import { decryptSecret } from "@mailpelican/domain";
import { createRelayProvider } from "@mailpelican/relays";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { resolve4, resolveCname, resolveMx, resolvePtr, resolveTxt } from "node:dns/promises";
import { createApp } from "./app.js";
import type { Deps } from "./deps.js";

const env = loadEnv();

const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

const deps: Deps = {
  env,
  db,
  checkDatabase: async () => {
    await db.execute(sql`SELECT 1`);
  },
  checkRedis: async () => {
    await redis.ping();
  },
  close: async () => {
    await closeDb(db);
    redis.disconnect();
  },
  createProvider: async (relayId) => {
    const rows = await db.select().from(relays).where(eq(relays.id, relayId)).limit(1);
    const relay = rows[0];
    if (relay === undefined) {
      throw new Error(`Relay ${relayId} not found`);
    }
    const credentials = decryptSecret(relay.credentialsEncrypted, env.CREDENTIAL_ENCRYPTION_KEY);
    return createRelayProvider(relay.type, credentials, relay.config);
  },
  resolveDns: async (name, recordType) => {
    switch (recordType) {
      case "CNAME":
        return resolveCname(name);
      case "A":
        return resolve4(name);
      case "MX":
        return (await resolveMx(name)).map((record) => record.exchange);
      case "PTR":
        return resolvePtr(name);
      default: {
        const chunks = await resolveTxt(name);
        return chunks.map((parts) => parts.join(""));
      }
    }
  },
};

const app = createApp(deps);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

async function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`);
  server.close();
  await deps.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
