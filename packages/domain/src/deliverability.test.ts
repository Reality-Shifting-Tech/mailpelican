import { describe, expect, it } from "vitest";
import { checkDeliverability } from "./deliverability.js";
import type { DnsResolver } from "./dns-verification.js";

const zone: Record<string, string[]> = {
  "example.com::TXT": ["v=spf1 include:_spf.google.com ~all"],
  "_dmarc.example.com::TXT": ["v=DMARC1; p=quarantine"],
  "example.com::MX": ["mail.example.com"],
  "1.2.0.192.in-addr.arpa::PTR": ["mail.example.com"],
  "mail.example.com::A": ["192.0.2.1"],
};

const resolver: DnsResolver = async (name, type) => zone[`${name}::${type}`] ?? [];

describe("checkDeliverability", () => {
  it("passes a fully configured domain and IP", async () => {
    const report = await checkDeliverability({ domain: "example.com", ip: "192.0.2.1" }, resolver);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(["spf", "dmarc", "mx", "ptr", "blocklist"]);
  });

  it("fails closed on missing records and reports each one", async () => {
    const report = await checkDeliverability({ domain: "nope.example", ip: "192.0.2.9" }, resolver);
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "spf",
      "dmarc",
      "mx",
      "ptr",
    ]);
  });

  it("detects FCrDNS mismatch and blocklist hits", async () => {
    const poisoned: DnsResolver = async (name, type) => {
      if (name === "9.2.0.192.in-addr.arpa" && type === "PTR") return ["other.example"];
      if (name === "other.example" && type === "A") return ["198.51.100.7"];
      if (name.endsWith(".zen.spamhaus.org")) return ["127.0.0.4"];
      return zone[`${name}::${type}`] ?? [];
    };
    const report = await checkDeliverability({ domain: "example.com", ip: "192.0.2.9" }, poisoned);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.ok]));
    expect(byName.ptr).toBe(false);
    expect(byName.blocklist).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("skips IP checks when no IP is given", async () => {
    const report = await checkDeliverability({ domain: "example.com" }, resolver);
    expect(report.checks.map((c) => c.name)).toEqual(["spf", "dmarc", "mx"]);
    expect(report.ok).toBe(true);
  });
});
