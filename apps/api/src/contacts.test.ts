import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;
let listId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const res = await ctx.app.request("/v1/lists", {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify({ name: "news" }),
  });
  listId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await ctx.close();
});

describe("contacts", () => {
  it("creates, reads, updates, and deletes a contact", async () => {
    const create = await ctx.app.request("/v1/contacts", {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json" },
      body: JSON.stringify({ email: "Alice@Example.com", customFields: { first_name: "Alice" } }),
    });
    expect(create.status).toBe(201);
    const contact = (await create.json()) as { id: string; emailNormalized: string };
    expect(contact.emailNormalized).toBe("alice@example.com");

    const duplicate = await ctx.app.request("/v1/contacts", {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(duplicate.status).toBe(409);

    const patch = await ctx.app.request(`/v1/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { ...auth(ctx), "content-type": "application/json" },
      body: JSON.stringify({ customFields: { first_name: "Alicia" } }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { customFields: { first_name: string } }).customFields.first_name).toBe("Alicia");

    const del = await ctx.app.request(`/v1/contacts/${contact.id}`, {
      method: "DELETE",
      headers: auth(ctx),
    });
    expect(del.status).toBe(200);
  });

  it("paginates with cursors", async () => {
    for (const email of ["p1@example.com", "p2@example.com", "p3@example.com"]) {
      await ctx.app.request("/v1/contacts", {
        method: "POST",
        headers: { ...auth(ctx), "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    }
    const page1 = await ctx.app.request("/v1/contacts?limit=2", { headers: auth(ctx) });
    const body1 = (await page1.json()) as {
      data: unknown[];
      pageInfo: { nextCursor: string | null; hasNextPage: boolean };
    };
    expect(body1.data).toHaveLength(2);
    expect(body1.pageInfo.hasNextPage).toBe(true);
    const page2 = await ctx.app.request(
      `/v1/contacts?limit=2&cursor=${body1.pageInfo.nextCursor}`,
      { headers: auth(ctx) },
    );
    const body2 = (await page2.json()) as { data: unknown[] };
    expect(body2.data.length).toBeGreaterThanOrEqual(1);
  });

  it("imports contacts with consent events and memberships", async () => {
    const res = await ctx.app.request("/v1/contacts/import", {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json", "idempotency-key": "imp-1" },
      body: JSON.stringify({
        listId,
        source: "csv-upload",
        contacts: [
          { email: "imp1@example.com" },
          { email: "imp2@example.com" },
          { email: "not-an-email" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: number;
      rejected: { email: string }[];
    };
    expect(body.created).toBe(2);
    expect(body.rejected).toHaveLength(1);

    const memberships = await ctx.app.request(`/v1/memberships?listId=${listId}`, {
      headers: auth(ctx),
    });
    const members = (await memberships.json()) as { data: { state: string }[] };
    expect(members.data.every((m) => m.state === "subscribed")).toBe(true);
  });

  it("replays imports under the same Idempotency-Key without duplicating", async () => {
    const payload = JSON.stringify({ listId, contacts: [{ email: "imp3@example.com" }] });
    const first = await ctx.app.request("/v1/contacts/import", {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json", "idempotency-key": "imp-2" },
      body: payload,
    });
    expect(first.status).toBe(200);
    const replay = await ctx.app.request("/v1/contacts/import", {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json", "idempotency-key": "imp-2" },
      body: payload,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const replayBody = (await replay.json()) as { created: number; existing: number };
    // Stored response from the first execution, not a re-run.
    expect(replayBody.created).toBe(1);
  });

  it("requires Idempotency-Key on import", async () => {
    const res = await ctx.app.request("/v1/contacts/import", {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/json" },
      body: JSON.stringify({ contacts: [{ email: "x@example.com" }] }),
    });
    expect(res.status).toBe(400);
  });
});
