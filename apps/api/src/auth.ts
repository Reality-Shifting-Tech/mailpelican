import { apiKeys, uuidv7 } from "@dispatch/db";
import type { ApiKeyScope, Database } from "@dispatch/db";
import { hashToken } from "@dispatch/domain";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Principal } from "./deps.js";

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
    requestId: string;
  }
}

/** Assign a request id and echo it back on the response. */
export async function requestIdMiddleware(c: Context, next: Next) {
  const requestId = c.req.header("x-request-id") ?? uuidv7();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
}

function unauthorized(detail: string): never {
  throw new HTTPException(401, { message: detail });
}

/**
 * Bearer-token auth for scoped API keys. Keys have the form
 * `dk_<prefix>.<secret>`; only the SHA-256 of the secret is stored.
 */
export function createAuthMiddleware(db: Database) {
  return async function authMiddleware(c: Context, next: Next) {
    const header = c.req.header("authorization");
    if (header === undefined || !header.startsWith("Bearer ")) {
      unauthorized("Missing bearer token.");
    }
    const token = header.slice("Bearer ".length);
    const match = /^dk_([A-Za-z0-9_-]{8})\.(.+)$/.exec(token);
    if (match === null) {
      unauthorized("Malformed API key.");
    }
    const [, prefix, secret] = match as unknown as [string, string, string];
    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
      .limit(1);
    const key = rows[0];
    if (key === undefined) {
      unauthorized("Unknown API key.");
    }
    if (key.expiresAt !== null && key.expiresAt.getTime() <= Date.now()) {
      unauthorized("API key expired.");
    }
    if (hashToken(secret) !== key.secretHash) {
      unauthorized("Invalid API key.");
    }
    c.set("principal", {
      workspaceId: key.workspaceId,
      actorType: "api_key",
      actorId: key.id,
      scopes: key.scopes,
    });
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
    await next();
  };
}

/** Enforce that the principal carries the scope this route requires. */
export function requireScope(scope: ApiKeyScope) {
  return async (c: Context, next: Next) => {
    const principal = c.get("principal");
    if (!principal.scopes.includes(scope)) {
      throw new HTTPException(403, { message: `Missing required scope: ${scope}.` });
    }
    await next();
  };
}
