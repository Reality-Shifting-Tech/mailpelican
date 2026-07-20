import { createRoute, z } from "@hono/zod-openapi";
import { consentEvents, listMemberships, lists } from "@dispatch/db";
import { and, asc, eq, gt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Deps, Principal } from "../deps.js";
import { audit, parsePagination, toCursorPage } from "../http.js";
import {
  createRouter,
  dataPageSchema,
  dataSchema,
  idParamSchema,
  jsonCreated,
  jsonOk,
  paginationQuerySchema,
  problemResponses,
} from "./helpers.js";

const listInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

const membershipInput = z.object({
  contactId: z.string().uuid(),
  state: z.enum(["pending", "subscribed", "unsubscribed"]),
});

/** List CRUD. */
export function listRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["lists"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of lists."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(lists)
        .where(
          and(eq(lists.workspaceId, workspaceId), ...(after !== null ? [gt(lists.id, after)] : [])),
        )
        .orderBy(asc(lists.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["lists"],
      request: { body: { content: { "application/json": { schema: listInput } } } },
      responses: { ...jsonCreated(dataSchema, "Created list."), ...problemResponses(409) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const inserted = await deps.db
        .insert(lists)
        .values({
          workspaceId: p.workspaceId,
          name: input.name,
          description: input.description ?? "",
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0] === undefined) {
        throw new HTTPException(409, { message: "A list with this name already exists." });
      }
      await audit(deps.db, p, "list.create", "list", inserted[0].id);
      return c.json(inserted[0], 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["lists"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Deleted list."), ...problemResponses(404) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const rows = await deps.db
        .delete(lists)
        .where(and(eq(lists.id, c.req.valid("param").id), eq(lists.workspaceId, p.workspaceId)))
        .returning({ id: lists.id });
      if (rows[0] === undefined) {
        throw new HTTPException(404, { message: "List not found." });
      }
      await audit(deps.db, p, "list.delete", "list", rows[0].id);
      return c.json({ id: rows[0].id, deleted: true }, 200);
    },
  );

  return app;
}

/** Per-list membership state management. */
export function membershipRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["memberships"],
      request: {
        query: paginationQuerySchema.extend({ listId: z.string().uuid().optional() }),
      },
      responses: { ...jsonOk(dataPageSchema, "Page of memberships."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const listId = c.req.valid("query").listId;
      const rows = await deps.db
        .select()
        .from(listMemberships)
        .where(
          and(
            eq(listMemberships.workspaceId, workspaceId),
            ...(listId !== undefined ? [eq(listMemberships.listId, listId)] : []),
            ...(after !== null ? [gt(listMemberships.id, after)] : []),
          ),
        )
        .orderBy(asc(listMemberships.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/",
      tags: ["memberships"],
      request: {
        body: {
          content: {
            "application/json": {
              schema: membershipInput.extend({ listId: z.string().uuid() }),
            },
          },
        },
      },
      responses: { ...jsonOk(dataSchema, "Upserted membership."), ...problemResponses(400) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const rows = await deps.db
        .insert(listMemberships)
        .values({
          workspaceId: p.workspaceId,
          contactId: input.contactId,
          listId: input.listId,
          state: input.state,
        })
        .onConflictDoUpdate({
          target: [listMemberships.contactId, listMemberships.listId],
          set: { state: input.state, updatedAt: new Date() },
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new HTTPException(400, { message: "Membership upsert failed." });
      }
      await deps.db.insert(consentEvents).values({
        workspaceId: p.workspaceId,
        contactId: input.contactId,
        listId: input.listId,
        type: input.state === "unsubscribed" ? "unsubscribed" : "subscribed",
        source: "api",
      });
      await audit(deps.db, p, "membership.upsert", "list_membership", row.id, {
        state: input.state,
      });
      return c.json(row, 200);
    },
  );

  return app;
}
