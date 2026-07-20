import { senderIdentities } from "@dispatch/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

function json(method: string, path: string, body?: unknown) {
  return ctx.app.request(path, {
    method,
    headers: { ...auth(ctx), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function createIdentity(fromEmail: string) {
  const res = await json("POST", "/v1/sender-identities", {
    domain: "example.com",
    fromEmail,
    fromName: "News",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("sender identity DNS verification", () => {
  it("verifies when the expected records resolve", async () => {
    const id = await createIdentity("news@example.com");
    const res = await json("POST", `/v1/sender-identities/${id}/verify`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verificationStatus: string; dns: { found: boolean }[] };
    expect(body.verificationStatus).toBe("verified");
    expect(body.dns.every((r) => r.found)).toBe(true);
  });

  it("fails closed with 422 and per-record detail when DNS is missing", async () => {
    const id = await createIdentity("missing@example.com");
    const original = ctx.deps.resolveDns;
    ctx.deps.resolveDns = async () => [];
    try {
      const res = await json("POST", `/v1/sender-identities/${id}/verify`);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("TXT example.com");
      expect(body.detail).toContain("_dmarc.example.com");
    } finally {
      ctx.deps.resolveDns = original;
    }
    const rows = await ctx.db
      .select({ status: senderIdentities.verificationStatus })
      .from(senderIdentities)
      .where(eq(senderIdentities.id, id));
    expect(rows[0]?.status).toBe("failed");
  });
});
