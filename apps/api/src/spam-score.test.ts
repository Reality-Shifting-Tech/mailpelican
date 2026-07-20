import { listMemberships, lists, uuidv7 } from "@mailpelican/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, seedContact, type TestContext } from "./test-utils.js";

let ctx: TestContext;
let rspamd: Server;
let capturedBody = "";

beforeAll(async () => {
  ctx = await createTestContext();
  rspamd = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      capturedBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          score: 3.2,
          action: "no action",
          symbols: {
            BAYES_60: { score: 1.1, description: "probable ham" },
            MISSING_MID: { score: 2.5, description: "Message id is missing" },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => rspamd.listen(0, "127.0.0.1", resolve));
  const { port } = rspamd.address() as AddressInfo;
  ctx.deps.env = { ...ctx.deps.env, RSPAMD_URL: `http://127.0.0.1:${port}` };

  const listId = uuidv7();
  await ctx.db.insert(lists).values({ id: listId, workspaceId: ctx.workspaceId, name: "news" });
  const contactId = await seedContact(ctx, "ada@example.com");
  await ctx.db
    .insert(listMemberships)
    .values({ workspaceId: ctx.workspaceId, contactId, listId, state: "subscribed" });
  const res = await ctx.app.request("/v1/campaigns", {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify({
      name: "c",
      subject: "Hello",
      fromEmail: "news@example.com",
      fromName: "News",
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
      audienceRef: listId,
    }),
  });
  expect(res.status).toBe(201);
});

afterAll(async () => {
  rspamd.close();
  await ctx.close();
});

describe("rspamd preview scoring", () => {
  it("scores the sample render and returns matched symbols", async () => {
    const campaigns = (await (
      await ctx.app.request("/v1/campaigns", { headers: auth(ctx) })
    ).json()) as { data: { id: string }[] };
    const campaignId = campaigns.data[0]?.id ?? "";
    const res = await ctx.app.request(`/v1/campaigns/${campaignId}/preview`, {
      method: "POST",
      headers: auth(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      spam: { score: number; action: string; symbols: { name: string; score: number }[] };
    };
    expect(body.spam.score).toBe(3.2);
    expect(body.spam.action).toBe("no action");
    expect(body.spam.symbols[0]?.name).toBe("MISSING_MID");

    // rspamd received a plausible MIME document.
    expect(capturedBody).toContain("From: news@example.com");
    expect(capturedBody).toContain("To: ada@example.com");
    expect(capturedBody).toContain("Subject: Hello");
  });

  it("returns null spam when rspamd is unreachable", async () => {
    const original = ctx.deps.env;
    ctx.deps.env = { ...ctx.deps.env, RSPAMD_URL: "http://127.0.0.1:1" };
    try {
      const campaigns = (await (
        await ctx.app.request("/v1/campaigns", { headers: auth(ctx) })
      ).json()) as { data: { id: string }[] };
      const res = await ctx.app.request(`/v1/campaigns/${campaigns.data[0]?.id}/preview`, {
        method: "POST",
        headers: auth(ctx),
      });
      expect(((await res.json()) as { spam: unknown }).spam).toBeNull();
    } finally {
      ctx.deps.env = original;
    }
  });
});
