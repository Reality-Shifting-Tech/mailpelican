import {
  addSuppression,
  appendOutbox,
  campaignRateSample,
  casCampaignStatus,
  claimMessage,
  ensureUnsubscribeToken,
  findDueScheduledCampaigns,
  findMessageByProviderId,
  insertEventDedup,
  insertMessagesBatch,
  isSuppressed,
  listIncludedRecipients,
  loadCampaignBundle,
  loadMembershipForRecheck,
  loadMessageForDispatch,
  OUTBOX_TOPICS,
  releaseMessage,
  settleInboundWebhook,
  settleMessage,
  settleRecipient,
  inboundWebhookEvents,
  relays,
} from "@dispatch/db";
import type { Database } from "@dispatch/db";
import {
  backoffDelayMs,
  buildComplianceFooter,
  buildListUnsubscribeHeaders,
  canRetry,
  classifySendError,
  decideSendability,
  DomainError,
  evaluateRates,
  renderMergeTags,
} from "@dispatch/domain";
import type { Env } from "@dispatch/config";
import type { RateLimiter } from "@dispatch/queue";
import type { RelayProvider } from "@dispatch/relays";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

export interface PipelineDeps {
  db: Database;
  env: Env;
  createProvider: (relayId: string) => Promise<RelayProvider>;
  limiter: RateLimiter;
  batchSize?: number;
}

/** Thrown for retryable provider failures so the queue retries with backoff. */
export class RetryableSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableSendError";
  }
}

/** Thrown when the relay limiter denies a token; retry after the hint. */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`rate limited, retry after ${retryAfterMs}ms`);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Fire scheduled campaigns whose time has come: transition to preparing and
 * commit an outbox row for the sender (architecture §6 step 5 mirrored for
 * the scheduler path).
 */
export async function runSchedulerTick(db: Database): Promise<number> {
  const due = await findDueScheduledCampaigns(db);
  for (const campaign of due) {
    await db.transaction(async (tx) => {
      const moved = await casCampaignStatus(tx, campaign.id, ["scheduled"], "preparing", {
        startedAt: new Date(),
      });
      if (moved !== null) {
        await appendOutbox(tx, {
          workspaceId: campaign.workspaceId,
          topic: OUTBOX_TOPICS.campaignSend,
          payload: { workspaceId: campaign.workspaceId, campaignId: campaign.id },
        });
      }
    });
  }
  return due.length;
}

/**
 * Create one message per included recipient (id = recipient id, the send
 * idempotency key) and dispatch them. Safe to re-run: message insert is
 * conflict-free and per-message claim is compare-and-set.
 */
export async function runCampaignSend(
  deps: PipelineDeps,
  job: { workspaceId: string; campaignId: string },
): Promise<{ created: number; dispatched: number }> {
  const moved = await casCampaignStatus(deps.db, job.campaignId, ["preparing"], "sending");
  if (moved === null) {
    const current = await loadCampaignBundle(deps.db, job.campaignId);
    const status = current?.campaign.status;
    // Duplicate job delivery after completion or operator control is a no-op.
    if (status === "paused" || status === "cancelled" || status === "completed") {
      return { created: 0, dispatched: 0 };
    }
    if (status !== "sending") {
      throw new DomainError(
        "invalid_transition",
        `Campaign cannot start sending from status "${status ?? "missing"}".`,
        409,
      );
    }
    // Already sending: a re-run after a crash mid-campaign continues below.
  }

  const bundle = await loadCampaignBundle(deps.db, job.campaignId);
  if (bundle?.relay === undefined) {
    throw new DomainError("no_relay", "Campaign has no relay.", 422);
  }
  const relayId = bundle.relay.id;

  const batchSize = deps.batchSize ?? 500;
  let afterId: string | null = null;
  let created = 0;
  let dispatched = 0;
  for (;;) {
    const recipients = await listIncludedRecipients(deps.db, job.campaignId, afterId, batchSize);
    if (recipients.length === 0) {
      break;
    }
    afterId = recipients[recipients.length - 1]?.id ?? afterId;
    created += await insertMessagesBatch(
      deps.db,
      recipients.map((recipient) => ({
        id: recipient.id,
        workspaceId: job.workspaceId,
        campaignId: job.campaignId,
        campaignRecipientId: recipient.id,
        contactId: recipient.contactId,
        relayId,
        status: "queued" as const,
      })),
    );
    for (const recipient of recipients) {
      await settleRecipient(deps.db, recipient.id, "queued");
      await dispatchMessage(deps, recipient.id);
      dispatched += 1;
    }
  }

  // Crash recovery: messages left queued by an interrupted previous run.
  const leftovers = await deps.db.query.messages.findMany({
    where: (t, { and: a, eq: e }) => a(e(t.campaignId, job.campaignId), e(t.status, "queued")),
    limit: 10_000,
  });
  for (const leftover of leftovers) {
    await dispatchMessage(deps, leftover.id);
    dispatched += 1;
  }

  const finalBundle = await loadCampaignBundle(deps.db, job.campaignId);
  if (finalBundle?.campaign.status === "sending") {
    await casCampaignStatus(deps.db, job.campaignId, ["sending"], "completed", {
      completedAt: new Date(),
    });
  }
  return { created, dispatched };
}

/**
 * Dispatch one message through its relay with the full safety recheck:
 * claim → current membership/suppression → render → limit → send → record.
 * A duplicate job delivery finds the message already claimed and returns.
 */
export async function dispatchMessage(deps: PipelineDeps, messageId: string): Promise<void> {
  const claimed = await claimMessage(deps.db, messageId);
  if (claimed === null) {
    return;
  }
  const loaded = await loadMessageForDispatch(deps.db, messageId);
  if (loaded === null) {
    return;
  }
  const { recipient, campaign } = loaded;

  if (campaign.status === "paused" || campaign.status === "cancelled") {
    await releaseMessage(deps.db, messageId, `campaign ${campaign.status}`);
    return;
  }

  const bundle = await loadCampaignBundle(deps.db, campaign.id);
  if (
    bundle?.version === undefined ||
    bundle.relay === undefined ||
    bundle.identity === undefined ||
    bundle.workspace === undefined
  ) {
    await settleMessage(deps.db, messageId, "failed", { lastError: "campaign bundle incomplete" });
    await settleRecipient(deps.db, recipient.id, "failed", "campaign_incomplete");
    return;
  }

  // Architecture §6 step 7: recheck live consent, never trust the snapshot.
  const membership = await loadMembershipForRecheck(
    deps.db,
    recipient.contactId,
    bundle.version.audienceRef,
  );
  const suppressed = await isSuppressed(deps.db, campaign.workspaceId, recipient.email);
  const decision = decideSendability({
    membershipState: membership?.state ?? null,
    suppressed,
  });
  if (!decision.ok) {
    const status =
      decision.reason === "suppressed"
        ? "suppressed"
        : decision.reason === "unsubscribed"
          ? "unsubscribed"
          : "excluded";
    await settleMessage(deps.db, messageId, status);
    await settleRecipient(deps.db, recipient.id, status, decision.reason);
    return;
  }

  const unsubscribeToken = await ensureUnsubscribeToken(
    deps.db,
    campaign.workspaceId,
    recipient.contactId,
    bundle.version.audienceRef,
  );
  const publicBase = deps.env.PUBLIC_URL.replace(/\/$/, "");
  const unsubscribeUrl = `${publicBase}/v1/public/unsubscribe/${unsubscribeToken}`;
  const oneClickUrl = `${publicBase}/v1/public/one-click-unsubscribe/${unsubscribeToken}`;

  const fields = {
    email: recipient.email,
    ...recipient.personalization,
    unsubscribe_url: unsubscribeUrl,
    sender_address: `${bundle.workspace.organizationName}, ${bundle.workspace.postalAddress}`,
  };
  const footer = buildComplianceFooter(bundle.workspace, unsubscribeUrl);
  const html = renderMergeTags(bundle.version.bodyHtml, fields, { escape: true }) + footer.html;
  const text = renderMergeTags(bundle.version.bodyText, fields, { escape: false }) + footer.text;
  const subject = renderMergeTags(bundle.version.subject, fields, { escape: false });

  if (bundle.relay.rateLimit !== null) {
    const permit = await deps.limiter.take(`relay:${bundle.relay.id}`, {
      ratePerSecond: bundle.relay.rateLimit,
      burst: Math.max(1, bundle.relay.rateLimit),
    });
    if (!permit.allowed) {
      await releaseMessage(deps.db, messageId, "rate limited");
      throw new RateLimitedError(permit.retryAfterMs);
    }
  }

  const provider = await deps.createProvider(bundle.relay.id);
  try {
    const result = await provider.send(
      {
        messageId,
        fromEmail: bundle.version.fromEmail,
        fromName: bundle.version.fromName,
        replyTo: bundle.version.replyTo,
        toEmail: recipient.email,
        subject,
        html,
        text,
        headers: buildListUnsubscribeHeaders(unsubscribeUrl, oneClickUrl),
      },
      {
        workspaceId: campaign.workspaceId,
        relayId: bundle.relay.id,
        campaignId: campaign.id,
      },
    );
    await settleMessage(deps.db, messageId, "accepted", {
      ...(result.providerMessageId !== null ? { providerMessageId: result.providerMessageId } : {}),
    });
    await settleRecipient(deps.db, recipient.id, "accepted");
  } catch (error) {
    const shape = error as { status?: number; code?: string; message?: string };
    const classification = classifySendError(shape);
    const lastError = shape.message ?? "provider error";
    if (classification === "terminal" || !canRetry(claimed.attempts)) {
      await settleMessage(deps.db, messageId, "failed", { lastError });
      await settleRecipient(deps.db, recipient.id, "failed", lastError);
      return;
    }
    await releaseMessage(deps.db, messageId, lastError);
    throw new RetryableSendError(lastError);
  }
}

/** Backoff hint for the queue when a dispatch throws RetryableSendError. */
export function retryDelayForAttempt(attempts: number): number {
  return backoffDelayMs(Math.max(1, attempts));
}

/**
 * Normalize one stored webhook payload: dedup, match the message, update
 * message and recipient, create suppressions, and enforce bounce/complaint
 * thresholds that auto-pause the campaign and relay (§6 webhook flow).
 */
export async function normalizeInboxWebhook(deps: PipelineDeps, inboxId: string): Promise<void> {
  const rows = await deps.db
    .select()
    .from(inboundWebhookEvents)
    .where(eq(inboundWebhookEvents.id, inboxId))
    .limit(1);
  const inbox = rows[0];
  if (inbox === undefined || inbox.status === "processed") {
    return;
  }
  try {
    const provider = await deps.createProvider(inbox.relayId);
    const verified = await provider.verifyWebhook({ headers: inbox.headers, body: inbox.payload });
    if (!verified.valid) {
      await settleInboundWebhook(deps.db, inboxId, "dead", verified.reason);
      return;
    }
    const normalized = await provider.normalizeWebhook(verified);
    for (const event of normalized) {
      await applyNormalizedEvent(deps, inbox.relayId, event);
    }
    await settleInboundWebhook(deps.db, inboxId, "processed");
  } catch (error) {
    await settleInboundWebhook(
      deps.db,
      inboxId,
      "failed",
      error instanceof Error ? error.message : "normalize failed",
    );
    throw error;
  }
}

async function applyNormalizedEvent(
  deps: PipelineDeps,
  relayId: string,
  event: {
    providerEventId: string | null;
    type: "accepted" | "delivered" | "bounced" | "complained" | "rejected" | "unknown";
    providerMessageId: string | null;
    occurredAt: Date;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify([relayId, event.providerEventId, event.type, event.providerMessageId]))
    .digest("hex");
  const message =
    event.providerMessageId !== null
      ? await findMessageByProviderId(deps.db, relayId, event.providerMessageId)
      : null;
  const stored = await insertEventDedup(deps.db, {
    workspaceId: message?.workspaceId ?? (await relayWorkspace(deps.db, relayId)),
    messageId: message?.id ?? null,
    relayId,
    providerEventId: event.providerEventId,
    payloadHash,
    type: event.type,
    meta: event.meta,
    occurredAt: event.occurredAt,
  });
  if (stored === null || message === null) {
    return;
  }

  if (event.type === "delivered") {
    await settleMessage(deps.db, message.id, "delivered");
    await settleRecipient(deps.db, message.campaignRecipientId, "delivered");
  }
  if (event.type === "bounced" || event.type === "rejected") {
    await settleMessage(deps.db, message.id, "bounced");
    await settleRecipient(deps.db, message.campaignRecipientId, "bounced");
    const loaded = await loadMessageForDispatch(deps.db, message.id);
    if (loaded !== null) {
      await addSuppression(deps.db, {
        workspaceId: message.workspaceId,
        emailNormalized: loaded.recipient.email,
        reason: "hard_bounce",
        source: "webhook",
      });
    }
  }
  if (event.type === "complained") {
    await settleMessage(deps.db, message.id, "complained");
    await settleRecipient(deps.db, message.campaignRecipientId, "complained");
    const loaded = await loadMessageForDispatch(deps.db, message.id);
    if (loaded !== null) {
      await addSuppression(deps.db, {
        workspaceId: message.workspaceId,
        emailNormalized: loaded.recipient.email,
        reason: "complaint",
        source: "webhook",
      });
    }
  }

  const sample = await campaignRateSample(deps.db, message.campaignId);
  const breach = evaluateRates(sample);
  if (breach !== null) {
    await casCampaignStatus(deps.db, message.campaignId, ["sending"], "paused");
    await deps.db
      .update(relays)
      .set({ status: "paused" })
      .where(and(eq(relays.id, relayId), eq(relays.status, "ready")));
  }
}

async function relayWorkspace(db: Database, relayId: string): Promise<string> {
  const rows = await db
    .select({ workspaceId: relays.workspaceId })
    .from(relays)
    .where(eq(relays.id, relayId))
    .limit(1);
  const workspaceId = rows[0]?.workspaceId;
  if (workspaceId === undefined) {
    throw new DomainError("not_found", "Relay not found.", 404);
  }
  return workspaceId;
}
