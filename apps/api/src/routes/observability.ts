import { createRoute, z } from "@hono/zod-openapi";
import {
  auditEvents,
  campaignRecipients,
  events,
  inboundWebhookEvents,
  messages,
  replayInboundWebhook,
  appendOutbox,
  OUTBOX_TOPICS,
} from "@dispatch/db";
import { DomainError } from "@dispatch/domain";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Deps, Principal } from "../deps.js";
import { parsePagination, toCursorPage } from "../http.js";
import {
  createRouter,
  dataPageSchema,
  dataSchema,
  idParamSchema,
  jsonOk,
  paginationQuerySchema,
  problemResponses,
} from "./helpers.js";

/** Normalized provider events, campaign stats, audit trail, webhook admin. */
export function observabilityRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/events",
      tags: ["events"],
      request: {
        query: paginationQuerySchema.extend({
          messageId: z.string().uuid().optional(),
          campaignId: z.string().uuid().optional(),
        }),
      },
      responses: { ...jsonOk(dataPageSchema, "Page of events."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const query = c.req.valid("query");
      const rows = await deps.db
        .select({
          event: events,
          campaignId: messages.campaignId,
        })
        .from(events)
        .leftJoin(messages, eq(events.messageId, messages.id))
        .where(
          and(
            eq(events.workspaceId, workspaceId),
            ...(query.messageId !== undefined ? [eq(events.messageId, query.messageId)] : []),
            ...(query.campaignId !== undefined ? [eq(messages.campaignId, query.campaignId)] : []),
            ...(after !== null ? [gt(events.id, after)] : []),
          ),
        )
        .orderBy(asc(events.id))
        .limit(limit + 1);
      const page = toCursorPage(
        rows.map((r) => ({ ...r.event, campaignId: r.campaignId })),
        limit,
      );
      return c.json(page, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/stats/campaigns/{id}",
      tags: ["stats"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Campaign totals."), ...problemResponses(404) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const campaignId = c.req.valid("param").id;
      const messageCounts = await deps.db
        .select({ status: messages.status, count: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(eq(messages.workspaceId, workspaceId), eq(messages.campaignId, campaignId)))
        .groupBy(messages.status);
      if (messageCounts.length === 0) {
        const recipientProbe = await deps.db
          .select({ count: sql<number>`count(*)::int` })
          .from(campaignRecipients)
          .where(eq(campaignRecipients.campaignId, campaignId));
        if ((recipientProbe[0]?.count ?? 0) === 0) {
          throw new HTTPException(404, { message: "Campaign not found." });
        }
      }
      const recipientCounts = await deps.db
        .select({ status: campaignRecipients.status, count: sql<number>`count(*)::int` })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, campaignId))
        .groupBy(campaignRecipients.status);
      const eventCounts = await deps.db
        .select({ type: events.type, count: sql<number>`count(*)::int` })
        .from(events)
        .innerJoin(messages, eq(events.messageId, messages.id))
        .where(and(eq(events.workspaceId, workspaceId), eq(messages.campaignId, campaignId)))
        .groupBy(events.type);
      const engagement = await deps.db
        .select({
          type: events.type,
          uniques: sql<number>`count(distinct ${events.messageId})::int`,
        })
        .from(events)
        .innerJoin(messages, eq(events.messageId, messages.id))
        .where(
          and(
            eq(events.workspaceId, workspaceId),
            eq(messages.campaignId, campaignId),
            inArray(events.type, ["opened", "clicked"]),
          ),
        )
        .groupBy(events.type);
      const uniqueByType = Object.fromEntries(engagement.map((r) => [r.type, r.uniques]));
      const byStatus = Object.fromEntries(messageCounts.map((r) => [r.status, r.count]));
      const byType = Object.fromEntries(eventCounts.map((r) => [r.type, r.count]));
      return c.json(
        {
          campaignId,
          messages: byStatus,
          recipients: Object.fromEntries(recipientCounts.map((r) => [r.status, r.count])),
          events: byType,
          totals: {
            sent:
              (byStatus.accepted ?? 0) +
              (byStatus.delivered ?? 0) +
              (byStatus.bounced ?? 0) +
              (byStatus.complained ?? 0),
            delivered: byStatus.delivered ?? 0,
            bounced: byStatus.bounced ?? 0,
            complained: byStatus.complained ?? 0,
            failed: byStatus.failed ?? 0,
            uniqueOpens: uniqueByType.opened ?? 0,
            uniqueClicks: uniqueByType.clicked ?? 0,
          },
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/audit-events",
      tags: ["audit"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of audit events."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            ...(after !== null ? [gt(auditEvents.id, after)] : []),
          ),
        )
        .orderBy(asc(auditEvents.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/webhook-deliveries/{id}/replay",
      tags: ["webhooks"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Replay scheduled."), ...problemResponses(404) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const replay = await replayInboundWebhook(deps.db, c.req.valid("param").id);
      if (replay === null || replay.workspaceId !== workspaceId) {
        throw new DomainError("not_found", "Webhook delivery not found.", 404);
      }
      await appendOutbox(deps.db, {
        workspaceId,
        topic: OUTBOX_TOPICS.webhookNormalize,
        payload: { workspaceId, inboxId: replay.id, relayId: replay.relayId },
      });
      return c.json({ id: replay.id, replayOf: replay.replayOf }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/webhook-deliveries",
      tags: ["webhooks"],
      request: {
        query: paginationQuerySchema.extend({
          status: z.enum(["received", "processed", "failed", "dead"]).optional(),
        }),
      },
      responses: {
        ...jsonOk(dataPageSchema, "Page of webhook deliveries."),
        ...problemResponses(400),
      },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const status = c.req.valid("query").status;
      const rows = await deps.db
        .select()
        .from(inboundWebhookEvents)
        .where(
          and(
            eq(inboundWebhookEvents.workspaceId, workspaceId),
            ...(status !== undefined ? [eq(inboundWebhookEvents.status, status)] : []),
            ...(after !== null ? [gt(inboundWebhookEvents.id, after)] : []),
          ),
        )
        .orderBy(asc(inboundWebhookEvents.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  return app;
}
