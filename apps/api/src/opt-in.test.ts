import { drainOutboxOnce, createMemoryRateLimiter } from "@dispatch/queue";
import {
  consentEvents,
  confirmationTokens,
  contacts,
  outbox,
  suppressions,
  uuidv7,
} from "@dispatch/db";
import { and, eq } from "drizzle-orm";
import { generateToken } from "@dispatch/domain";
import { sendSubscriptionConfirmation, type PipelineDeps } from "@dispatch/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, testEnv, type TestContext } from "./test-utils.js";

/**
 * Double opt-in end to end: public subscribe → pending membership → outbox →
 * worker confirmation email → single-use confirm → subscribed with a
 * `confirmed` consent event.
 */

let ctx: TestContext;
let pipeline: PipelineDeps;
let listId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  pipeline = {
    db: ctx.db,
    env: testEnv(),
    limiter: createMemoryRateLimiter(),
    createProvider: async () => ctx.fakeRelay,
  };

  const listRes = await json("POST", "/v1/lists", { name: "newsletter" });
  expect(listRes.status).toBe(201);
  listId = ((await listRes.json()) as { id: string }).id;

  const relayRes = await json("POST", "/v1/relays", {
    type: "ses",
    name: "default",
    credentials: { region: "us-east-1", accessKeyId: "x", secretAccessKey: "y" },
    capabilities: ctx.fakeRelay.capabilities,
    isDefault: true,
  });
  expect(relayRes.status).toBe(201);
  const relay = (await relayRes.json()) as { id: string };
  await json("POST", `/v1/relays/${relay.id}/test-connection`);

  const identityRes = await json("POST", "/v1/sender-identities", {
    relayId: relay.id,
    domain: "example.com",
    fromEmail: "news@example.com",
    fromName: "News",
  });
  expect(identityRes.status).toBe(201);
  const identity = (await identityRes.json()) as { id: string };
  await json("POST", `/v1/sender-identities/${identity.id}/verify`);
});

afterAll(async () => {
  await ctx.close();
});

function json(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return ctx.app.request(path, {
    method,
    headers: { ...auth(ctx), "content-type": "application/json", ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Public routes take no API key. */
function postPublic(path: string, body?: unknown) {
  return ctx.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function confirmOutboxRows() {
  return ctx.db
    .select()
    .from(outbox)
    .where(and(eq(outbox.workspaceId, ctx.workspaceId), eq(outbox.topic, "subscription.confirm")));
}

async function runOutbox() {
  await drainOutboxOnce({
    db: ctx.db,
    enqueue: async (topic, payload) => {
      if (topic === "subscription.confirm") {
        await sendSubscriptionConfirmation(
          pipeline,
          payload as { workspaceId: string; contactId: string; listId: string },
        );
      }
    },
  });
}

describe("double opt-in", () => {
  it("runs the full loop: subscribe, confirm email, single-use confirm", async () => {
    const res = await postPublic("/v1/public/subscribe", {
      listId,
      email: "Ada@Example.com",
      customFields: { first_name: "Ada" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("pending");

    const membership = await ctx.db.query.listMemberships.findFirst({
      where: (t, { eq: e }) => e(t.listId, listId),
    });
    expect(membership?.state).toBe("pending");
    expect(await confirmOutboxRows()).toHaveLength(1);

    await runOutbox();
    expect(ctx.fakeRelay.sent).toHaveLength(1);
    const sentMessage = ctx.fakeRelay.sent[0]?.message;
    expect(sentMessage?.toEmail).toBe("ada@example.com");
    const match = /\/v1\/public\/confirm\/([A-Za-z0-9_-]+)/.exec(sentMessage?.html ?? "");
    expect(match).not.toBeNull();
    const rawToken = match?.[1] ?? "";

    const describeRes = await ctx.app.request(`/v1/public/confirm/${rawToken}`);
    expect(describeRes.status).toBe(200);
    expect(((await describeRes.json()) as { email: string }).email).toBe("ad***@example.com");

    const confirmRes = await postPublic(`/v1/public/confirm/${rawToken}`);
    expect(confirmRes.status).toBe(200);
    expect(((await confirmRes.json()) as { state: string }).state).toBe("subscribed");

    const confirmed = await ctx.db.query.listMemberships.findFirst({
      where: (t, { eq: e }) => e(t.listId, listId),
    });
    expect(confirmed?.state).toBe("subscribed");

    const events = await ctx.db
      .select({ type: consentEvents.type, source: consentEvents.source })
      .from(consentEvents)
      .where(eq(consentEvents.workspaceId, ctx.workspaceId));
    expect(events.map((e) => e.type)).toEqual(["requested", "confirmed"]);

    // Single-use: a replay is 410 and does not insert a second consent event.
    const replay = await postPublic(`/v1/public/confirm/${rawToken}`);
    expect(replay.status).toBe(410);
    const eventsAfter = await ctx.db
      .select({ type: consentEvents.type })
      .from(consentEvents)
      .where(eq(consentEvents.workspaceId, ctx.workspaceId));
    expect(eventsAfter).toHaveLength(2);
  });

  it("re-requesting while subscribed is a no-op without a new email", async () => {
    const res = await postPublic("/v1/public/subscribe", { listId, email: "ada@example.com" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("subscribed");
    expect(await confirmOutboxRows()).toHaveLength(1);
    expect(ctx.fakeRelay.sendCalls).toBe(1);
  });

  it("answers suppressed addresses identically without writes or email", async () => {
    await ctx.db.insert(suppressions).values({
      workspaceId: ctx.workspaceId,
      emailNormalized: "bounce@example.com",
      reason: "hard_bounce",
      source: "webhook",
    });
    const res = await postPublic("/v1/public/subscribe", { listId, email: "bounce@example.com" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("pending");
    expect(await confirmOutboxRows()).toHaveLength(1);
    const contact = await ctx.db.query.contacts.findFirst({
      where: (t, { eq: e }) => e(t.emailNormalized, "bounce@example.com"),
    });
    expect(contact).toBeUndefined();
  });

  it("rejects unknown lists and invalid tokens", async () => {
    const unknownList = await postPublic("/v1/public/subscribe", {
      listId: uuidv7(),
      email: "x@example.com",
    });
    expect(unknownList.status).toBe(404);

    const unknownToken = await postPublic("/v1/public/confirm/not-a-token");
    expect(unknownToken.status).toBe(404);

    const expired = generateToken();
    const contactId = uuidv7();
    await ctx.db.insert(contacts).values({
      id: contactId,
      workspaceId: ctx.workspaceId,
      emailNormalized: "expired@example.com",
      emailOriginal: "expired@example.com",
    });
    await ctx.db.insert(confirmationTokens).values({
      workspaceId: ctx.workspaceId,
      contactId,
      listId,
      action: "confirm_subscription",
      tokenHash: expired.hash,
      expiresAt: new Date(Date.now() - 1000),
    });
    const expiredRes = await postPublic(`/v1/public/confirm/${expired.raw}`);
    expect(expiredRes.status).toBe(404);
  });
});
