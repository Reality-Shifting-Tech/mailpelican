import {
  campaignRecipients,
  campaigns,
  campaignVersions,
  contacts,
  events,
  messages,
  relays,
  uuidv7,
} from "@dispatch/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;
let campaignId: string;
let messageId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const relayId = uuidv7();
  await ctx.db.insert(relays).values({
    id: relayId,
    workspaceId: ctx.workspaceId,
    type: "ses",
    name: "r",
    credentialsEncrypted: "v1.x.y.z",
    capabilities: {
      providerIdempotency: true,
      deliveryEvents: true,
      bounceEvents: true,
      complaintEvents: true,
      scheduling: false,
    },
  });
  const contactId = uuidv7();
  await ctx.db.insert(contacts).values({
    id: contactId,
    workspaceId: ctx.workspaceId,
    emailNormalized: "ada@example.com",
    emailOriginal: "ada@example.com",
  });
  campaignId = uuidv7();
  await ctx.db.insert(campaigns).values({
    id: campaignId,
    workspaceId: ctx.workspaceId,
    name: "June",
    status: "completed",
  });
  const versionId = uuidv7();
  await ctx.db.insert(campaignVersions).values({
    id: versionId,
    campaignId,
    version: 1,
    subject: "s",
    fromName: "News",
    fromEmail: "news@example.com",
    bodyHtml: "<p>Hi</p>",
    bodyText: "Hi",
    audienceRef: uuidv7(),
  });
  const recipientId = uuidv7();
  await ctx.db.insert(campaignRecipients).values({
    id: recipientId,
    campaignId,
    campaignVersionId: versionId,
    contactId,
    email: "ada@example.com",
    status: "included",
  });
  messageId = recipientId;
  await ctx.db.insert(messages).values({
    id: messageId,
    workspaceId: ctx.workspaceId,
    campaignId,
    campaignRecipientId: recipientId,
    contactId,
    relayId,
    status: "delivered",
  });
});

afterAll(async () => {
  await ctx.close();
});

async function recordedEvents() {
  return ctx.db.select().from(events).where(eq(events.messageId, messageId));
}

describe("open/click tracking", () => {
  it("serves the pixel and records an open per request", async () => {
    const res = await ctx.app.request(`/v1/track/open/${messageId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBeGreaterThan(30);

    await ctx.app.request(`/v1/track/open/${messageId}`);
    const rows = await recordedEvents();
    expect(rows.filter((r) => r.type === "opened")).toHaveLength(2);
  });

  it("redirects clicks and records the destination", async () => {
    const res = await ctx.app.request(
      `/v1/track/click/${messageId}?url=${encodeURIComponent("https://example.com/a?x=1")}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/a?x=1");
    const rows = await recordedEvents();
    const click = rows.find((r) => r.type === "clicked");
    expect(click?.meta.url).toBe("https://example.com/a?x=1");
  });

  it("rejects non-http destinations", async () => {
    for (const bad of ["javascript:alert(1)", "ftp://example.com/x", "not-a-url"]) {
      const res = await ctx.app.request(
        `/v1/track/click/${messageId}?url=${encodeURIComponent(bad)}`,
      );
      expect(res.status).toBe(400);
    }
  });

  it("serves unknown message ids without recording", async () => {
    const unknown = uuidv7();
    const open = await ctx.app.request(`/v1/track/open/${unknown}`);
    expect(open.status).toBe(200);
    const click = await ctx.app.request(
      `/v1/track/click/${unknown}?url=${encodeURIComponent("https://example.com/")}`,
    );
    expect(click.status).toBe(302);
    const rows = await ctx.db.select().from(events).where(eq(events.messageId, unknown));
    expect(rows).toHaveLength(0);
  });

  it("surfaces opens and clicks in campaign stats", async () => {
    const res = await ctx.app.request(`/v1/stats/campaigns/${campaignId}`, {
      headers: auth(ctx),
    });
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      events: Record<string, number>;
      totals: { uniqueOpens: number; uniqueClicks: number };
    };
    expect(stats.events.opened).toBe(2);
    expect(stats.events.clicked).toBe(1);
    expect(stats.totals.uniqueOpens).toBe(1);
    expect(stats.totals.uniqueClicks).toBe(1);
  });
});
