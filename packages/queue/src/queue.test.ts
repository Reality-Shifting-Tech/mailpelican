import { appendOutbox, uuidv7, workspaces } from "@dispatch/db";
import { createTestDb } from "@dispatch/db/testing";
import type { Database } from "@dispatch/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryRateLimiter } from "./rate-limiter.js";
import { drainOutboxOnce } from "./outbox-dispatcher.js";
import { queueForTopic } from "./jobs.js";

let db: Database;
let close: () => Promise<void>;
let workspaceId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  workspaceId = uuidv7();
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "Q",
    slug: `q-${workspaceId.slice(0, 8)}`,
    organizationName: "Q Inc",
    postalAddress: "1 Main St",
  });
});

afterAll(async () => {
  await close();
});

describe("drainOutboxOnce", () => {
  it("enqueues due rows and marks them dispatched", async () => {
    const row = await appendOutbox(db, {
      workspaceId,
      topic: "campaign.send",
      payload: { workspaceId, campaignId: uuidv7() },
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const drained = await drainOutboxOnce({ db, enqueue });
    expect(drained).toBeGreaterThanOrEqual(1);
    expect(enqueue).toHaveBeenCalledWith(
      "campaign.send",
      expect.objectContaining({ workspaceId }),
      row.id,
    );
    const again = await drainOutboxOnce({ db, enqueue: vi.fn() });
    expect(again).toBe(0);
  });

  it("recovers jobs after a crash between commit and enqueue", async () => {
    // Row committed but enqueue never ran (process crashed).
    const row = await appendOutbox(db, {
      workspaceId,
      topic: "webhook.normalize",
      payload: { workspaceId, inboxId: uuidv7(), relayId: uuidv7() },
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    await drainOutboxOnce({ db, enqueue });
    expect(enqueue).toHaveBeenCalledWith("webhook.normalize", expect.anything(), row.id);
  });

  it("backs off and dead-letters persistent enqueue failures", async () => {
    const row = await appendOutbox(db, {
      workspaceId,
      topic: "campaign.send",
      payload: { workspaceId, campaignId: uuidv7() },
    });
    const enqueue = vi.fn().mockRejectedValue(new Error("redis down"));
    const first = await drainOutboxOnce({ db, enqueue, maxAttempts: 2 });
    expect(first).toBe(1);
    // Not yet due after backoff: simulate retry after the row is due again by
    // marking attempts directly through a second drain with forced failure.
    const { outbox } = await import("@dispatch/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(outbox)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(outbox.id, row.id));
    await drainOutboxOnce({ db, enqueue, maxAttempts: 2 });
    const rows = await db.select().from(outbox).where(eq(outbox.id, row.id));
    expect(rows[0]?.status).toBe("dead");
  });
});

describe("queueForTopic", () => {
  it("routes topics to queues", () => {
    expect(queueForTopic("campaign.send")).toBe("send");
    expect(queueForTopic("webhook.normalize")).toBe("webhooks");
    expect(() => queueForTopic("nope")).toThrow();
  });
});

describe("createMemoryRateLimiter", () => {
  it("enforces the configured rate", async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter(() => now);
    const config = { ratePerSecond: 1, burst: 2 };
    expect((await limiter.take("r1", config)).allowed).toBe(true);
    expect((await limiter.take("r1", config)).allowed).toBe(true);
    const denied = await limiter.take("r1", config);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    now += 1000;
    expect((await limiter.take("r1", config)).allowed).toBe(true);
  });
});
