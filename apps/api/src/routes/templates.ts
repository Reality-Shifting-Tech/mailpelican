import { createRoute, z } from "@hono/zod-openapi";
import { templates, templateVersions } from "@dispatch/db";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
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

const templateInput = z.object({ name: z.string().min(1).max(120) });

const versionInput = z.object({
  subject: z.string().max(998).default(""),
  bodyHtml: z.string().default(""),
  bodyText: z.string().default(""),
  designJson: z.record(z.string(), z.unknown()).optional(),
});

/** Templates with immutable, hash-addressed versions. */
export function templateRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["templates"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of templates."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(templates)
        .where(
          and(
            eq(templates.workspaceId, workspaceId),
            ...(after !== null ? [gt(templates.id, after)] : []),
          ),
        )
        .orderBy(asc(templates.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["templates"],
      request: { body: { content: { "application/json": { schema: templateInput } } } },
      responses: { ...jsonCreated(dataSchema, "Created template."), ...problemResponses(400) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const inserted = await deps.db
        .insert(templates)
        .values({ workspaceId: p.workspaceId, name: c.req.valid("json").name })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new HTTPException(400, { message: "Template insert failed." });
      }
      await audit(deps.db, p, "template.create", "template", row.id);
      return c.json(row, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}/versions",
      tags: ["templates"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(z.array(dataSchema), "Template versions."), ...problemResponses(404) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      await requireTemplate(deps, workspaceId, c.req.valid("param").id);
      const rows = await deps.db
        .select()
        .from(templateVersions)
        .where(eq(templateVersions.templateId, c.req.valid("param").id))
        .orderBy(desc(templateVersions.version));
      return c.json(rows, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/versions",
      tags: ["templates"],
      request: {
        params: idParamSchema,
        body: { content: { "application/json": { schema: versionInput } } },
      },
      responses: { ...jsonCreated(dataSchema, "Created version."), ...problemResponses(404) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const templateId = c.req.valid("param").id;
      await requireTemplate(deps, p.workspaceId, templateId);
      const input = c.req.valid("json");
      const next = await deps.db
        .select({ max: sql<number>`coalesce(max(${templateVersions.version}), 0) + 1` })
        .from(templateVersions)
        .where(eq(templateVersions.templateId, templateId));
      const version = next[0]?.max ?? 1;
      const sourceHash = createHash("sha256")
        .update(JSON.stringify([input.subject, input.bodyHtml, input.bodyText, input.designJson]))
        .digest("hex");
      const inserted = await deps.db
        .insert(templateVersions)
        .values({
          templateId,
          version,
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          bodyText: input.bodyText,
          designJson: input.designJson ?? null,
          sourceHash,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new HTTPException(400, { message: "Version insert failed." });
      }
      await deps.db
        .update(templates)
        .set({ currentVersionId: row.id, updatedAt: new Date() })
        .where(eq(templates.id, templateId));
      await audit(deps.db, p, "template.version.create", "template", templateId, { version });
      return c.json(row, 201);
    },
  );

  return app;
}

async function requireTemplate(deps: Deps, workspaceId: string, templateId: string) {
  const rows = await deps.db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.id, templateId), eq(templates.workspaceId, workspaceId)))
    .limit(1);
  if (rows[0] === undefined) {
    throw new HTTPException(404, { message: "Template not found." });
  }
}
