import { createRoute, z } from "@hono/zod-openapi";
import {
  consentEvents,
  contacts,
  listMemberships,
} from "@dispatch/db";
import { isValidEmail, normalizeEmail } from "@dispatch/domain";
import { and, asc, eq, gt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Deps, Principal } from "../deps.js";
import { audit, parsePagination, toCursorPage, withIdempotencyKey } from "../http.js";
import {
  createRouter,
  customFieldsSchema,
  dataPageSchema,
  dataSchema,
  emailSchema,
  idParamSchema,
  jsonCreated,
  jsonOk,
  paginationQuerySchema,
  problemResponses,
} from "./helpers.js";

const contactInput = z.object({
  email: emailSchema,
  customFields: customFieldsSchema.optional(),
  trackingDisabled: z.boolean().optional(),
});

const importInput = z.object({
  listId: z.string().uuid().optional(),
  source: z.string().min(1).max(120).default("api"),
  // Rows are validated individually so one bad address never rejects a batch;
  // invalid rows land in the rejection report instead (architecture §10).
  contacts: z.array(contactInput.extend({ email: z.string().max(320) })).min(1).max(10_000),
});

/** Contact CRUD and bulk import (with consent capture). */
export function contactRoutes(deps: Deps) {
  const app = createRouter();
  const principal = (c: { get: (k: "principal") => Principal }) => c.get("principal");

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["contacts"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of contacts."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = principal(c);
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, workspaceId),
            ...(after !== null ? [gt(contacts.id, after)] : []),
          ),
        )
        .orderBy(asc(contacts.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["contacts"],
      request: { body: { content: { "application/json": { schema: contactInput } } } },
      responses: {
        ...jsonCreated(dataSchema, "Created contact."),
        ...problemResponses(400, 409),
      },
    }),
    async (c) => {
      const p = principal(c);
      const input = c.req.valid("json");
      const emailNormalized = normalizeEmail(input.email);
      if (!isValidEmail(emailNormalized)) {
        throw new HTTPException(400, { message: "Invalid email address." });
      }
      const inserted = await deps.db
        .insert(contacts)
        .values({
          workspaceId: p.workspaceId,
          emailNormalized,
          emailOriginal: input.email.trim(),
          customFields: input.customFields ?? {},
          trackingDisabled: input.trackingDisabled ?? false,
        })
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new HTTPException(409, { message: "Contact already exists." });
      }
      await audit(deps.db, p, "contact.create", "contact", row.id);
      return c.json(row, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: ["contacts"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Contact."), ...problemResponses(404) },
    }),
    async (c) => {
      const { workspaceId } = principal(c);
      const rows = await deps.db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, c.req.valid("param").id), eq(contacts.workspaceId, workspaceId)))
        .limit(1);
      if (rows[0] === undefined) {
        throw new HTTPException(404, { message: "Contact not found." });
      }
      return c.json(rows[0], 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: ["contacts"],
      request: {
        params: idParamSchema,
        body: { content: { "application/json": { schema: contactInput.partial() } } },
      },
      responses: { ...jsonOk(dataSchema, "Updated contact."), ...problemResponses(400, 404) },
    }),
    async (c) => {
      const p = principal(c);
      const input = c.req.valid("json");
      const rows = await deps.db
        .update(contacts)
        .set({
          ...(input.email !== undefined
            ? {
                emailNormalized: normalizeEmail(input.email),
                emailOriginal: input.email.trim(),
              }
            : {}),
          ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
          ...(input.trackingDisabled !== undefined
            ? { trackingDisabled: input.trackingDisabled }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(contacts.id, c.req.valid("param").id), eq(contacts.workspaceId, p.workspaceId)),
        )
        .returning();
      if (rows[0] === undefined) {
        throw new HTTPException(404, { message: "Contact not found." });
      }
      await audit(deps.db, p, "contact.update", "contact", rows[0].id);
      return c.json(rows[0], 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["contacts"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Deleted contact."), ...problemResponses(404) },
    }),
    async (c) => {
      const p = principal(c);
      const rows = await deps.db
        .delete(contacts)
        .where(
          and(eq(contacts.id, c.req.valid("param").id), eq(contacts.workspaceId, p.workspaceId)),
        )
        .returning({ id: contacts.id });
      if (rows[0] === undefined) {
        throw new HTTPException(404, { message: "Contact not found." });
      }
      await audit(deps.db, p, "contact.delete", "contact", rows[0].id);
      return c.json({ id: rows[0].id, deleted: true }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/import",
      tags: ["contacts"],
      request: {
        body: { content: { "application/json": { schema: importInput } } },
        headers: z.object({ "idempotency-key": z.string().min(1) }),
      },
      responses: {
        ...jsonOk(dataSchema, "Import summary."),
        ...problemResponses(400, 404),
      },
    }),
    async (c) => {
      const p = principal(c);
      const input = c.req.valid("json");
      const { body, replayed } = await withIdempotencyKey(
        deps.db,
        p,
        "contacts.import",
        c,
        async () => importContacts(deps, p, input),
      );
      if (replayed) {
        c.header("idempotency-replayed", "true");
      }
      return c.json(body, 200);
    },
  );

  return app;
}

async function importContacts(
  deps: Deps,
  p: Principal,
  input: z.infer<typeof importInput>,
): Promise<Record<string, unknown>> {
  let created = 0;
  let existing = 0;
  const rejected: { email: string; reason: string }[] = [];
  const now = new Date();

  for (const entry of input.contacts) {
    const emailNormalized = normalizeEmail(entry.email);
    if (!isValidEmail(emailNormalized)) {
      rejected.push({ email: entry.email, reason: "invalid_email" });
      continue;
    }
    const upserted = await deps.db
      .insert(contacts)
      .values({
        workspaceId: p.workspaceId,
        emailNormalized,
        emailOriginal: entry.email.trim(),
        customFields: entry.customFields ?? {},
      })
      .onConflictDoNothing()
      .returning();
    let contact = upserted[0];
    if (contact === undefined) {
      existing += 1;
      const rows = await deps.db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.workspaceId, p.workspaceId),
            eq(contacts.emailNormalized, emailNormalized),
          ),
        )
        .limit(1);
      contact = rows[0];
      if (contact === undefined) {
        rejected.push({ email: entry.email, reason: "lookup_failed" });
        continue;
      }
    } else {
      created += 1;
    }

    await deps.db.insert(consentEvents).values({
      workspaceId: p.workspaceId,
      contactId: contact.id,
      listId: input.listId ?? null,
      type: "imported",
      source: input.source,
      occurredAt: now,
    });

    if (input.listId !== undefined) {
      const membership = await deps.db
        .insert(listMemberships)
        .values({
          workspaceId: p.workspaceId,
          contactId: contact.id,
          listId: input.listId,
          state: "subscribed",
        })
        .onConflictDoNothing()
        .returning({ id: listMemberships.id });
      if (membership[0] !== undefined) {
        await deps.db.insert(consentEvents).values({
          workspaceId: p.workspaceId,
          contactId: contact.id,
          listId: input.listId,
          type: "subscribed",
          source: input.source,
          occurredAt: now,
        });
      }
    }
  }

  await audit(deps.db, p, "contact.import", "contact", null, {
    created,
    existing,
    rejected: rejected.length,
  });
  return { created, existing, rejected, listId: input.listId ?? null };
}
