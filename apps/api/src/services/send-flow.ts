import {
  campaignRecipients,
  campaigns,
  campaignVersions,
  contacts,
  ensureUnsubscribeToken as ensureToken,
  listMemberships,
  resolveUnsubscribeToken as resolveToken,
  sendConfirmations,
  senderIdentities,
  suppressions,
  uuidv7,
  workspaces,
} from "@dispatch/db";
import type { Campaign, CampaignVersion, Database } from "@dispatch/db";
import {
  decideSendability,
  DomainError,
  generateToken,
  hasLintErrors,
  isCampaignEditable,
  lintCampaign,
  type LintIssue,
} from "@dispatch/domain";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

export const CONFIRMATION_TTL_MS = 15 * 60_000;

export interface PreparedAudience {
  included: number;
  excluded: number;
  audienceHash: string;
}

/** Load a campaign in a workspace or throw 404. */
export async function loadCampaign(
  db: Database,
  workspaceId: string,
  campaignId: string,
): Promise<Campaign> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.workspaceId, workspaceId)))
    .limit(1);
  const campaign = rows[0];
  if (campaign === undefined) {
    throw new DomainError("not_found", "Campaign not found.", 404);
  }
  return campaign;
}

/** Load the campaign's pinned current version or throw 422. */
export async function loadCurrentVersion(
  db: Database,
  campaign: Campaign,
): Promise<CampaignVersion> {
  if (campaign.currentVersionId === null) {
    throw new DomainError("no_version", "Campaign has no message version.", 422);
  }
  const rows = await db
    .select()
    .from(campaignVersions)
    .where(eq(campaignVersions.id, campaign.currentVersionId))
    .limit(1);
  const version = rows[0];
  if (version === undefined) {
    throw new DomainError("no_version", "Campaign version not found.", 422);
  }
  return version;
}

/** Lint a campaign version against workspace compliance identity. */
export async function lintCampaignVersion(
  db: Database,
  workspaceId: string,
  version: CampaignVersion,
): Promise<LintIssue[]> {
  const ws = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const workspace = ws[0];
  if (workspace === undefined) {
    throw new DomainError("not_found", "Workspace not found.", 404);
  }
  return lintCampaign({
    subject: version.subject,
    previewText: version.previewText,
    bodyHtml: version.bodyHtml,
    bodyText: version.bodyText,
    fromEmail: version.fromEmail,
    fromName: version.fromName,
    organizationName: workspace.organizationName,
    postalAddress: workspace.postalAddress,
    knownMergeFields: ["email", "first_name", "last_name"],
  });
}

/**
 * Resolve the audience of a campaign version and write the immutable
 * recipient snapshot (architecture §6 step 3). Exclusions — invalid email,
 * pending, unsubscribed, suppressed — are recorded with their reason.
 * Re-running prepare replaces a snapshot that has not started sending.
 */
export async function prepareCampaign(
  db: Database,
  principal: { workspaceId: string; actorType: "api_key" | "owner"; actorId: string },
  campaign: Campaign,
  version: CampaignVersion,
): Promise<PreparedAudience & { confirmationToken: string; expiresAt: Date }> {
  const issues = await lintCampaignVersion(db, principal.workspaceId, version);
  if (hasLintErrors(issues)) {
    throw new DomainError(
      "lint_failed",
      `Campaign has lint errors: ${issues
        .filter((i) => i.severity === "error")
        .map((i) => i.code)
        .join(", ")}.`,
      422,
    );
  }

  const members = await db
    .select({
      contactId: listMemberships.contactId,
      state: listMemberships.state,
      emailNormalized: contacts.emailNormalized,
      customFields: contacts.customFields,
    })
    .from(listMemberships)
    .innerJoin(contacts, eq(listMemberships.contactId, contacts.id))
    .where(
      and(
        eq(listMemberships.workspaceId, principal.workspaceId),
        eq(listMemberships.listId, version.audienceRef),
      ),
    );

  const activeSuppressions = await db
    .select({ emailNormalized: suppressions.emailNormalized })
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, principal.workspaceId), isNull(suppressions.liftedAt)));
  const suppressedEmails = new Set(activeSuppressions.map((s) => s.emailNormalized));

  await db
    .delete(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaign.id),
        eq(campaignRecipients.status, "included"),
      ),
    );

  let included = 0;
  let excluded = 0;
  const hashInput: string[] = [];
  const snapshot = members.map((member) => {
    const decision = decideSendability({
      membershipState: member.state,
      suppressed: suppressedEmails.has(member.emailNormalized),
    });
    if (decision.ok) {
      included += 1;
      hashInput.push(member.contactId);
      return {
        id: uuidv7(),
        campaignId: campaign.id,
        campaignVersionId: version.id,
        contactId: member.contactId,
        email: member.emailNormalized,
        personalization: member.customFields,
        status: "included" as const,
        exclusionReason: null,
      };
    }
    excluded += 1;
    return {
      id: uuidv7(),
      campaignId: campaign.id,
      campaignVersionId: version.id,
      contactId: member.contactId,
      email: member.emailNormalized,
      personalization: member.customFields,
      status: "excluded" as const,
      exclusionReason: decision.reason,
    };
  });
  if (snapshot.length > 0) {
    await db.insert(campaignRecipients).values(snapshot).onConflictDoNothing();
  }
  const audienceHash = createHash("sha256").update(hashInput.sort().join(",")).digest("hex");

  const token = generateToken();
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  await db.insert(sendConfirmations).values({
    workspaceId: principal.workspaceId,
    campaignId: campaign.id,
    campaignVersionId: version.id,
    tokenHash: token.hash,
    actorType: principal.actorType,
    actorId: principal.actorId,
    audienceHash,
    recipientCount: included,
    expiresAt,
  });

  return { included, excluded, audienceHash, confirmationToken: token.raw, expiresAt };
}

/**
 * Return (creating on first use) the long-lived unsubscribe token for a
 * contact/list pair. Delegates to the shared query in @dispatch/db.
 */
export async function ensureUnsubscribeToken(
  db: Database,
  workspaceId: string,
  contactId: string,
  listId: string,
): Promise<string> {
  return ensureToken(db, workspaceId, contactId, listId);
}

/** Look up a presented unsubscribe token; throws 404 on unknown/expired. */
export async function resolveUnsubscribeToken(db: Database, rawToken: string) {
  const token = await resolveToken(db, rawToken);
  if (token === null) {
    throw new DomainError("not_found", "Unsubscribe link is invalid or expired.", 404);
  }
  return token;
}

/** Load the sender identity required for a send, enforcing verification. */
export async function loadVerifiedIdentity(db: Database, senderIdentityId: string | null) {
  if (senderIdentityId === null) {
    throw new DomainError("no_sender", "Campaign has no sender identity.", 422);
  }
  const rows = await db
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.id, senderIdentityId))
    .limit(1);
  const identity = rows[0];
  if (identity === undefined) {
    throw new DomainError("no_sender", "Sender identity not found.", 422);
  }
  if (identity.verificationStatus !== "verified") {
    throw new DomainError("sender_unverified", "Sender identity is not verified.", 422);
  }
  return identity;
}

/** Guard: campaign must be editable (draft/ready) for content changes. */
export function assertEditable(campaign: Campaign): void {
  if (!isCampaignEditable(campaign.status)) {
    throw new DomainError(
      "not_editable",
      `Campaign in status "${campaign.status}" cannot be edited.`,
      409,
    );
  }
}

/** Bump the campaign's updated_at (ETag) after a content change. */
export async function touchCampaign(db: Database, campaignId: string): Promise<Date> {
  const now = new Date();
  await db.update(campaigns).set({ updatedAt: now }).where(eq(campaigns.id, campaignId));
  return now;
}

/** Count snapshot rows for the prepare/preview response. */
export async function recipientCounts(db: Database, campaignId: string) {
  const rows = await db
    .select({ status: campaignRecipients.status, count: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .groupBy(campaignRecipients.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
