import {
  campaigns,
  campaignRecipients,
  campaignVersions,
  contacts,
  insertInboundWebhookDedup,
  listMemberships,
  lists,
  messages as messagesTable,
  relays,
  senderIdentities,
  suppressions,
  uuidv7,
  workspaces,
} from "@dispatch/db";
import { createTestDb } from "@dispatch/db/testing";
import type { Database } from "@dispatch/db";
import { createMemoryRateLimiter } from "@dispatch/queue";
import { FakeRelay } from "@dispatch/testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dispatchMessage,
  normalizeInboxWebhook,
  RetryableSendError,
  runCampaignSend,
  runSchedulerTick,
  type PipelineDeps,
} from "./pipeline.js";

const env = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  PUBLIC_URL: "https://mail.example.com",
  TRACKING_URL: "https://track.example.com",
  DATABASE_URL: "postgres://localhost/dispatch",
  REDIS_URL: "redis://localhost:6379",
  CREDENTIAL_ENCRYPTION_KEY: "a".repeat(32),
  SESSION_SECRET: "b".repeat(32),
  PORT: 3000,
} as const;

let db: Database;
let close: () => Promise<void>;
let fakeRelay: FakeRelay;
let deps: PipelineDeps;
let workspaceId: string;
let relayId: string;
let listId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  fakeRelay = new FakeRelay({ providerIdempotency: true });
  deps = {
    db,
    env,
    limiter: createMemoryRateLimiter(),
    createProvider: async () => fakeRelay,
  };
  workspaceId = uuidv7();
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "W",
    slug: `w-${workspaceId.slice(0, 8)}`,
    organizationName: "Widget Inc",
    postalAddress: "1 Main St, Springfield",
  });
  relayId = uuidv7();
  await db.insert(relays).values({
    id: relayId,
    workspaceId,
    type: "ses",
    name: "fake-ses",
    credentialsEncrypted: "v1.x.y.z",
    capabilities: {
      providerIdempotency: true,
      deliveryEvents: true,
      bounceEvents: true,
      complaintEvents: true,
      scheduling: false,
    },
    status: "ready",
  });
  listId = uuidv7();
  await db.insert(lists).values({ id: listId, workspaceId, name: "news" });
});

afterAll(async () => {
  await close();
});

async function seedIdentity(): Promise<string> {
  const id = uuidv7();
  await db.insert(senderIdentities).values({
    id,
    workspaceId,
    relayId,
    domain: "example.com",
    fromEmail: `news-${id.slice(-12)}@example.com`,
    fromName: "News",
    verificationStatus: "verified",
  });
  return id;
}

async function seedContact(
  email: string,
  state: "pending" | "subscribed" | "unsubscribed" = "subscribed",
): Promise<string> {
  const contactId = uuidv7();
  await db.insert(contacts).values({
    id: contactId,
    workspaceId,
    emailNormalized: email,
    emailOriginal: email,
    customFields: { first_name: email.split("@")[0] ?? "friend" },
  });
  await db.insert(listMemberships).values({
    workspaceId,
    contactId,
    listId,
    state,
  });
  return contactId;
}

async function seedCampaign(options: {
  contactIds: string[];
  excludedContactIds?: string[];
  status?: "preparing" | "scheduled" | "ready";
  relayOverride?: string;
}) {
  const identityId = await seedIdentity();
  const campaignId = uuidv7();
  await db.insert(campaigns).values({
    id: campaignId,
    workspaceId,
    name: "June",
    status: options.status ?? "preparing",
    relayId: options.relayOverride ?? relayId,
    senderIdentityId: identityId,
  });
  const versionId = uuidv7();
  await db.insert(campaignVersions).values({
    id: versionId,
    campaignId,
    version: 1,
    subject: "Hello {{ first_name }}",
    previewText: "preview",
    fromName: "News",
    fromEmail: "news@example.com",
    bodyHtml: "<p>Hi {{ first_name }}</p>",
    bodyText: "Hi {{ first_name }}",
    audienceRef: listId,
  });
  await db
    .update(campaigns)
    .set({ currentVersionId: versionId })
    .where(eq(campaigns.id, campaignId));
  const emailByContact = new Map<string, string>();
  for (const contactId of options.contactIds) {
    const rows = await db
      .select({ email: contacts.emailNormalized })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    const email = rows[0]?.email ?? "unknown@example.com";
    emailByContact.set(contactId, email);
    await db.insert(campaignRecipients).values({
      id: uuidv7(),
      campaignId,
      campaignVersionId: versionId,
      contactId,
      email,
      personalization: { first_name: email.split("@")[0] ?? "friend" },
      status: "included",
    });
  }
  for (const contactId of options.excludedContactIds ?? []) {
    const rows = await db
      .select({ email: contacts.emailNormalized })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    await db.insert(campaignRecipients).values({
      id: uuidv7(),
      campaignId,
      campaignVersionId: versionId,
      contactId,
      email: rows[0]?.email ?? "x@example.com",
      status: "excluded",
      exclusionReason: "suppressed",
    });
  }
  return { campaignId, versionId, emailByContact };
}

describe("runCampaignSend", () => {
  it("dispatches every included recipient with compliance content", async () => {
    const a = await seedContact("flow-a@example.com");
    const b = await seedContact("flow-b@example.com");
    const { campaignId } = await seedCampaign({ contactIds: [a, b] });
    const before = fakeRelay.sent.length;

    const result = await runCampaignSend(deps, { workspaceId, campaignId });
    expect(result.created).toBe(2);
    expect(fakeRelay.sent.length).toBe(before + 2);

    const sent = fakeRelay.sent[fakeRelay.sent.length - 1];
    expect(sent?.message.headers["List-Unsubscribe"]).toContain("/v1/public/unsubscribe/");
    expect(sent?.message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent?.message.html).toContain("Widget Inc");
    expect(sent?.message.html).toContain("1 Main St, Springfield");
    expect(sent?.message.html).toContain("Unsubscribe");
    expect(sent?.message.subject).toContain("flow-b");

    const campaign = (
      await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1)
    )[0];
    expect(campaign?.status).toBe("completed");

    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.campaignId, campaignId));
    expect(rows.every((m) => m.status === "accepted")).toBe(true);
    expect(rows.every((m) => m.providerMessageId !== null)).toBe(true);
  });

  it("never duplicates a message when the job is delivered twice", async () => {
    const contact = await seedContact("dup@example.com");
    const { campaignId } = await seedCampaign({ contactIds: [contact] });
    await runCampaignSend(deps, { workspaceId, campaignId });
    const sentAfterFirst = fakeRelay.sent.length;

    // Re-deliver the campaign job and the individual dispatch job.
    await runCampaignSend(deps, { workspaceId, campaignId });
    const message = (
      await db.select().from(messagesTable).where(eq(messagesTable.campaignId, campaignId))
    )[0];
    await dispatchMessage(deps, message?.id ?? "");

    expect(fakeRelay.sent.length).toBe(sentAfterFirst);
    const all = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.campaignId, campaignId));
    expect(all).toHaveLength(1);
  });

  it("recovers a provider timeout after acceptance without sending twice", async () => {
    const contact = await seedContact("lost-response@example.com");
    const { campaignId } = await seedCampaign({ contactIds: [contact] });

    fakeRelay.loseNextSendResponse();
    await expect(runCampaignSend(deps, { workspaceId, campaignId })).rejects.toThrow(
      RetryableSendError,
    );
    const accepted = fakeRelay.sent.length;

    // Retry: the fake provider dedups on our message id.
    await runCampaignSend(deps, { workspaceId, campaignId });
    expect(fakeRelay.sent.length).toBe(accepted);
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.campaignId, campaignId));
    expect(rows[0]?.status).toBe("accepted");
    expect(rows[0]?.providerMessageId).not.toBeNull();
  });

  it("lets an unsubscribe that lands mid-send win over the snapshot", async () => {
    const contact = await seedContact("mid-send-unsub@example.com");
    const { campaignId } = await seedCampaign({ contactIds: [contact] });
    const sentBefore = fakeRelay.sent.length;

    // Unsubscribe after prepare but before dispatch.
    await db
      .update(listMemberships)
      .set({ state: "unsubscribed" })
      .where(eq(listMemberships.contactId, contact));

    await runCampaignSend(deps, { workspaceId, campaignId });
    expect(fakeRelay.sent.length).toBe(sentBefore);
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.campaignId, campaignId));
    expect(rows[0]?.status).toBe("unsubscribed");
  });

  it("skips contacts suppressed after prepare", async () => {
    const contact = await seedContact("late-suppressed@example.com");
    const { campaignId } = await seedCampaign({ contactIds: [contact] });
    await db.insert(suppressions).values({
      workspaceId,
      emailNormalized: "late-suppressed@example.com",
      reason: "manual",
      source: "test",
    });
    const sentBefore = fakeRelay.sent.length;
    await runCampaignSend(deps, { workspaceId, campaignId });
    expect(fakeRelay.sent.length).toBe(sentBefore);
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.campaignId, campaignId));
    expect(rows[0]?.status).toBe("suppressed");
  });

  it("marks terminal provider failures as failed without retry", async () => {
    const contact = await seedContact("terminal@example.com");
    const { campaignId } = await seedCampaign({ contactIds: [contact] });
    const terminal = Object.assign(new Error("rejected"), { code: "MessageRejected" });
    fakeRelay.failNextSend(terminal);
    await runCampaignSend(deps, { workspaceId, campaignId });
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.campaignId, campaignId));
    expect(rows[0]?.status).toBe("failed");
  });
});

describe("normalizeInboxWebhook", () => {
  async function sendOne(email: string) {
    const contact = await seedContact(email);
    const { campaignId } = await seedCampaign({ contactIds: [contact] });
    await runCampaignSend(deps, { workspaceId, campaignId });
    const message = (
      await db.select().from(messagesTable).where(eq(messagesTable.campaignId, campaignId))
    )[0];
    return { campaignId, message };
  }

  async function inboxEvent(payload: Record<string, unknown>) {
    const stored = await insertInboundWebhookDedup(db, {
      workspaceId,
      relayId,
      headers: {},
      payload: JSON.stringify(payload),
      payloadHash: uuidv7(),
    });
    await normalizeInboxWebhook(deps, stored.id as string);
    return stored.id;
  }

  it("marks delivered messages and dedups replays", async () => {
    const { message } = await sendOne("deliver-me@example.com");
    const payload = {
      providerEventId: "evt-delivered-1",
      type: "delivered",
      providerMessageId: message?.providerMessageId,
    };
    await inboxEvent(payload);
    let rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, message?.id ?? ""));
    expect(rows[0]?.status).toBe("delivered");

    // Replay the identical event: still delivered, single event row.
    await inboxEvent(payload);
    const eventRows = await db.query.events.findMany({
      where: (t, { eq: e }) => e(t.providerEventId, "evt-delivered-1"),
    });
    expect(eventRows).toHaveLength(1);
    rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, message?.id ?? ""));
    expect(rows[0]?.status).toBe("delivered");
  });

  it("creates suppressions from hard bounces and complaints", async () => {
    const { message: bounced } = await sendOne("bounce-me@example.com");
    await inboxEvent({
      providerEventId: "evt-bounce-1",
      type: "bounced",
      providerMessageId: bounced?.providerMessageId,
    });
    const { message: complained } = await sendOne("complain-me@example.com");
    await inboxEvent({
      providerEventId: "evt-complaint-1",
      type: "complained",
      providerMessageId: complained?.providerMessageId,
    });

    const sup = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.workspaceId, workspaceId));
    const byEmail = new Map(sup.map((s) => [s.emailNormalized, s.reason]));
    expect(byEmail.get("bounce-me@example.com")).toBe("hard_bounce");
    expect(byEmail.get("complain-me@example.com")).toBe("complaint");
  });
});

describe("runSchedulerTick", () => {
  it("moves due scheduled campaigns to preparing with an outbox row", async () => {
    const contact = await seedContact("scheduled@example.com");
    const { campaignId } = await seedCampaign({ contactIds: [contact], status: "scheduled" });
    await db
      .update(campaigns)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(campaigns.id, campaignId));
    const fired = await runSchedulerTick(db);
    expect(fired).toBeGreaterThanOrEqual(1);
    const campaign = (
      await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1)
    )[0];
    expect(campaign?.status).toBe("preparing");
  });
});
