import { createRoute, z } from "@hono/zod-openapi";
import { appendOutbox, insertInboundWebhookDedup, OUTBOX_TOPICS, relays } from "@dispatch/db";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Deps } from "../deps.js";
import { createRouter, dataSchema, jsonOk, problemResponses } from "./helpers.js";

const relayParam = z.object({ relayId: z.string().uuid() });

/**
 * Provider webhook inbox (architecture §6): verify the signature before
 * parsing, store the raw payload idempotently, enqueue normalization, and
 * return fast. This route is unauthenticated; the signature is the auth.
 */
export function webhookRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "post",
      path: "/provider/{relayId}",
      tags: ["webhooks"],
      request: { params: relayParam },
      responses: {
        ...jsonOk(dataSchema, "Stored webhook receipt."),
        ...problemResponses(401, 404),
      },
    }),
    async (c) => {
      const relayId = c.req.valid("param").relayId;
      const rows = await deps.db.select().from(relays).where(eq(relays.id, relayId)).limit(1);
      const relay = rows[0];
      if (relay === undefined) {
        throw new HTTPException(404, { message: "Relay not found." });
      }
      const body = await c.req.raw.text();
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      const provider = await deps.createProvider(relayId);
      const verified = await provider.verifyWebhook({ headers, body });
      if (!verified.valid) {
        throw new HTTPException(401, {
          message: `Webhook verification failed: ${verified.reason}`,
        });
      }
      const payloadHash = createHash("sha256").update(body, "utf8").digest("hex");
      const stored = await insertInboundWebhookDedup(deps.db, {
        workspaceId: relay.workspaceId,
        relayId,
        headers,
        payload: body,
        payloadHash,
      });
      if (stored.outcome === "inserted" && stored.id !== null) {
        await appendOutbox(deps.db, {
          workspaceId: relay.workspaceId,
          topic: OUTBOX_TOPICS.webhookNormalize,
          payload: { workspaceId: relay.workspaceId, inboxId: stored.id, relayId },
        });
      }
      return c.json(
        { stored: stored.outcome === "inserted", duplicate: stored.outcome === "duplicate" },
        200,
      );
    },
  );

  return app;
}
