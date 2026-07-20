import { createRoute, z } from "@hono/zod-openapi";
import { relays, senderIdentities } from "@dispatch/db";
import type { RelayCapabilitiesValue } from "@dispatch/db";
import { encryptSecret, checkDnsRecords, DomainError } from "@dispatch/domain";
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

const capabilitiesSchema = z.object({
  providerIdempotency: z.boolean(),
  deliveryEvents: z.boolean(),
  bounceEvents: z.boolean(),
  complaintEvents: z.boolean(),
  scheduling: z.boolean(),
});

const relayInput = z.object({
  type: z.enum(["ses", "resend", "smtp"]),
  name: z.string().min(1).max(120),
  /** Provider credential JSON; stored AES-256-GCM encrypted, never returned. */
  credentials: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.unknown()).optional(),
  capabilities: capabilitiesSchema,
  rateLimit: z.number().int().min(1).max(100_000).optional(),
  isDefault: z.boolean().optional(),
});

/** Relay rows never expose credentials. */
function serializeRelay(row: typeof relays.$inferSelect) {
  const { credentialsEncrypted: _drop, ...rest } = row;
  return rest;
}

/** Relay configuration and connection testing. */
export function relayRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["relays"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of relays."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(relays)
        .where(
          and(
            eq(relays.workspaceId, workspaceId),
            ...(after !== null ? [gt(relays.id, after)] : []),
          ),
        )
        .orderBy(asc(relays.id))
        .limit(limit + 1);
      const page = toCursorPage(rows, limit);
      return c.json({ ...page, data: page.data.map(serializeRelay) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["relays"],
      request: { body: { content: { "application/json": { schema: relayInput } } } },
      responses: { ...jsonCreated(dataSchema, "Created relay."), ...problemResponses(400) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const inserted = await deps.db
        .insert(relays)
        .values({
          workspaceId: p.workspaceId,
          type: input.type,
          name: input.name,
          credentialsEncrypted: encryptSecret(
            JSON.stringify(input.credentials),
            deps.env.CREDENTIAL_ENCRYPTION_KEY,
          ),
          config: input.config ?? {},
          capabilities: input.capabilities as RelayCapabilitiesValue,
          rateLimit: input.rateLimit ?? null,
          isDefault: input.isDefault ?? false,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new HTTPException(400, { message: "Relay insert failed." });
      }
      await audit(deps.db, p, "relay.create", "relay", row.id, { type: input.type });
      return c.json(serializeRelay(row), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/test-connection",
      tags: ["relays"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Connection result."), ...problemResponses(404) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const rows = await deps.db
        .select()
        .from(relays)
        .where(and(eq(relays.id, c.req.valid("param").id), eq(relays.workspaceId, p.workspaceId)))
        .limit(1);
      const relay = rows[0];
      if (relay === undefined) {
        throw new HTTPException(404, { message: "Relay not found." });
      }
      const provider = await deps.createProvider(relay.id);
      const health = await provider.testConnection();
      const updated = await deps.db
        .update(relays)
        .set({ status: health.ok ? "ready" : "error", lastTestedAt: new Date() })
        .where(eq(relays.id, relay.id))
        .returning();
      await audit(deps.db, p, "relay.test", "relay", relay.id, { ok: health.ok });
      return c.json(
        { relay: updated[0] ? serializeRelay(updated[0]) : serializeRelay(relay), health },
        200,
      );
    },
  );

  return app;
}

const identityInput = z.object({
  relayId: z.string().uuid().optional(),
  domain: z.string().min(1).max(253),
  fromEmail: z.string().email(),
  fromName: z.string().min(1).max(120),
  replyTo: z.string().email().optional(),
  returnPath: z.string().email().optional(),
  trackingDomain: z.string().max(253).optional(),
});

/** Sender identities and their verification state. */
export function senderIdentityRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["sender-identities"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of identities."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(senderIdentities)
        .where(
          and(
            eq(senderIdentities.workspaceId, workspaceId),
            ...(after !== null ? [gt(senderIdentities.id, after)] : []),
          ),
        )
        .orderBy(asc(senderIdentities.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["sender-identities"],
      request: { body: { content: { "application/json": { schema: identityInput } } } },
      responses: { ...jsonCreated(dataSchema, "Created identity."), ...problemResponses(409) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const dnsRecords = [
        { type: "TXT", name: input.domain, value: `v=spf1 include:${input.domain} ~all` },
        { type: "CNAME", name: `dispatch._domainkey.${input.domain}`, value: "dkim.pending" },
        { type: "TXT", name: `_dmarc.${input.domain}`, value: "v=DMARC1; p=quarantine" },
      ];
      const inserted = await deps.db
        .insert(senderIdentities)
        .values({
          workspaceId: p.workspaceId,
          relayId: input.relayId ?? null,
          domain: input.domain,
          fromEmail: input.fromEmail,
          fromName: input.fromName,
          replyTo: input.replyTo ?? null,
          returnPath: input.returnPath ?? null,
          trackingDomain: input.trackingDomain ?? null,
          dnsRecords,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0] === undefined) {
        throw new HTTPException(409, { message: "This from address already exists." });
      }
      await audit(deps.db, p, "sender_identity.create", "sender_identity", inserted[0].id);
      return c.json(inserted[0], 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/verify",
      tags: ["sender-identities"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Verification result."), ...problemResponses(404, 422) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const found = await deps.db
        .select()
        .from(senderIdentities)
        .where(
          and(
            eq(senderIdentities.id, c.req.valid("param").id),
            eq(senderIdentities.workspaceId, p.workspaceId),
          ),
        )
        .limit(1);
      const identity = found[0];
      if (identity === undefined) {
        throw new HTTPException(404, { message: "Sender identity not found." });
      }
      // Live DNS check against the records issued at creation (ADR-0004):
      // every expected record must resolve before mail may send as this
      // identity. Failures flip the status to failed with per-record detail.
      const check = await checkDnsRecords(identity.dnsRecords, deps.resolveDns);
      if (!check.ok) {
        const missing = check.results
          .filter((result) => !result.found)
          .map((result) => `${result.record.type} ${result.record.name}`);
        await deps.db
          .update(senderIdentities)
          .set({ verificationStatus: "failed" })
          .where(eq(senderIdentities.id, identity.id));
        throw new DomainError(
          "dns_unverified",
          `DNS records not found: ${missing.join(", ")}. Publish them and verify again.`,
          422,
        );
      }
      const rows = await deps.db
        .update(senderIdentities)
        .set({ verificationStatus: "verified" })
        .where(eq(senderIdentities.id, identity.id))
        .returning();
      await audit(deps.db, p, "sender_identity.verify", "sender_identity", identity.id);
      return c.json({ ...rows[0], dns: check.results }, 200);
    },
  );

  return app;
}
