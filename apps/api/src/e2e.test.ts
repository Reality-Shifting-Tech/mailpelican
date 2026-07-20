import { drainOutboxOnce } from "@dispatch/queue";
import { contacts, listMemberships, suppressions } from "@dispatch/db";
import { eq } from "drizzle-orm";
import { FakeRelay } from "@dispatch/testkit";
import { runCampaignSend, normalizeInboxWebhook, type PipelineDeps } from "@dispatch/worker";
import { createMemoryRateLimiter } from "@dispatch/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, testEnv, type TestContext } from "./test-utils.js";

/**
 * M1 exit-criteria walkthrough: configure SES + Resend relays, import with
 * consent, build content, preview, prepare, confirm, send through both fake
 * relays, process feedback, suppress, unsubscribe, and report.
 */

let ctx: TestContext;
let fakeSes: FakeRelay;
let fakeResend: FakeRelay;
let pipeline: PipelineDeps;

const providers = new Map<string, FakeRelay>();

beforeAll(async () => {
  ctx = await createTestContext();
  fakeSes = new FakeRelay({ type: "ses", providerIdempotency: true });
  fakeResend = new FakeRelay({ type: "resend", providerIdempotency: true });
  pipeline = {
    db: ctx.db,
    env: testEnv(),
    limiter: createMemoryRateLimiter(),
    createProvider: async (relayId) => {
      const provider = providers.get(relayId);
      if (provider === undefined) {
        throw new Error(`no fake provider for ${relayId}`);
      }
      return provider;
    },
  };
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

async function setupRelay(type: "ses" | "resend", fake: FakeRelay) {
  const res = await json("POST", "/v1/relays", {
    type,
    name: type,
    credentials:
      type === "ses"
        ? { region: "us-east-1", accessKeyId: "x", secretAccessKey: "y" }
        : { apiKey: "re_test" },
    capabilities: fake.capabilities,
    rateLimit: 100,
  });
  expect(res.status).toBe(201);
  const relay = (await res.json()) as { id: string };
  providers.set(relay.id, fake);
  const test = await json("POST", `/v1/relays/${relay.id}/test-connection`);
  expect(((await test.json()) as { health: { ok: boolean } }).health.ok).toBe(true);
  return relay.id;
}

async function setupIdentity(relayId: string, fromEmail: string) {
  const res = await json("POST", "/v1/sender-identities", {
    relayId,
    domain: "example.com",
    fromEmail,
    fromName: "News",
  });
  expect(res.status).toBe(201);
  const identity = (await res.json()) as { id: string; dnsRecords: unknown[] };
  expect(identity.dnsRecords.length).toBeGreaterThan(0);
  const verify = await json("POST", `/v1/sender-identities/${identity.id}/verify`);
  expect(((await verify.json()) as { verificationStatus: string }).verificationStatus).toBe(
    "verified",
  );
  return identity.id;
}

async function runOutbox() {
  await drainOutboxOnce({
    db: ctx.db,
    enqueue: async (topic, payload) => {
      if (topic === "campaign.send") {
        await runCampaignSend(pipeline, payload as { workspaceId: string; campaignId: string });
      }
      if (topic === "webhook.normalize") {
        await normalizeInboxWebhook(pipeline, (payload as { inboxId: string }).inboxId);
      }
    },
  });
}

describe("M1 end-to-end safe send", () => {
  let listId: string;
  let sesRelayId: string;
  let resendRelayId: string;

  it("completes the full loop through SES and Resend", async () => {
    // 1. Relays and identities
    sesRelayId = await setupRelay("ses", fakeSes);
    resendRelayId = await setupRelay("resend", fakeResend);

    // 2. List + import with consent
    const list = await json("POST", "/v1/lists", { name: "newsletter" });
    listId = ((await list.json()) as { id: string }).id;
    const importRes = await json(
      "POST",
      "/v1/contacts/import",
      {
        listId,
        source: "e2e",
        contacts: [
          { email: "ses-user@example.com", customFields: { first_name: "Ses" } },
          { email: "resend-user@example.com", customFields: { first_name: "Resend" } },
          { email: "bouncer@example.com" },
          { email: "complainer@example.com" },
          { email: "unsubscriber@example.com" },
        ],
      },
      { "idempotency-key": "e2e-import-1" },
    );
    expect(importRes.status).toBe(200);
    expect(((await importRes.json()) as { created: number }).created).toBe(5);

    // 3. Template + campaign per relay
    async function createAndSend(relayId: string, identityEmail: string, key: string) {
      const identityId = await setupIdentity(relayId, identityEmail);
      const template = await json("POST", "/v1/templates", { name: `tpl-${key}` });
      const templateId = ((await template.json()) as { id: string }).id;
      const version = await json("POST", `/v1/templates/${templateId}/versions`, {
        subject: "Hi {{ first_name }}",
        bodyHtml: "<p>Hello {{ first_name }}</p>",
        bodyText: "Hello {{ first_name }}",
      });
      expect(version.status).toBe(201);

      const campaign = await json("POST", "/v1/campaigns", {
        name: `campaign-${key}`,
        subject: "Hi {{ first_name }}",
        previewText: "news",
        fromName: "News",
        fromEmail: identityEmail,
        bodyHtml: "<p>Hello {{ first_name }}</p>",
        bodyText: "Hello {{ first_name }}",
        audienceRef: listId,
        relayId,
        senderIdentityId: identityId,
      });
      expect(campaign.status).toBe(201);
      const created = (await campaign.json()) as { id: string; lint: unknown[] };
      expect(created.lint).toEqual([]);

      const preview = await json("POST", `/v1/campaigns/${created.id}/preview`);
      const previewBody = (await preview.json()) as {
        samples: { subject: string }[];
      };
      expect(previewBody.samples.length).toBeGreaterThan(0);
      expect(previewBody.samples[0]?.subject).toMatch(/^Hi /);

      const prepare = await json("POST", `/v1/campaigns/${created.id}/prepare`);
      expect(prepare.status).toBe(200);
      const prepared = (await prepare.json()) as {
        included: number;
        confirmationToken: string;
      };
      expect(prepared.included).toBe(5);

      const confirm = await json(
        "POST",
        `/v1/campaigns/${created.id}/confirm-send`,
        { confirmationToken: prepared.confirmationToken },
        { "idempotency-key": `confirm-${key}` },
      );
      expect(confirm.status).toBe(200);
      return created.id;
    }

    const sesCampaign = await createAndSend(sesRelayId, "ses@example.com", "ses");
    const resendCampaign = await createAndSend(resendRelayId, "resend@example.com", "resend");

    // 4. Outbox drains into the send pipeline through both fake relays.
    await runOutbox();
    expect(fakeSes.sent.length).toBe(5);
    expect(fakeResend.sent.length).toBe(5);

    // 5. Webhook feedback: delivery for most, bounce and complaint for two.
    async function webhook(relayId: string, payload: Record<string, unknown>) {
      const res = await ctx.app.request(`/v1/webhooks/provider/${relayId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      await runOutbox();
    }

    for (const [relayId, fake] of [
      [sesRelayId, fakeSes],
      [resendRelayId, fakeResend],
    ] as const) {
      for (const record of fake.sent) {
        const message = await ctx.db.query.messages.findFirst({
          where: (t, { eq: e }) => e(t.id, record.message.messageId),
        });
        const type = record.message.toEmail.startsWith("bouncer")
          ? "bounced"
          : record.message.toEmail.startsWith("complainer")
            ? "complained"
            : "delivered";
        await webhook(relayId, {
          providerEventId: `evt-${record.message.messageId}`,
          type,
          providerMessageId: message?.providerMessageId ?? null,
        });
      }
    }

    // 6. Suppressions created from hard bounce + complaint.
    const sup = await ctx.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.workspaceId, ctx.workspaceId));
    const supByEmail = new Map(sup.map((s) => [s.emailNormalized, s.reason]));
    expect(supByEmail.get("bouncer@example.com")).toBe("hard_bounce");
    expect(supByEmail.get("complainer@example.com")).toBe("complaint");

    // 7. Unsubscribe via public endpoints (link extracted from a sent message).
    const unsubRecord = fakeSes.sent.find((s) => s.message.toEmail === "unsubscriber@example.com");
    const listUnsub = unsubRecord?.message.headers["List-Unsubscribe"] ?? "";
    const url = /<https:\/\/mail\.example\.com(\/v1\/public\/unsubscribe\/[^>]+)>/.exec(listUnsub);
    expect(url).not.toBeNull();
    const path = url?.[1] ?? "";

    const describeRes = await ctx.app.request(path);
    expect(describeRes.status).toBe(200);
    expect(((await describeRes.json()) as { state: string }).state).toBe("subscribed");

    const oneClickPath = path.replace("/unsubscribe/", "/one-click-unsubscribe/");
    const oneClick = await ctx.app.request(oneClickPath, { method: "POST" });
    expect(oneClick.status).toBe(200);
    // RFC 8058 replays are idempotent.
    const replay = await ctx.app.request(oneClickPath, { method: "POST" });
    expect(replay.status).toBe(200);

    const unsubState = await ctx.db
      .select({ state: listMemberships.state })
      .from(listMemberships)
      .innerJoin(contacts, eq(listMemberships.contactId, contacts.id))
      .where(eq(contacts.emailNormalized, "unsubscriber@example.com"));
    expect(unsubState[0]?.state).toBe("unsubscribed");

    // 8. Stats reflect reality for the SES campaign.
    const stats = await json("GET", `/v1/stats/campaigns/${sesCampaign}`);
    const statsBody = (await stats.json()) as {
      totals: { delivered: number; bounced: number; complained: number };
    };
    expect(statsBody.totals.delivered).toBe(3);
    expect(statsBody.totals.bounced).toBe(1);
    expect(statsBody.totals.complained).toBe(1);

    const resendStats = await json("GET", `/v1/stats/campaigns/${resendCampaign}`);
    expect(resendStats.status).toBe(200);
  });
});
