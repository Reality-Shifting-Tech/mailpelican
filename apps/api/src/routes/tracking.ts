import { createRoute, z } from "@hono/zod-openapi";
import { insertEventDedup, messages } from "@dispatch/db";
import { TRACKING_PIXEL_GIF } from "@dispatch/domain";
import { PROBLEM_CONTENT_TYPE, problem } from "@dispatch/contracts";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Deps } from "../deps.js";
import { createRouter, problemResponses } from "./helpers.js";

const messageParam = z.object({ messageId: z.string().uuid() });

/**
 * Public, unauthenticated open/click tracking targets. Responses never leak
 * whether the message id exists: the pixel is always served and clicks always
 * redirect; events are recorded only for known messages. Recording is best
 * effort — a mail-scanner prefetch must not break rendering or navigation.
 */
export function trackingRoutes(deps: Deps) {
  const app = createRouter();

  async function record(
    messageId: string,
    type: "opened" | "clicked",
    meta: Record<string, unknown>,
  ) {
    const rows = await deps.db
      .select({
        id: messages.id,
        workspaceId: messages.workspaceId,
        relayId: messages.relayId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    const message = rows[0];
    if (message === undefined) {
      return;
    }
    await insertEventDedup(deps.db, {
      workspaceId: message.workspaceId,
      messageId: message.id,
      relayId: message.relayId,
      providerEventId: null,
      payloadHash: `track:${type}:${message.id}:${randomUUID()}`,
      type,
      meta,
      occurredAt: new Date(),
    });
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/open/{messageId}",
      tags: ["tracking"],
      description: "Open-tracking pixel target injected into sent HTML.",
      request: { params: messageParam },
      responses: {
        200: {
          content: { "image/gif": { schema: z.string() } },
          description: "1x1 transparent GIF.",
        },
        ...problemResponses(400),
      },
    }),
    async (c) => {
      await record(c.req.valid("param").messageId, "opened", {
        userAgent: c.req.header("user-agent") ?? null,
      });
      return c.body(new Uint8Array(TRACKING_PIXEL_GIF), 200, {
        "content-type": "image/gif",
        "cache-control": "no-store, max-age=0",
      });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/click/{messageId}",
      tags: ["tracking"],
      description: "Click-tracking redirect target wrapped around sent links.",
      request: { params: messageParam, query: z.object({ url: z.string().min(1) }) },
      responses: {
        302: { description: "Redirect to the original destination." },
        ...problemResponses(400),
      },
    }),
    async (c) => {
      const { url } = c.req.valid("query");
      let destination: URL | null = null;
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          destination = parsed;
        }
      } catch {
        destination = null;
      }
      if (destination === null) {
        return c.json(
          problem({ status: 400, detail: "Only http(s) destinations are allowed." }),
          400,
          {
            "content-type": PROBLEM_CONTENT_TYPE,
          },
        );
      }
      await record(c.req.valid("param").messageId, "clicked", {
        url: destination.toString(),
        userAgent: c.req.header("user-agent") ?? null,
      });
      return c.redirect(destination.toString(), 302);
    },
  );

  return app;
}
