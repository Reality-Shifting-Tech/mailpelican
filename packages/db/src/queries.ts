import { generateToken, hashToken } from "@dispatch/domain";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  campaigns,
  campaignRecipients,
  campaignVersions,
  confirmationTokens,
  contacts,
  listMemberships,
  messages,
  relays,
  senderIdentities,
  workspaces,
} from "./schema.js";

const UNSUBSCRIBE_TOKEN_TTL_MS = 2 * 365 * 24 * 60 * 60_000;

/**
 * Issue an unsubscribe token for a contact/list pair. A fresh hashed token is
 * minted per message so every delivered email's link stays valid until its
 * own expiry; unsubscribing is idempotent so tokens are not single-use
 * (see ADR-0004).
 */
export async function ensureUnsubscribeToken(
  db: Database,
  workspaceId: string,
  contactId: string,
  listId: string,
): Promise<string> {
  const token = generateToken();
  await db.insert(confirmationTokens).values({
    workspaceId,
    contactId,
    listId,
    action: "unsubscribe",
    tokenHash: token.hash,
    expiresAt: new Date(Date.now() + UNSUBSCRIBE_TOKEN_TTL_MS),
  });
  return token.raw;
}

/** Look up a presented unsubscribe token; null when unknown or expired. */
export async function resolveUnsubscribeToken(db: Database, rawToken: string) {
  const rows = await db
    .select()
    .from(confirmationTokens)
    .where(
      and(
        eq(confirmationTokens.tokenHash, hashToken(rawToken)),
        eq(confirmationTokens.action, "unsubscribe"),
      ),
    )
    .limit(1);
  const token = rows[0];
  if (token === undefined || token.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return token;
}

/** Scheduled campaigns whose fire time has arrived. */
export async function findDueScheduledCampaigns(db: Database, now: Date = new Date()) {
  return db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, "scheduled"), sql`${campaigns.scheduledAt} <= ${now}`))
    .orderBy(asc(campaigns.scheduledAt))
    .limit(20);
}

/**
 * Everything the send pipeline needs for one campaign, joined once. Throws
 * nothing; callers validate presence of version, relay, and identity.
 */
export async function loadCampaignBundle(db: Database, campaignId: string) {
  const campaignRows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  const campaign = campaignRows[0];
  if (campaign === undefined) {
    return null;
  }
  const version =
    campaign.currentVersionId !== null
      ? (
          await db
            .select()
            .from(campaignVersions)
            .where(eq(campaignVersions.id, campaign.currentVersionId))
            .limit(1)
        )[0]
      : undefined;
  const relay =
    campaign.relayId !== null
      ? (await db.select().from(relays).where(eq(relays.id, campaign.relayId)).limit(1))[0]
      : undefined;
  const identity =
    campaign.senderIdentityId !== null
      ? (
          await db
            .select()
            .from(senderIdentities)
            .where(eq(senderIdentities.id, campaign.senderIdentityId))
            .limit(1)
        )[0]
      : undefined;
  const workspace = (
    await db.select().from(workspaces).where(eq(workspaces.id, campaign.workspaceId)).limit(1)
  )[0];
  return { campaign, version, relay, identity, workspace };
}

/** One batch of included recipients, keyset-paginated by id. */
export async function listIncludedRecipients(
  db: Database,
  campaignId: string,
  afterId: string | null,
  limit: number,
) {
  return db
    .select()
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.status, "included"),
        ...(afterId !== null ? [gt(campaignRecipients.id, afterId)] : []),
      ),
    )
    .orderBy(asc(campaignRecipients.id))
    .limit(limit);
}

/** Find a message by the id the provider assigned at acceptance. */
export async function findMessageByProviderId(
  db: Database,
  relayId: string,
  providerMessageId: string,
) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.relayId, relayId), eq(messages.providerMessageId, providerMessageId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Aggregate message outcomes for threshold evaluation. */
export async function campaignRateSample(db: Database, campaignId: string) {
  const rows = await db
    .select({ status: messages.status, count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.campaignId, campaignId))
    .groupBy(messages.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const sent =
    (byStatus.accepted ?? 0) +
    (byStatus.delivered ?? 0) +
    (byStatus.bounced ?? 0) +
    (byStatus.complained ?? 0);
  return {
    sent,
    bounces: byStatus.bounced ?? 0,
    complaints: byStatus.complained ?? 0,
  };
}

/** Current membership + contact data for the pre-dispatch recheck. */
export async function loadMembershipForRecheck(db: Database, contactId: string, listId: string) {
  const rows = await db
    .select({
      state: listMemberships.state,
      customFields: contacts.customFields,
      emailNormalized: contacts.emailNormalized,
    })
    .from(listMemberships)
    .innerJoin(contacts, eq(listMemberships.contactId, contacts.id))
    .where(and(eq(listMemberships.contactId, contactId), eq(listMemberships.listId, listId)))
    .limit(1);
  return rows[0] ?? null;
}
