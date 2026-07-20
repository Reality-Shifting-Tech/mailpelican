import { loadEnv } from "@dispatch/config";
import { closeDb, createDb, relays } from "@dispatch/db";
import { decryptSecret } from "@dispatch/domain";
import {
  campaignSendJobSchema,
  createOutboxDispatcher,
  createRedisRateLimiter,
  queueForTopic,
  webhookNormalizeJobSchema,
} from "@dispatch/queue";
import { createRelayProvider } from "@dispatch/relays";
import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import {
  dispatchMessage,
  normalizeInboxWebhook,
  runCampaignSend,
  runSchedulerTick,
  type PipelineDeps,
} from "./pipeline.js";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const deps: PipelineDeps = {
  db,
  env,
  limiter: createRedisRateLimiter(connection),
  createProvider: async (relayId) => {
    const rows = await db.select().from(relays).where(eq(relays.id, relayId)).limit(1);
    const relay = rows[0];
    if (relay === undefined) {
      throw new Error(`Relay ${relayId} not found`);
    }
    const credentials = decryptSecret(relay.credentialsEncrypted, env.CREDENTIAL_ENCRYPTION_KEY);
    return createRelayProvider(relay.type, credentials, relay.config);
  },
};

const sendQueue = new Queue("send", { connection });
const webhookQueue = new Queue("webhooks", { connection });

const dispatcher = createOutboxDispatcher({
  db,
  pollMs: 1000,
  enqueue: async (topic, payload, jobId) => {
    const queue = queueForTopic(topic) === "send" ? sendQueue : webhookQueue;
    await queue.add(topic, payload, { jobId });
  },
  onError: (error) => console.error("outbox dispatch error", error),
});

const sendWorker = new Worker(
  "send",
  async (job) => {
    if (job.name === "campaign.send") {
      const payload = campaignSendJobSchema.parse(job.data);
      await runCampaignSend(deps, payload);
      return;
    }
    if (job.name === "message.dispatch") {
      const payload = job.data as { messageId: string };
      await dispatchMessage(deps, payload.messageId);
    }
  },
  { connection, concurrency: 4 },
);

const webhookWorker = new Worker(
  "webhooks",
  async (job) => {
    if (job.name === "webhook.normalize") {
      const payload = webhookNormalizeJobSchema.parse(job.data);
      await normalizeInboxWebhook(deps, payload.inboxId);
    }
  },
  { connection, concurrency: 2 },
);

const scheduler = setInterval(() => {
  runSchedulerTick(db).catch((error) => console.error("scheduler tick failed", error));
}, 30_000);
scheduler.unref();

dispatcher.start();
console.log("worker started: send, webhooks, scheduler, outbox dispatcher");

async function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`);
  clearInterval(scheduler);
  await dispatcher.stop();
  await sendWorker.close();
  await webhookWorker.close();
  await sendQueue.close();
  await webhookQueue.close();
  await closeDb(db);
  connection.disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
