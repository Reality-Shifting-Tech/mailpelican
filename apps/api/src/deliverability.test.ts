import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DnsResolver } from "@mailpelican/domain";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

function withResolver(resolver: DnsResolver, run: () => Promise<void>) {
  const original = ctx.deps.resolveDns;
  ctx.deps.resolveDns = resolver;
  return run().finally(() => {
    ctx.deps.resolveDns = original;
  });
}

describe("deliverability check", () => {
  it("passes a fully configured domain and IP", async () => {
    const zone: Record<string, string[]> = {
      "example.com::TXT": ["v=spf1 include:_spf.google.com ~all"],
      "_dmarc.example.com::TXT": ["v=DMARC1; p=quarantine"],
      "example.com::MX": ["mail.example.com"],
      "1.2.0.192.in-addr.arpa::PTR": ["mail.example.com"],
      "mail.example.com::A": ["192.0.2.1"],
    };
    await withResolver(
      async (name, type) => zone[`${name}::${type}`] ?? [],
      async () => {
        const res = await ctx.app.request(
          "/v1/deliverability/check?domain=example.com&ip=192.0.2.1",
          { headers: auth(ctx) },
        );
        expect(res.status).toBe(200);
        const report = (await res.json()) as { ok: boolean; checks: { name: string }[] };
        expect(report.ok).toBe(true);
        expect(report.checks.map((c) => c.name)).toEqual([
          "spf",
          "dmarc",
          "mx",
          "ptr",
          "blocklist",
        ]);
      },
    );
  });

  it("reports blocklist hits as failures", async () => {
    await withResolver(
      async (name, type) => {
        if (name.endsWith(".zen.spamhaus.org")) return ["127.0.0.4"];
        if (type === "TXT" && name.startsWith("_dmarc.")) return ["v=DMARC1; p=quarantine"];
        if (type === "TXT") return ["v=spf1 ~all"];
        if (type === "MX") return ["mail.example.com"];
        return [];
      },
      async () => {
        const res = await ctx.app.request(
          "/v1/deliverability/check?domain=example.com&ip=192.0.2.9",
          { headers: auth(ctx) },
        );
        const report = (await res.json()) as {
          ok: boolean;
          checks: { name: string; ok: boolean; detail: string }[];
        };
        expect(report.ok).toBe(false);
        const blocklist = report.checks.find((c) => c.name === "blocklist");
        expect(blocklist?.ok).toBe(false);
        expect(blocklist?.detail).toContain("LISTED");
      },
    );
  });

  it("rejects malformed input with 400 and requires auth", async () => {
    const bad = await ctx.app.request("/v1/deliverability/check?domain=not a domain", {
      headers: auth(ctx),
    });
    expect(bad.status).toBe(400);
    const anon = await ctx.app.request("/v1/deliverability/check?domain=example.com");
    expect(anon.status).toBe(401);
  });
});
