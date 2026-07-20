import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;

const SAMPLE = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <report_id>abc123</report_id>
    <date_range><begin>1752537600</begin><end>1752624000</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <p>quarantine</p>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.1</source_ip>
      <count>40</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip>
      <count>5</count>
      <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
  </record>
</feedback>`;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

function post(path: string, body: unknown) {
  return ctx.app.request(path, {
    method: "POST",
    headers: { ...auth(ctx), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("DMARC report ingestion", () => {
  it("stores a report idempotently and aggregates stats", async () => {
    const first = await post("/v1/deliverability/dmarc-reports", { xml: SAMPLE });
    expect(first.status).toBe(201);
    const stored = (await first.json()) as { stored: boolean; messages: number };
    expect(stored.stored).toBe(true);
    expect(stored.messages).toBe(45);

    const duplicate = await post("/v1/deliverability/dmarc-reports", { xml: SAMPLE });
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { stored: boolean }).stored).toBe(false);

    const stats = await ctx.app.request("/v1/deliverability/dmarc-reports?domain=example.com", {
      headers: auth(ctx),
    });
    expect(stats.status).toBe(200);
    const body = (await stats.json()) as {
      reports: number;
      messages: number;
      dispositions: Record<string, number>;
      spf: Record<string, number>;
      topSources: { ip: string; count: number }[];
    };
    expect(body.reports).toBe(1);
    expect(body.messages).toBe(45);
    expect(body.dispositions).toEqual({ none: 40, quarantine: 5 });
    expect(body.spf).toEqual({ pass: 40, fail: 5 });
    expect(body.topSources[0]).toEqual({ ip: "192.0.2.1", count: 40 });
  });

  it("rejects invalid XML with problem details", async () => {
    const res = await post("/v1/deliverability/dmarc-reports", { xml: "<p>hello</p>" });
    expect(res.status).toBe(400);
  });
});
