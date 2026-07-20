import { describe, expect, it } from "vitest";
import { checkDnsRecords, type DnsResolver } from "./dns-verification.js";

const zone: Record<string, string[]> = {
  "example.com": ["v=spf1 include:_spf.google.com ~all"],
  "_dmarc.example.com": ["v=DMARC1; p=quarantine"],
  "dispatch._domainkey.example.com": ["dkim.example.net."],
};

const resolver: DnsResolver = async (name) => zone[name] ?? [];

const records = [
  { type: "TXT", name: "example.com", value: "v=spf1 include:example.com ~all" },
  { type: "CNAME", name: "dispatch._domainkey.example.com", value: "dkim.example.net" },
  { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=quarantine" },
];

describe("checkDnsRecords", () => {
  it("passes when every record resolves, tolerating dots and SPF merges", async () => {
    const result = await checkDnsRecords(records, resolver);
    expect(result.ok).toBe(true);
    expect(result.results.every((r) => r.found)).toBe(true);
  });

  it("fails closed when a record is missing", async () => {
    const result = await checkDnsRecords(records, async () => []);
    expect(result.ok).toBe(false);
    expect(result.results.filter((r) => !r.found)).toHaveLength(3);
  });

  it("skips provider-pending placeholder values", async () => {
    const result = await checkDnsRecords(
      [{ type: "CNAME", name: "dispatch._domainkey.example.com", value: "dkim.pending" }],
      async () => [],
    );
    expect(result.ok).toBe(true);
  });

  it("treats resolver errors as not found", async () => {
    const result = await checkDnsRecords([records[0]!], async () => {
      throw new Error("ENOTFOUND");
    });
    expect(result.ok).toBe(false);
  });
});
