import {
  appendOutbox,
  contacts,
  isSuppressed,
  listMemberships,
  lists,
  consentEvents,
  consumeConfirmationToken,
  resolveConfirmationToken,
  OUTBOX_TOPICS,
} from "@dispatch/db";
import type { ConfirmationToken, Database } from "@dispatch/db";
import { DomainError, isValidEmail, normalizeEmail } from "@dispatch/domain";
import { and, eq } from "drizzle-orm";

export interface SubscribeInput {
  listId: string;
  email: string;
  customFields?: Record<string, string> | undefined;
  userAgent: string | null;
  ipHash: string | null;
}

export interface SubscriptionRequestResult {
  state: "pending" | "subscribed";
}

/**
 * Public double-opt-in entry point (architecture §4 consent flow): upsert the
 * contact, park the membership as pending, and enqueue a confirmation email
 * through the outbox. Suppressed addresses get the same "pending" answer
 * without any writes or email — suppression status is not leaked publicly.
 * An already-subscribed membership is a no-op.
 */
export async function requestSubscription(
  db: Database,
  input: SubscribeInput,
): Promise<SubscriptionRequestResult> {
  const listRows = await db.select().from(lists).where(eq(lists.id, input.listId)).limit(1);
  const list = listRows[0];
  if (list === undefined) {
    throw new DomainError("not_found", "List not found.", 404);
  }
  const emailNormalized = normalizeEmail(input.email);
  if (!isValidEmail(emailNormalized)) {
    throw new DomainError("invalid_email", "Email address is invalid.", 400);
  }
  if (await isSuppressed(db, list.workspaceId, emailNormalized)) {
    return { state: "pending" };
  }

  return db.transaction(async (tx) => {
    const contactRows = await tx
      .insert(contacts)
      .values({
        workspaceId: list.workspaceId,
        emailNormalized,
        emailOriginal: input.email.trim(),
        customFields: input.customFields ?? {},
      })
      .onConflictDoUpdate({
        target: [contacts.workspaceId, contacts.emailNormalized],
        set: { updatedAt: new Date() },
      })
      .returning({ id: contacts.id });
    const contact = contactRows[0];
    if (contact === undefined) {
      throw new Error("contact upsert failed");
    }

    const membershipRows = await tx
      .select({ state: listMemberships.state })
      .from(listMemberships)
      .where(and(eq(listMemberships.contactId, contact.id), eq(listMemberships.listId, list.id)))
      .limit(1);
    if (membershipRows[0]?.state === "subscribed") {
      return { state: "subscribed" };
    }

    await tx
      .insert(listMemberships)
      .values({
        workspaceId: list.workspaceId,
        contactId: contact.id,
        listId: list.id,
        state: "pending",
      })
      .onConflictDoUpdate({
        target: [listMemberships.contactId, listMemberships.listId],
        set: { state: "pending", updatedAt: new Date() },
      });
    await tx.insert(consentEvents).values({
      workspaceId: list.workspaceId,
      contactId: contact.id,
      listId: list.id,
      type: "requested",
      source: "subscribe_form",
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    });
    await appendOutbox(tx, {
      workspaceId: list.workspaceId,
      topic: OUTBOX_TOPICS.subscriptionConfirm,
      payload: { workspaceId: list.workspaceId, contactId: contact.id, listId: list.id },
    });
    return { state: "pending" };
  });
}

async function describeTokenRow(db: Database, token: ConfirmationToken) {
  const contactRows = await db
    .select({ email: contacts.emailNormalized })
    .from(contacts)
    .where(eq(contacts.id, token.contactId))
    .limit(1);
  const listRows =
    token.listId !== null
      ? await db.select({ name: lists.name }).from(lists).where(eq(lists.id, token.listId)).limit(1)
      : [];
  const email = contactRows[0]?.email ?? "";
  const [local, domainPart] = email.split("@");
  return {
    token,
    emailMasked: `${local?.slice(0, 2) ?? ""}***@${domainPart ?? ""}`,
    listName: listRows[0]?.name ?? null,
  };
}

/**
 * Look up a presented confirmation token for the public confirm page. Throws
 * 404 when unknown/expired and 410 when already consumed (single-use, ADR-0004).
 */
export async function describeConfirmation(db: Database, rawToken: string) {
  const token = await resolveConfirmationToken(db, rawToken);
  if (token === null) {
    throw new DomainError("not_found", "Confirmation link is invalid or expired.", 404);
  }
  if (token.usedAt !== null) {
    throw new DomainError("token_used", "Confirmation link was already used.", 410);
  }
  return describeTokenRow(db, token);
}

/**
 * Consume a confirmation token and flip the membership to subscribed with a
 * `confirmed` consent event — the legal opt-in record. Single-use is enforced
 * by a compare-and-set on `used_at` so a raced double-click confirms once.
 */
export async function confirmSubscription(
  db: Database,
  rawToken: string,
  attribution: { userAgent: string | null; ipHash: string | null },
) {
  const info = await describeConfirmation(db, rawToken);
  const { token } = info;
  await db.transaction(async (tx) => {
    const consumed = await consumeConfirmationToken(tx, token.id);
    if (!consumed) {
      throw new DomainError("token_used", "Confirmation link was already used.", 410);
    }
    if (token.listId !== null) {
      await tx
        .insert(listMemberships)
        .values({
          workspaceId: token.workspaceId,
          contactId: token.contactId,
          listId: token.listId,
          state: "subscribed",
        })
        .onConflictDoUpdate({
          target: [listMemberships.contactId, listMemberships.listId],
          set: { state: "subscribed", updatedAt: new Date() },
        });
      await tx.insert(consentEvents).values({
        workspaceId: token.workspaceId,
        contactId: token.contactId,
        listId: token.listId,
        type: "confirmed",
        source: "confirmation_link",
        ipHash: attribution.ipHash,
        userAgent: attribution.userAgent,
      });
    }
  });
  return info;
}
