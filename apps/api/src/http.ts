import { decodeCursor, encodeCursor, type CursorPage } from "@dispatch/contracts";
import { auditEvents, idempotencyKeys } from "@dispatch/db";
import type { Database } from "@dispatch/db";
import { DomainError } from "@dispatch/domain";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Principal } from "./deps.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Parse the `cursor` and `limit` query parameters shared by list routes. */
export function parsePagination(c: Context): { after: string | null; limit: number } {
  const cursorParam = c.req.query("cursor");
  let after: string | null = null;
  if (cursorParam !== undefined && cursorParam !== "") {
    try {
      after = decodeCursor(cursorParam).after;
    } catch {
      throw new HTTPException(400, { message: "Invalid cursor." });
    }
  }
  const limitParam = Number(c.req.query("limit") ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(limitParam) || limitParam < 1 || limitParam > MAX_PAGE_SIZE) {
    throw new HTTPException(400, { message: `limit must be 1..${MAX_PAGE_SIZE}.` });
  }
  return { after, limit: limitParam };
}

/** Shape a page of id-ordered rows into the cursor envelope. */
export function toCursorPage<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];
  const hasNextPage = rows.length > limit && last !== undefined;
  return {
    data,
    pageInfo: {
      nextCursor: hasNextPage ? encodeCursor({ after: last.id }) : null,
      hasNextPage,
    },
  };
}

/** Weak ETag for mutable drafts, derived from the updated_at timestamp. */
export function etagOf(updatedAt: Date): string {
  return `W/"${updatedAt.getTime()}"`;
}

/** Enforce If-Match optimistic concurrency on draft mutations (§9). */
export function requireIfMatch(c: Context, current: Date): void {
  const header = c.req.header("if-match");
  if (header === undefined) {
    throw new HTTPException(428, { message: "If-Match header is required on draft edits." });
  }
  if (header !== etagOf(current)) {
    throw new HTTPException(409, { message: "Draft changed since you read it; refetch first." });
  }
}

/**
 * Run a mutation under an Idempotency-Key (§9). A replay within the
 * retention window returns the stored response instead of re-executing.
 */
export async function withIdempotencyKey<T extends Record<string, unknown>>(
  db: Database,
  principal: Principal,
  endpoint: string,
  c: Context,
  execute: () => Promise<T>,
): Promise<{ body: T; replayed: boolean }> {
  const key = c.req.header("idempotency-key");
  if (key === undefined || key.length === 0 || key.length > 255) {
    throw new HTTPException(400, { message: "Idempotency-Key header is required." });
  }
  const existing = await db.query.idempotencyKeys.findFirst({
    where: (t, { and: a, eq: e }) =>
      a(e(t.workspaceId, principal.workspaceId), e(t.endpoint, endpoint), e(t.key, key)),
  });
  if (existing !== undefined) {
    return { body: existing.response as T, replayed: true };
  }
  const body = await execute();
  await db
    .insert(idempotencyKeys)
    .values({ workspaceId: principal.workspaceId, endpoint, key, response: body })
    .onConflictDoNothing();
  return { body, replayed: false };
}

/** Append an audit event for a mutation (architecture §4). */
export async function audit(
  db: Database,
  principal: Principal,
  action: string,
  resourceType: string,
  resourceId: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditEvents).values({
    workspaceId: principal.workspaceId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    action,
    resourceType,
    resourceId,
    meta,
  });
}

/** Re-throw domain errors as HTTPException so the error mapper shapes them. */
export function mapDomainError(error: unknown): never {
  if (error instanceof DomainError) {
    throw new HTTPException(error.httpStatus as 400, { message: error.message });
  }
  throw error;
}
