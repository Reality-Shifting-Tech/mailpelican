import { createRoute, z } from "@hono/zod-openapi";
import { consentEvents, contacts, listMemberships, lists } from "@dispatch/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Deps } from "../deps.js";
import {
  confirmSubscription,
  describeConfirmation,
  requestSubscription,
} from "../services/opt-in.js";
import { resolveUnsubscribeToken } from "../services/send-flow.js";
import {
  createRouter,
  customFieldsSchema,
  dataSchema,
  emailSchema,
  jsonOk,
  problemResponses,
} from "./helpers.js";

const tokenParam = z.object({ token: z.string().min(1) });

const subscribeInput = z.object({
  listId: z.string().uuid(),
  email: emailSchema,
  customFields: customFieldsSchema.optional(),
});

/** Request-attribution helpers for the consent trail (GDPR-grade records). */
function attribution(c: { req: { header: (name: string) => string | undefined } }) {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    userAgent: c.req.header("user-agent") ?? null,
    ipHash:
      forwarded !== undefined && forwarded.length > 0
        ? createHash("sha256").update(forwarded, "utf8").digest("hex")
        : null,
  };
}

async function describeToken(deps: Deps, rawToken: string) {
  const token = await resolveUnsubscribeToken(deps.db, rawToken);
  const contactRows = await deps.db
    .select({ email: contacts.emailNormalized })
    .from(contacts)
    .where(eq(contacts.id, token.contactId))
    .limit(1);
  const listRows =
    token.listId !== null
      ? await deps.db
          .select({ name: lists.name })
          .from(lists)
          .where(eq(lists.id, token.listId))
          .limit(1)
      : [];
  const membershipRows =
    token.listId !== null
      ? await deps.db
          .select({ state: listMemberships.state })
          .from(listMemberships)
          .where(
            and(
              eq(listMemberships.contactId, token.contactId),
              eq(listMemberships.listId, token.listId),
            ),
          )
          .limit(1)
      : [];
  const email = contactRows[0]?.email ?? "";
  const [local, domain] = email.split("@");
  return {
    token,
    emailMasked: `${local?.slice(0, 2) ?? ""}***@${domain ?? ""}`,
    listName: listRows[0]?.name ?? null,
    state: membershipRows[0]?.state ?? "unsubscribed",
  };
}

/**
 * Apply an unsubscribe idempotently: membership flips to unsubscribed and a
 * consent event is appended only on the state change.
 */
async function applyUnsubscribe(deps: Deps, rawToken: string) {
  const info = await describeToken(deps, rawToken);
  const { token } = info;
  if (token.listId !== null && info.state !== "unsubscribed") {
    await deps.db
      .insert(listMemberships)
      .values({
        workspaceId: token.workspaceId,
        contactId: token.contactId,
        listId: token.listId,
        state: "unsubscribed",
      })
      .onConflictDoUpdate({
        target: [listMemberships.contactId, listMemberships.listId],
        set: { state: "unsubscribed", updatedAt: new Date() },
      });
    await deps.db.insert(consentEvents).values({
      workspaceId: token.workspaceId,
      contactId: token.contactId,
      listId: token.listId,
      type: "unsubscribed",
      source: "unsubscribe_link",
    });
  }
  return info;
}

/** Public (unauthenticated) unsubscribe endpoints, including RFC 8058. */
export function publicRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/unsubscribe/{token}",
      tags: ["public"],
      request: { params: tokenParam },
      responses: {
        ...jsonOk(dataSchema, "Unsubscribe target description."),
        ...problemResponses(404),
      },
    }),
    async (c) => {
      const info = await describeToken(deps, c.req.valid("param").token);
      return c.json({ email: info.emailMasked, list: info.listName, state: info.state }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/unsubscribe/{token}",
      tags: ["public"],
      request: { params: tokenParam },
      responses: { ...jsonOk(dataSchema, "Unsubscribed."), ...problemResponses(404) },
    }),
    async (c) => {
      const info = await applyUnsubscribe(deps, c.req.valid("param").token);
      return c.json({ email: info.emailMasked, list: info.listName, state: "unsubscribed" }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/one-click-unsubscribe/{token}",
      tags: ["public"],
      description: "RFC 8058 one-click unsubscribe target of the List-Unsubscribe-Post header.",
      request: { params: tokenParam },
      responses: { ...jsonOk(dataSchema, "Unsubscribed."), ...problemResponses(404) },
    }),
    async (c) => {
      const info = await applyUnsubscribe(deps, c.req.valid("param").token);
      return c.json({ email: info.emailMasked, list: info.listName, state: "unsubscribed" }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/subscribe",
      tags: ["public"],
      description:
        "Double opt-in entry point: parks the membership as pending and sends a " +
        "confirmation email. The answer is identical for suppressed addresses.",
      request: { body: { content: { "application/json": { schema: subscribeInput } } } },
      responses: {
        ...jsonOk(dataSchema, "Subscription requested."),
        ...problemResponses(400, 404),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const result = await requestSubscription(deps.db, { ...input, ...attribution(c) });
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/confirm/{token}",
      tags: ["public"],
      description: "Describe a double-opt-in confirmation link before it is consumed.",
      request: { params: tokenParam },
      responses: {
        ...jsonOk(dataSchema, "Confirmation target description."),
        ...problemResponses(404, 410),
      },
    }),
    async (c) => {
      const info = await describeConfirmation(deps.db, c.req.valid("param").token);
      return c.json({ email: info.emailMasked, list: info.listName, state: "pending" }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/confirm/{token}",
      tags: ["public"],
      description: "Consume a single-use confirmation token and activate the subscription.",
      request: { params: tokenParam },
      responses: {
        ...jsonOk(dataSchema, "Subscription confirmed."),
        ...problemResponses(404, 410),
      },
    }),
    async (c) => {
      const info = await confirmSubscription(deps.db, c.req.valid("param").token, attribution(c));
      return c.json({ email: info.emailMasked, list: info.listName, state: "subscribed" }, 200);
    },
  );

  return app;
}
