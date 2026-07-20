import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import type { RecipientStatusValue, OutboxRow, SendConfirmation } from "./schema.js";
import {
  campaignRecipients,
  campaigns,
  events,
  inboundWebhookEvents,
  messages,
  outbox,
  sendConfirmations,
  suppressions,
} from "./schema.js";
import { uuidv7 } from "./uuidv7.js";

/**
 * Compare-and-set campaign transition. Returns the updated row, or null when
 * the campaign is no longer in `from` (another actor moved it first → 409).
 */
export async function casCampaignStatus(
  db: Database,
  campaignId: string,
  from: readonly string[],
  to: string,
  extra: Partial<{
    scheduledAt: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    currentVersionId: string | null;
  }> = {},
) {
  const rows = await db
    .update(campaigns)
    .set({ status: to as never, updatedAt: new Date(), ...extra })
    .where(and(eq(campaigns.id, campaignId), inArray(campaigns.status, from as never[])))
    .returning();
  return rows[0] ?? null;
}

/** Batch-insert messages, ignoring rows whose id already exists. */
export async function insertMessagesBatch(
  db: Database,
  rows: (typeof messages.$inferInsert)[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const inserted = await db.insert(messages).values(rows).onConflictDoNothing().returning({
    id: messages.id,
  });
  return inserted.length;
}

/**
 * Atomically claim a queued message for dispatch (queued → sending). The
 * compare-and-set makes duplicate job delivery harmless: the second worker
 * finds no row and skips (architecture §13 failure injection).
 */
export async function claimMessage(db: Database, messageId: string) {
  const rows = await db
    .update(messages)
    .set({ status: "sending", attempts: sql`${messages.attempts} + 1` })
    .where(and(eq(messages.id, messageId), eq(messages.status, "queued")))
    .returning();
  return rows[0] ?? null;
}

/** Release a claimed message back to queued after a retryable failure. */
export async function releaseMessage(db: Database, messageId: string, lastError: string) {
  await db
    .update(messages)
    .set({ status: "queued", lastError })
    .where(and(eq(messages.id, messageId), eq(messages.status, "sending")));
}

export interface MessageOutcome {
  providerMessageId?: string;
  lastError?: string;
}

/** Record a terminal or intermediate provider outcome on a message. */
export async function settleMessage(
  db: Database,
  messageId: string,
  status: RecipientStatusValue,
  outcome: MessageOutcome = {},
) {
  const now = new Date();
  const terminal =
    status === "delivered" ||
    status === "failed" ||
    status === "bounced" ||
    status === "complained" ||
    status === "suppressed" ||
    status === "unsubscribed" ||
    status === "cancelled";
  await db
    .update(messages)
    .set({
      status,
      ...(outcome.providerMessageId !== undefined
        ? { providerMessageId: outcome.providerMessageId }
        : {}),
      ...(outcome.lastError !== undefined ? { lastError: outcome.lastError } : {}),
      ...(status === "accepted" ? { acceptedAt: now } : {}),
      ...(status === "delivered" ? { deliveredAt: now } : {}),
      ...(terminal ? { terminalAt: now } : {}),
    })
    .where(eq(messages.id, messageId));
}

/** Mirror a message outcome onto its campaign recipient row. */
export async function settleRecipient(
  db: Database,
  recipientId: string,
  status: RecipientStatusValue,
  exclusionReason?: string,
) {
  await db
    .update(campaignRecipients)
    .set({ status, ...(exclusionReason !== undefined ? { exclusionReason } : {}) })
    .where(eq(campaignRecipients.id, recipientId));
}

/**
 * Insert a normalized provider event with deduplication. The
 * (relay_id, provider_event_id) partial unique index dedups providers that
 * send event IDs; (relay_id, payload_hash) is the fallback (§4). Returns the
 * inserted row, or null when the event was already stored.
 */
export async function insertEventDedup(db: Database, row: typeof events.$inferInsert) {
  const inserted = await db.insert(events).values(row).onConflictDoNothing().returning();
  return inserted[0] ?? null;
}

/**
 * Store a verified raw webhook payload idempotently. Returns "inserted" for
 * new payloads and "duplicate" for replays (§6 provider webhook step 2).
 */
export async function insertInboundWebhookDedup(
  db: Database,
  row: typeof inboundWebhookEvents.$inferInsert,
): Promise<{ outcome: "inserted" | "duplicate"; id: string | null }> {
  const inserted = await db
    .insert(inboundWebhookEvents)
    .values({ ...row, id: row.id ?? uuidv7() })
    .onConflictDoNothing()
    .returning({ id: inboundWebhookEvents.id });
  if (inserted[0]) {
    return { outcome: "inserted", id: inserted[0].id };
  }
  return { outcome: "duplicate", id: null };
}

/** Append an outbox row; call inside the transaction it belongs to. */
export async function appendOutbox(
  db: Database,
  row: Pick<typeof outbox.$inferInsert, "workspaceId" | "topic" | "payload">,
) {
  const inserted = await db.insert(outbox).values(row).returning();
  const created = inserted[0];
  if (!created) {
    throw new Error("outbox insert returned no row");
  }
  return created;
}

/** Fetch due outbox rows for the dispatcher, oldest first. */
export async function fetchDueOutbox(db: Database, limit: number, now: Date = new Date()) {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.status, "pending"), lte(outbox.availableAt, now)))
    .orderBy(asc(outbox.createdAt))
    .limit(limit);
}

/** Mark an outbox row dispatched after its job was accepted by the queue. */
export async function markOutboxDispatched(db: Database, id: string) {
  await db
    .update(outbox)
    .set({ status: "dispatched", dispatchedAt: new Date() })
    .where(and(eq(outbox.id, id), eq(outbox.status, "pending")));
}

/** Reschedule a failed dispatch attempt, or dead-letter after `maxAttempts`. */
export async function markOutboxAttemptFailed(
  db: Database,
  row: OutboxRow,
  error: string,
  maxAttempts = 10,
): Promise<void> {
  const attempts = row.attempts + 1;
  if (attempts >= maxAttempts) {
    await db
      .update(outbox)
      .set({ status: "dead", attempts, lastError: error })
      .where(eq(outbox.id, row.id));
    return;
  }
  const delayMs = Math.min(1000 * 2 ** attempts, 5 * 60_000);
  await db
    .update(outbox)
    .set({ attempts, lastError: error, availableAt: new Date(Date.now() + delayMs) })
    .where(eq(outbox.id, row.id));
}

/**
 * Consume a single-use send confirmation token. Returns the row when the
 * hash matched an unused, unexpired confirmation and this call marked it
 * used; null otherwise. The atomic claim makes replay impossible.
 */
export async function consumeSendConfirmation(
  db: Database,
  tokenHash: string,
  now: Date = new Date(),
): Promise<SendConfirmation | null> {
  const rows = await db
    .update(sendConfirmations)
    .set({ usedAt: now })
    .where(
      and(
        eq(sendConfirmations.tokenHash, tokenHash),
        isNull(sendConfirmations.usedAt),
        gt(sendConfirmations.expiresAt, now),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Add a workspace-global suppression. Existing active suppressions are left
 * untouched; a lifted suppression is re-activated by the new reason.
 */
export async function addSuppression(
  db: Database,
  row: Pick<
    typeof suppressions.$inferInsert,
    "workspaceId" | "emailNormalized" | "reason" | "source"
  >,
) {
  const inserted = await db
    .insert(suppressions)
    .values(row)
    .onConflictDoUpdate({
      target: [suppressions.workspaceId, suppressions.emailNormalized],
      set: { reason: row.reason, source: row.source, liftedAt: null },
      targetWhere: sql`${suppressions.liftedAt} is not null`,
    })
    .returning();
  return inserted[0] ?? null;
}

/** True when the email has an active (not lifted) suppression. */
export async function isSuppressed(
  db: Database,
  workspaceId: string,
  emailNormalized: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.workspaceId, workspaceId),
        eq(suppressions.emailNormalized, emailNormalized),
        isNull(suppressions.liftedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Load a message together with everything the dispatch pipeline needs. */
export async function loadMessageForDispatch(db: Database, messageId: string) {
  const rows = await db
    .select({
      message: messages,
      recipient: campaignRecipients,
      campaign: campaigns,
    })
    .from(messages)
    .innerJoin(campaignRecipients, eq(messages.campaignRecipientId, campaignRecipients.id))
    .innerJoin(campaigns, eq(messages.campaignId, campaigns.id))
    .where(eq(messages.id, messageId))
    .limit(1);
  return rows[0] ?? null;
}

/** Outbox topics emitted by the API and consumed by the worker. */
export const OUTBOX_TOPICS = {
  campaignSend: "campaign.send",
  webhookNormalize: "webhook.normalize",
  subscriptionConfirm: "subscription.confirm",
} as const;

/** Mark a webhook inbox row processed or failed after normalization. */
export async function settleInboundWebhook(
  db: Database,
  id: string,
  status: "processed" | "failed" | "dead",
  lastError?: string,
) {
  await db
    .update(inboundWebhookEvents)
    .set({
      status,
      attempts: sql`${inboundWebhookEvents.attempts} + 1`,
      ...(lastError !== undefined ? { lastError } : {}),
      ...(status === "processed" ? { processedAt: new Date() } : {}),
    })
    .where(eq(inboundWebhookEvents.id, id));
}

/** Admin replay: clone a stored raw payload as a fresh inbox row (§6). */
export async function replayInboundWebhook(db: Database, id: string) {
  const rows = await db
    .select()
    .from(inboundWebhookEvents)
    .where(eq(inboundWebhookEvents.id, id))
    .limit(1);
  const original = rows[0];
  if (!original) {
    return null;
  }
  const clone = await db
    .insert(inboundWebhookEvents)
    .values({
      workspaceId: original.workspaceId,
      relayId: original.relayId,
      headers: original.headers,
      payload: original.payload,
      payloadHash: uuidv7(),
      replayOf: original.replayOf ?? original.id,
    })
    .returning();
  return clone[0] ?? null;
}
