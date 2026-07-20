import {
  confirmationTokens,
  contacts,
  listMemberships,
  lists,
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
import type { PipelineDeps } from "./pipeline.js";
import { sendSubscriptionConfirmation } from "./subscription.js";

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
    name: "default",
    credentialsEncrypted: "v1.x.y.z",
    capabilities: {
      providerIdempotency: true,
      deliveryEvents: true,
      bounceEvents: true,
      complaintEvents: true,
      scheduling: false,
    },
    status: "ready",
    isDefault: true,
  });
  await db.insert(senderIdentities).values({
    id: uuidv7(),
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

async function seedPending(
  email: string,
  state: "pending" | "subscribed" | "unsubscribed" = "pending",
): Promise<string> {
  const contactId = uuidv7();
  await db.insert(contacts).values({
    id: contactId,
    workspaceId,
    emailNormalized: email,
    emailOriginal: email,
  });
  await db.insert(listMemberships).values({ workspaceId, contactId, listId, state });
  return contactId;
}

describe("sendSubscriptionConfirmation", () => {
  it("mints a token and sends the confirmation email to a pending member", async () => {
    const contactId = await seedPending("ada@example.com");
    await sendSubscriptionConfirmation(deps, { workspaceId, contactId, listId });

    expect(fakeRelay.sent).toHaveLength(1);
    const message = fakeRelay.sent[0]?.message;
    expect(message?.toEmail).toBe("ada@example.com");
    expect(message?.subject).toBe("Confirm your subscription to news");
    expect(message?.html).toContain("/v1/public/confirm/");

    const tokens = await db
      .select()
      .from(confirmationTokens)
      .where(eq(confirmationTokens.contactId, contactId));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.action).toBe("confirm_subscription");
    // Provider idempotency key is the token row id.
    expect(message?.messageId).toBe(tokens[0]?.id);
  });

  it("skips members who are no longer pending", async () => {
    const contactId = await seedPending("grace@example.com", "subscribed");
    await sendSubscriptionConfirmation(deps, { workspaceId, contactId, listId });
    expect(fakeRelay.sent).toHaveLength(1);
  });

  it("skips suppressed addresses", async () => {
    const contactId = await seedPending("bounce@example.com");
    await db.insert(suppressions).values({
      workspaceId,
      emailNormalized: "bounce@example.com",
      reason: "hard_bounce",
      source: "webhook",
    });
    await sendSubscriptionConfirmation(deps, { workspaceId, contactId, listId });
    expect(fakeRelay.sent).toHaveLength(1);
  });

  it("throws when the workspace has no ready default relay", async () => {
    const otherWorkspace = uuidv7();
    await db.insert(workspaces).values({
      id: otherWorkspace,
      name: "W2",
      slug: `w2-${otherWorkspace.slice(0, 8)}`,
      organizationName: "Other Inc",
      postalAddress: "2 Side St",
    });
    const otherList = uuidv7();
    await db.insert(lists).values({ id: otherList, workspaceId: otherWorkspace, name: "x" });
    const contactId = uuidv7();
    await db.insert(contacts).values({
      id: contactId,
      workspaceId: otherWorkspace,
      emailNormalized: "no-relay@example.com",
      emailOriginal: "no-relay@example.com",
    });
    await db
      .insert(listMemberships)
      .values({ workspaceId: otherWorkspace, contactId, listId: otherList, state: "pending" });

    await expect(
      sendSubscriptionConfirmation(deps, {
        workspaceId: otherWorkspace,
        contactId,
        listId: otherList,
      }),
    ).rejects.toThrow("no ready default relay");
  });
});
