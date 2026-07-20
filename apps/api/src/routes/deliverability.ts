import { createRoute, z } from "@hono/zod-openapi";
import { checkDeliverability } from "@mailpelican/domain";
import type { Deps } from "../deps.js";
import { createRouter, jsonOk, dataSchema, problemResponses } from "./helpers.js";

const checkQuery = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "must be a bare domain"),
  ip: z.string().ip().optional(),
});

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

  return app;
}
