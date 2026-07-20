import { createRoute, z } from "@hono/zod-openapi";
import { checkDeliverability, parseDmarcAggregate } from "@mailpelican/domain";
import { dmarcReports } from "@mailpelican/db";
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Deps, Principal } from "../deps.js";
import { createRouter, jsonOk, jsonCreated, dataSchema, problemResponses } from "./helpers.js";

const checkQuery = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "must be a bare domain"),
  ip: z.string().ip().optional(),
});

const reportInput = z.object({ xml: z.string().min(1).max(5_000_000) });

const reportQuery = z.object({ domain: z.string().min(1).max(253) });

/**
 * Deliverability preflight ("will I inbox?") for a sending domain and,
 * when given, the IP it sends from. Covers what SPF/DKIM/DMARC alone do
 * not: MX, forward-confirmed reverse DNS, and the Spamhaus blocklist.
 */
export function deliverabilityRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/check",
      tags: ["deliverability"],
      request: { query: checkQuery },
      responses: { ...jsonOk(dataSchema, "Deliverability report."), ...problemResponses(400) },
    }),
    async (c) => {
      const { domain, ip } = c.req.valid("query");
      const report = await checkDeliverability({ domain, ip }, deps.resolveDns);
      return c.json(report, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/dmarc-reports",
      tags: ["deliverability"],
      description:
        "Ingest a DMARC aggregate (rua) report as raw XML. Idempotent: a " +
        "replayed report is deduplicated by payload hash.",
      request: { body: { content: { "application/json": { schema: reportInput } } } },
      responses: {
        ...jsonCreated(dataSchema, "Stored report summary."),
        ...jsonOk(dataSchema, "Duplicate report."),
        ...problemResponses(400),
      },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const { xml } = c.req.valid("json");
      const report = parseDmarcAggregate(xml);
      const payloadHash = createHash("sha256").update(xml, "utf8").digest("hex");
      const inserted = await deps.db
        .insert(dmarcReports)
        .values({
          workspaceId: p.workspaceId,
          domain: report.policy.domain,
          orgName: report.orgName,
          reportId: report.reportId,
          dateBegin: report.dateBegin,
          dateEnd: report.dateEnd,
          policy: report.policy,
          records: report.records,
          payloadHash,
        })
        .onConflictDoNothing()
        .returning({ id: dmarcReports.id });
      if (inserted[0] === undefined) {
        return c.json({ stored: false, reason: "duplicate" }, 200);
      }
      return c.json(
        {
          stored: true,
          domain: report.policy.domain,
          orgName: report.orgName,
          records: report.records.length,
          messages: report.records.reduce((sum, record) => sum + record.count, 0),
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/dmarc-reports",
      tags: ["deliverability"],
      description: "Aggregate DMARC authentication stats for one domain.",
      request: { query: reportQuery },
      responses: { ...jsonOk(dataSchema, "DMARC stats."), ...problemResponses(400) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const domain = c.req.valid("query").domain;
      const rows = await deps.db
        .select()
        .from(dmarcReports)
        .where(eq(dmarcReports.workspaceId, p.workspaceId))
        .orderBy(desc(dmarcReports.dateEnd))
        .limit(90);
      const scoped = rows.filter((row) => row.domain === domain);
      const dispositions: Record<string, number> = {};
      const spfResults: Record<string, number> = {};
      const dkimResults: Record<string, number> = {};
      const sources = new Map<string, number>();
      let messages = 0;
      for (const row of scoped) {
        for (const record of row.records) {
          const count = Number(record.count ?? 0);
          messages += count;
          const disposition = String(record.disposition ?? "none");
          const spf = String(record.spf ?? "unknown");
          const dkim = String(record.dkim ?? "unknown");
          dispositions[disposition] = (dispositions[disposition] ?? 0) + count;
          spfResults[spf] = (spfResults[spf] ?? 0) + count;
          dkimResults[dkim] = (dkimResults[dkim] ?? 0) + count;
          const ip = String(record.sourceIp ?? "unknown");
          sources.set(ip, (sources.get(ip) ?? 0) + count);
        }
      }
      return c.json(
        {
          domain,
          reports: scoped.length,
          messages,
          dispositions,
          spf: spfResults,
          dkim: dkimResults,
          topSources: [...sources.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([ip, count]) => ({ ip, count })),
          latestReport: scoped[0]
            ? { orgName: scoped[0].orgName, dateEnd: scoped[0].dateEnd }
            : null,
        },
        200,
      );
    },
  );

  return app;
}
