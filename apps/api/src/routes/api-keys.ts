import { createRoute, z } from "@hono/zod-openapi";
import { apiKeys } from "@dispatch/db";
import { generateToken, hashToken } from "@dispatch/domain";
import { and, asc, eq, gt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
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

const apiKeyInput = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(["read", "write", "send"])).min(1),
  sendLimit: z.number().int().min(1).optional(),
  approvalThreshold: z.number().int().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

/**
 * Issue a new API key string. The raw value is returned once and only the
 * SHA-256 of the secret part is stored.
 */
export function issueApiKey(): { raw: string; prefix: string; secretHash: string } {
  const prefix = randomBytes(4).toString("hex");
  const secret = generateToken().raw;
  return { raw: `dk_${prefix}.${secret}`, prefix, secretHash: hashToken(secret) };
}

/** Scoped API key management. */
export function apiKeyRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["api-keys"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of API keys."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          sendLimit: apiKeys.sendLimit,
          approvalThreshold: apiKeys.approvalThreshold,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.workspaceId, workspaceId),
            ...(after !== null ? [gt(apiKeys.id, after)] : []),
          ),
        )
        .orderBy(asc(apiKeys.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["api-keys"],
      request: { body: { content: { "application/json": { schema: apiKeyInput } } } },
      responses: { ...jsonCreated(dataSchema, "Created API key."), ...problemResponses(400) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const issued = issueApiKey();
      const inserted = await deps.db
        .insert(apiKeys)
        .values({
          workspaceId: p.workspaceId,
          name: input.name,
          prefix: issued.prefix,
          secretHash: issued.secretHash,
          scopes: input.scopes,
          sendLimit: input.sendLimit ?? null,
          approvalThreshold: input.approvalThreshold ?? null,
          expiresAt: input.expiresAt !== undefined ? new Date(input.expiresAt) : null,
        })
        .returning({ id: apiKeys.id });
      const row = inserted[0];
      if (row === undefined) {
        throw new HTTPException(400, { message: "API key insert failed." });
      }
      await audit(deps.db, p, "api_key.create", "api_key", row.id, { scopes: input.scopes });
      return c.json({ id: row.id, key: issued.raw, prefix: issued.prefix }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["api-keys"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Revoked API key."), ...problemResponses(404) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const rows = await deps.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, c.req.valid("param").id), eq(apiKeys.workspaceId, p.workspaceId)))
        .returning({ id: apiKeys.id });
      if (rows[0] === undefined) {
        throw new HTTPException(404, { message: "API key not found." });
      }
      await audit(deps.db, p, "api_key.revoke", "api_key", rows[0].id);
      return c.json({ id: rows[0].id, revoked: true }, 200);
    },
  );

  return app;
}
