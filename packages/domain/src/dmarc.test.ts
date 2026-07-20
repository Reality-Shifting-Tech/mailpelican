import { describe, expect, it } from "vitest";
import { parseDmarcAggregate } from "./dmarc.js";

const SAMPLE = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>1234567890</report_id>
    <date_range><begin>1752537600</begin><end>1752624000</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>quarantine</p>
    <sp>none</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.1</source_ip>
      <count>42</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>quarantine</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
  </record>
</feedback>`;

describe("parseDmarcAggregate", () => {
  it("parses a Google aggregate report", () => {
    const report = parseDmarcAggregate(SAMPLE);
    expect(report.orgName).toBe("google.com");
    expect(report.policy.domain).toBe("example.com");
    expect(report.policy.p).toBe("quarantine");
    expect(report.dateBegin.toISOString()).toBe("2025-07-15T00:00:00.000Z");
    expect(report.records).toHaveLength(2);
    expect(report.records[0]).toMatchObject({
      sourceIp: "192.0.2.1",
      count: 42,
      disposition: "none",
      dkim: "pass",
      spf: "pass",
    });
  });

  it("rejects non-DMARC XML and empty records", () => {
    expect(() => parseDmarcAggregate("<html><body>nope</body></html>")).toThrow("DMARC");
    expect(() =>
      parseDmarcAggregate(
        `<feedback><report_metadata><org_name>x</org_name><date_range><begin>1</begin><end>2</end></date_range></report_metadata><policy_published><domain>x.com</domain></policy_published></feedback>`,
      ),
    ).toThrow("no records");
    expect(() => parseDmarcAggregate("not xml at all {{{")).toThrow();
  });
});
