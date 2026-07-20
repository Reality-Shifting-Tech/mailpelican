import { createRoute, z } from "@hono/zod-openapi";
import { suppressions } from "@dispatch/db";
import { addSuppression } from "@dispatch/db";
import { normalizeEmail } from "@dispatch/domain";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Deps, Principal } from "../deps.js";
import { audit, parsePagination, toCursorPage } from "../http.js";
import {
  createRouter,
  dataPageSchema,
  dataSchema,
  emailSchema,
  idParamSchema,
  jsonCreated,
  jsonOk,
  paginationQuerySchema,
  problemResponses,
} from "./helpers.js";

const suppressionInput = z.object({
  email: emailSchema,
  reason: z.enum(["hard_bounce", "complaint", "abuse", "manual"]).default("manual"),
});

/** Workspace-global suppression list. */
export function suppressionRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["suppressions"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of suppressions."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(suppressions)
        .where(
          and(
            eq(suppressions.workspaceId, workspaceId),
            isNull(suppressions.liftedAt),
            ...(after !== null ? [gt(suppressions.id, after)] : []),
          ),
        )
        .orderBy(asc(suppressions.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["suppressions"],
      request: { body: { content: { "application/json": { schema: suppressionInput } } } },
      responses: { ...jsonCreated(dataSchema, "Created suppression."), ...problemResponses(400) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const row = await addSuppression(deps.db, {
        workspaceId: p.workspaceId,
        emailNormalized: normalizeEmail(input.email),
        reason: input.reason,
        source: "api",
      });
      if (row === null) {
        const existing = await deps.db
          .select()
          .from(suppressions)
          .where(
            and(
              eq(suppressions.workspaceId, p.workspaceId),
              eq(suppressions.emailNormalized, normalizeEmail(input.email)),
            ),
          )
          .limit(1);
        if (existing[0] === undefined) {
          throw new HTTPException(400, { message: "Suppression insert failed." });
        }
        return c.json(existing[0], 201);
      }
      await audit(deps.db, p, "suppression.add", "suppression", row.id, {
        reason: input.reason,
      });
      return c.json(row, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["suppressions"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Lifted suppression."), ...problemResponses(404) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const rows = await deps.db
        .update(suppressions)
        .set({ liftedAt: new Date() })
        .where(
          and(
            eq(suppressions.id, c.req.valid("param").id),
            eq(suppressions.workspaceId, p.workspaceId),
            isNull(suppressions.liftedAt),
          ),
        )
        .returning();
      if (rows[0] === undefined) {
        throw new HTTPException(404, { message: "Suppression not found." });
      }
      await audit(deps.db, p, "suppression.lift", "suppression", rows[0].id);
      return c.json(rows[0], 200);
    },
  );

  return app;
}
