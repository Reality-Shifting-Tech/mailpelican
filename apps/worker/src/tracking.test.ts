import {
  campaigns,
  campaignRecipients,
  campaignVersions,
  contacts,
  listMemberships,
  lists,
  relays,
  senderIdentities,
  uuidv7,
  workspaces,
} from "@dispatch/db";
import { createTestDb } from "@dispatch/db/testing";
import type { Database } from "@dispatch/db";
import { createMemoryRateLimiter } from "@dispatch/queue";
import { FakeRelay } from "@dispatch/testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCampaignSend, type PipelineDeps } from "./pipeline.js";

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
let identityId: string;
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
  identityId = uuidv7();
  await db.insert(senderIdentities).values({
    id: identityId,
    workspaceId,
    relayId,
    domain: "example.com",
    fromEmail: "news@example.com",
    fromName: "News",
    verificationStatus: "verified",
  });
  listId = uuidv7();
  await db.insert(lists).values({ id: listId, workspaceId, name: "news" });
});

afterAll(async () => {
  await close();
});

async function seedSendableContact(email: string, trackingDisabled = false): Promise<string> {
  const contactId = uuidv7();
  await db.insert(contacts).values({
    id: contactId,
    workspaceId,
    emailNormalized: email,
    emailOriginal: email,
    trackingDisabled,
  });
  await db.insert(listMemberships).values({ workspaceId, contactId, listId, state: "subscribed" });
  return contactId;
}

async function seedCampaignWithLink(
  contactId: string,
  trackingOptions?: {
    opens: boolean;
    clicks: boolean;
  },
) {
  const campaignId = uuidv7();
  await db.insert(campaigns).values({
    id: campaignId,
    workspaceId,
    name: "Tracked",
    status: "preparing",
    relayId,
    senderIdentityId: identityId,
  });
  const versionId = uuidv7();
  await db.insert(campaignVersions).values({
    id: versionId,
    campaignId,
    version: 1,
    subject: "Hello",
    previewText: "",
    fromName: "News",
    fromEmail: "news@example.com",
    bodyHtml: '<p>Hi</p><a href="https://example.com/offer">Offer</a>',
    bodyText: "Hi https://example.com/offer",
    audienceRef: listId,
    ...(trackingOptions !== undefined ? { trackingOptions } : {}),
  });
  await db
    .update(campaigns)
    .set({ currentVersionId: versionId })
    .where(eq(campaigns.id, campaignId));
  const recipientId = uuidv7();
  await db.insert(campaignRecipients).values({
    id: recipientId,
    campaignId,
    campaignVersionId: versionId,
    contactId,
    email: "ada@example.com",
    status: "included",
  });
  return campaignId;
}

describe("tracking injection", () => {
  it("injects the pixel and rewrites links, never the unsubscribe URL", async () => {
    const contactId = await seedSendableContact("ada@example.com");
    const campaignId = await seedCampaignWithLink(contactId);
    const before = fakeRelay.sent.length;

    await runCampaignSend(deps, { workspaceId, campaignId });

    const sent = fakeRelay.sent[fakeRelay.sent.length - 1];
    expect(fakeRelay.sent.length).toBe(before + 1);
    const html = sent?.message.html ?? "";
    expect(html).toContain(`https://track.example.com/v1/track/open/${sent?.message.messageId}`);
    expect(html).toContain(
      `https://track.example.com/v1/track/click/${sent?.message.messageId}?url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(html).not.toContain("url=https%3A%2F%2Fmail.example.com%2Fv1%2Fpublic%2Funsubscribe");
    expect(html).toContain("https://mail.example.com/v1/public/unsubscribe/");
  });

  it("sends untracked mail to contacts with trackingDisabled", async () => {
    const contactId = await seedSendableContact("private@example.com", true);
    const campaignId = await seedCampaignWithLink(contactId);
    const before = fakeRelay.sent.length;

    await runCampaignSend(deps, { workspaceId, campaignId });

    const sent = fakeRelay.sent[fakeRelay.sent.length - 1];
    expect(fakeRelay.sent.length).toBe(before + 1);
    const html = sent?.message.html ?? "";
    expect(html).not.toContain("track.example.com");
    expect(html).toContain('href="https://example.com/offer"');
  });

  it("honors version-level tracking options", async () => {
    const contactId = await seedSendableContact("no-track@example.com");
    const campaignId = await seedCampaignWithLink(contactId, { opens: false, clicks: false });
    const before = fakeRelay.sent.length;

    await runCampaignSend(deps, { workspaceId, campaignId });

    const sent = fakeRelay.sent[fakeRelay.sent.length - 1];
    expect(fakeRelay.sent.length).toBe(before + 1);
    expect(sent?.message.html ?? "").not.toContain("track.example.com");
  });
});
