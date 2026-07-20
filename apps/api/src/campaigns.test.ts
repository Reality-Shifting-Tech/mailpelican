import { relays, senderIdentities, uuidv7 } from "@dispatch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;
let listId: string;
let relayId: string;
let identityId: string;

async function seedRelayAndIdentity(
  target: TestContext,
): Promise<{ relayId: string; identityId: string }> {
  const rId = uuidv7();
  await target.db.insert(relays).values({
    id: rId,
    workspaceId: target.workspaceId,
    type: "ses",
    name: "fake",
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
  const iId = uuidv7();
  await target.db.insert(senderIdentities).values({
    id: iId,
    workspaceId: target.workspaceId,
    relayId: rId,
    domain: "example.com",
    fromEmail: `news-${iId.slice(-12)}@example.com`,
    fromName: "News",
    verificationStatus: "verified",
  });
  return { relayId: rId, identityId: iId };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const res = await ctx.app.request("/v1/lists", {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify({ name: "news" }),
  });
  listId = ((await res.json()) as { id: string }).id;
  ({ relayId, identityId } = await seedRelayAndIdentity(ctx));
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

async function createCampaign() {
  const identity = await ctx.db
    .select({ fromEmail: senderIdentities.fromEmail })
    .from(senderIdentities)
    .then((rows) => rows.find((r) => r.fromEmail.length > 0)?.fromEmail ?? "news@example.com");
  const res = await json("POST", "/v1/campaigns", {
    name: "draft",
    subject: "Hello",
    previewText: "p",
    fromName: "News",
    fromEmail: identity,
    bodyHtml: "<p>hi</p>",
    bodyText: "hi",
    audienceRef: listId,
    relayId,
    senderIdentityId: identityId,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("campaign drafts", () => {
  it("enforces If-Match optimistic concurrency on edits", async () => {
    const id = await createCampaign();
    const get = await json("GET", `/v1/campaigns/${id}`);
    const etag = get.headers.get("etag");
    expect(etag).toBeTruthy();

    const noMatch = await json("PATCH", `/v1/campaigns/${id}`, { subject: "new" });
    expect(noMatch.status).toBe(428);

    const ok = await json(
      "PATCH",
      `/v1/campaigns/${id}`,
      { subject: "new" },
      { "if-match": etag ?? "" },
    );
    expect(ok.status).toBe(200);

    const stale = await json(
      "PATCH",
      `/v1/campaigns/${id}`,
      { subject: "x" },
      { "if-match": etag ?? "" },
    );
    expect(stale.status).toBe(409);
  });

  it("creates a new immutable version on content edits", async () => {
    const id = await createCampaign();
    const get1 = await json("GET", `/v1/campaigns/${id}`);
    const etag1 = get1.headers.get("etag") ?? "";
    const body1 = (await get1.json()) as { version: { id: string; version: number } };
    await json("PATCH", `/v1/campaigns/${id}`, { subject: "v2 subject" }, { "if-match": etag1 });
    const get2 = await json("GET", `/v1/campaigns/${id}`);
    const body2 = (await get2.json()) as { version: { id: string; version: number } };
    expect(body2.version.version).toBe(body1.version.version + 1);
    expect(body2.version.id).not.toBe(body1.version.id);
  });

  it("rejects confirmation token reuse and double send", async () => {
    const id = await createCampaign();
    const prepare = await json("POST", `/v1/campaigns/${id}/prepare`);
    const prepared = (await prepare.json()) as { confirmationToken: string };

    const first = await json(
      "POST",
      `/v1/campaigns/${id}/confirm-send`,
      { confirmationToken: prepared.confirmationToken },
      { "idempotency-key": "c1" },
    );
    expect(first.status).toBe(200);

    // The single-use token is gone; a replay with a fresh key cannot resend.
    const second = await json(
      "POST",
      `/v1/campaigns/${id}/confirm-send`,
      { confirmationToken: prepared.confirmationToken },
      { "idempotency-key": "c2" },
    );
    expect(second.status).toBe(409);

    // A replay with the same Idempotency-Key returns the stored response.
    const replay = await json(
      "POST",
      `/v1/campaigns/${id}/confirm-send`,
      { confirmationToken: prepared.confirmationToken },
      { "idempotency-key": "c1" },
    );
    expect(replay.status).toBe(200);
  });

  it("requires Idempotency-Key on confirm-send", async () => {
    const id = await createCampaign();
    const res = await json("POST", `/v1/campaigns/${id}/confirm-send`, {
      confirmationToken: "x",
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on invalid lifecycle transitions", async () => {
    const id = await createCampaign();
    const res = await json("POST", `/v1/campaigns/${id}/pause`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ status: 409, title: "Conflict" });
  });
});

describe("send limits", () => {
  it("enforces the API key send limit", async () => {
    const limited = await createTestContext({ scopes: ["read", "write", "send"], sendLimit: 1 });
    try {
      const seeded = await seedRelayAndIdentity(limited);
      const identityEmail = `limit-${seeded.identityId.slice(-12)}@example.com`;
      const list = await limited.app.request("/v1/lists", {
        method: "POST",
        headers: { authorization: `Bearer ${limited.rawKey}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "l" }),
      });
      const lId = ((await list.json()) as { id: string }).id;
      const headers = {
        authorization: `Bearer ${limited.rawKey}`,
        "content-type": "application/json",
      };
      const imp = await limited.app.request("/v1/contacts/import", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "i1" },
        body: JSON.stringify({ listId: lId, contacts: [{ email: "a@x.co" }, { email: "b@x.co" }] }),
      });
      expect(imp.status).toBe(200);
      const camp = await limited.app.request("/v1/campaigns", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "c",
          subject: "s",
          fromEmail: identityEmail,
          fromName: "N",
          bodyHtml: "<p>x</p>",
          bodyText: "x",
          audienceRef: lId,
          relayId: seeded.relayId,
          senderIdentityId: seeded.identityId,
        }),
      });
      const cId = ((await camp.json()) as { id: string }).id;
      const prep = await limited.app.request(`/v1/campaigns/${cId}/prepare`, {
        method: "POST",
        headers,
      });
      const { confirmationToken } = (await prep.json()) as { confirmationToken: string };
      const confirm = await limited.app.request(`/v1/campaigns/${cId}/confirm-send`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": "c1" },
        body: JSON.stringify({ confirmationToken }),
      });
      expect(confirm.status).toBe(403);
    } finally {
      await limited.close();
    }
  });
});
