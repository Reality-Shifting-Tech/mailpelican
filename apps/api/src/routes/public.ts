import { createRoute, z } from "@hono/zod-openapi";
import {
  consentEvents,
  contacts,
  listMemberships,
  lists,
} from "@dispatch/db";
import { and, eq } from "drizzle-orm";
import type { Deps } from "../deps.js";
import { resolveUnsubscribeToken } from "../services/send-flow.js";
import { createRouter, dataSchema, jsonOk, problemResponses } from "./helpers.js";

const tokenParam = z.object({ token: z.string().min(1) });

async function describeToken(deps: Deps, rawToken: string) {
  const token = await resolveUnsubscribeToken(deps.db, rawToken);
  const contactRows = await deps.db
    .select({ email: contacts.emailNormalized })
    .from(contacts)
    .where(eq(contacts.id, token.contactId))
    .limit(1);
  const listRows =
    token.listId !== null
      ? await deps.db.select({ name: lists.name }).from(lists).where(eq(lists.id, token.listId)).limit(1)
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
      return c.json(
        { email: info.emailMasked, list: info.listName, state: info.state },
        200,
      );
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
      description:
        "RFC 8058 one-click unsubscribe target of the List-Unsubscribe-Post header.",
      request: { params: tokenParam },
      responses: { ...jsonOk(dataSchema, "Unsubscribed."), ...problemResponses(404) },
    }),
    async (c) => {
      const info = await applyUnsubscribe(deps, c.req.valid("param").token);
      return c.json({ email: info.emailMasked, list: info.listName, state: "unsubscribed" }, 200);
    },
  );

  return app;
}
