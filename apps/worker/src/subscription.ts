import {
  contacts,
  isSuppressed,
  lists,
  loadMembershipForRecheck,
  mintConfirmationToken,
  relays,
  senderIdentities,
  workspaces,
} from "@dispatch/db";
import { and, eq } from "drizzle-orm";
import { DomainError } from "@dispatch/domain";
import type { PipelineDeps } from "./pipeline.js";

/**
 * Send the double-opt-in confirmation email for a pending membership
 * (outbox topic `subscription.confirm`). The token is minted here, at send
 * time, so the raw value exists only in the email — never in the outbox or
 * job payload. Skips silently when the membership left the pending state or
 * the address became suppressed since the request; throws when the workspace
 * cannot send at all (no ready default relay or verified identity), which
 * surfaces as a failed job for the operator.
 */
export async function sendSubscriptionConfirmation(
  deps: PipelineDeps,
  job: { workspaceId: string; contactId: string; listId: string },
): Promise<void> {
  const membership = await loadMembershipForRecheck(deps.db, job.contactId, job.listId);
  if (membership === null || membership.state !== "pending") {
    return;
  }
  if (await isSuppressed(deps.db, job.workspaceId, membership.emailNormalized)) {
    return;
  }

  const contactRows = await deps.db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, job.contactId), eq(contacts.workspaceId, job.workspaceId)))
    .limit(1);
  const listRows = await deps.db
    .select()
    .from(lists)
    .where(and(eq(lists.id, job.listId), eq(lists.workspaceId, job.workspaceId)))
    .limit(1);
  const workspaceRows = await deps.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, job.workspaceId))
    .limit(1);
  const contact = contactRows[0];
  const list = listRows[0];
  const workspace = workspaceRows[0];
  if (contact === undefined || list === undefined || workspace === undefined) {
    return;
  }

  const relayRows = await deps.db
    .select()
    .from(relays)
    .where(
      and(
        eq(relays.workspaceId, job.workspaceId),
        eq(relays.isDefault, true),
        eq(relays.status, "ready"),
      ),
    )
    .limit(1);
  const relay = relayRows[0];
  if (relay === undefined) {
    throw new DomainError("no_relay", "Workspace has no ready default relay.", 422);
  }
  const identityRows = await deps.db
    .select()
    .from(senderIdentities)
    .where(
      and(
        eq(senderIdentities.relayId, relay.id),
        eq(senderIdentities.verificationStatus, "verified"),
      ),
    )
    .limit(1);
  const identity = identityRows[0];
  if (identity === undefined) {
    throw new DomainError("no_sender", "Default relay has no verified sender identity.", 422);
  }

  if (relay.rateLimit !== null) {
    const permit = await deps.limiter.take(`relay:${relay.id}`, {
      ratePerSecond: relay.rateLimit,
      burst: Math.max(1, relay.rateLimit),
    });
    if (!permit.allowed) {
      throw new RateLimitedConfirmationError(permit.retryAfterMs);
    }
  }

  const token = await mintConfirmationToken(deps.db, job.workspaceId, contact.id, list.id);
  const publicBase = deps.env.PUBLIC_URL.replace(/\/$/, "");
  const confirmUrl = `${publicBase}/v1/public/confirm/${token.raw}`;

  const subject = `Confirm your subscription to ${list.name}`;
  const text = [
    `Hello,`,
    ``,
    `Please confirm your subscription to "${list.name}" by opening this link:`,
    confirmUrl,
    ``,
    `If you did not request this, you can ignore this email.`,
    ``,
    `${workspace.organizationName}, ${workspace.postalAddress}`,
  ].join("\n");
  const html = [
    `<p>Hello,</p>`,
    `<p>Please confirm your subscription to &ldquo;${list.name}&rdquo; by opening this link:</p>`,
    `<p><a href="${confirmUrl}">Confirm subscription</a></p>`,
    `<p>If you did not request this, you can ignore this email.</p>`,
    `<p>${workspace.organizationName}, ${workspace.postalAddress}</p>`,
  ].join("");

  const provider = await deps.createProvider(relay.id);
  await provider.send(
    {
      messageId: token.id,
      fromEmail: identity.fromEmail,
      fromName: identity.fromName,
      replyTo: identity.replyTo,
      toEmail: contact.emailNormalized,
      subject,
      html,
      text,
      headers: {},
    },
    { workspaceId: job.workspaceId, relayId: relay.id },
  );
}

/** Thrown when the relay limiter denies the confirmation send; queue retries. */
export class RateLimitedConfirmationError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`rate limited, retry after ${retryAfterMs}ms`);
    this.name = "RateLimitedConfirmationError";
    this.retryAfterMs = retryAfterMs;
  }
}
