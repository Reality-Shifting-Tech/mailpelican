import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe("app shell", () => {
  it("answers liveness without touching dependencies", async () => {
    const res = await ctx.app.request("/health/live");
    expect(res.status).toBe(200);
  });

  it("returns request ids on responses", async () => {
    const res = await ctx.app.request("/health/live");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("answers unknown routes with a problem-details 404", async () => {
    const res = await ctx.app.request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 404, title: "Not Found" });
  });

  it("exposes the OpenAPI document", async () => {
    const res = await ctx.app.request("/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/contacts"]).toBeDefined();
    expect(doc.paths["/campaigns/{id}/confirm-send"]).toBeDefined();
  });
});

describe("auth", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await ctx.app.request("/v1/contacts");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ status: 401 });
  });

  it("rejects malformed keys", async () => {
    const res = await ctx.app.request("/v1/contacts", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong secrets", async () => {
    const [prefix] = ctx.rawKey.split(".");
    const res = await ctx.app.request("/v1/contacts", {
      headers: { authorization: `Bearer ${prefix}.wrongsecretwrongsecret` },
    });
    expect(res.status).toBe(401);
  });

  it("enforces scopes", async () => {
    const readOnly = await createTestContext({ scopes: ["read"] });
    try {
      const res = await readOnly.app.request("/v1/contacts", {
        method: "POST",
        headers: { ...auth(readOnly), "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.co" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ status: 403, title: "Forbidden" });
    } finally {
      await readOnly.close();
    }
  });

  it("rejects validation errors with problem details", async () => {
    const res = await ctx.app.request("/v1/contacts", {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { status: number; title: string; detail?: string };
    expect(body).toMatchObject({ status: 400, title: "Bad Request" });
    expect(body.detail).toContain("email");
  });
});
