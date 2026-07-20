import { createRoute, z } from "@hono/zod-openapi";
import {
  appendOutbox,
  casCampaignStatus,
  campaigns,
  campaignVersions,
  consumeSendConfirmation,
  contacts,
  listMemberships,
  OUTBOX_TOPICS,
  relays,
} from "@dispatch/db";
import type { Database } from "@dispatch/db";
import {
  assertCampaignTransition,
  DomainError,
  hashToken,
  hasLintErrors,
  renderMergeTags,
} from "@dispatch/domain";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Deps, Principal } from "../deps.js";
import {
  audit,
  etagOf,
  parsePagination,
  requireIfMatch,
  toCursorPage,
  withIdempotencyKey,
} from "../http.js";
import {
  assertEditable,
  lintCampaignVersion,
  loadCampaign,
  loadCurrentVersion,
  loadVerifiedIdentity,
  prepareCampaign,
  recipientCounts,
  touchCampaign,
} from "../services/send-flow.js";
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

const campaignInput = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().max(998).default(""),
  previewText: z.string().max(998).default(""),
  fromName: z.string().max(120).default(""),
  fromEmail: z.string().email().or(z.literal("")).default(""),
  replyTo: z.string().email().optional(),
  bodyHtml: z.string().default(""),
  bodyText: z.string().default(""),
  audienceRef: z.string().uuid(),
  templateVersionId: z.string().uuid().optional(),
  relayId: z.string().uuid().optional(),
  senderIdentityId: z.string().uuid().optional(),
  trackingOptions: z
    .object({ opens: z.boolean(), clicks: z.boolean() })
    .default({ opens: true, clicks: true }),
});

const campaignPatch = campaignInput.partial().extend({
  status: z.enum(["ready"]).optional(),
});

const confirmInput = z.object({ confirmationToken: z.string().min(1) });

const scheduleInput = confirmInput.extend({ scheduledAt: z.string().datetime() });

const idempotencyHeaders = z.object({ "idempotency-key": z.string().min(1) });

/** Campaign lifecycle: draft, lint, preview, prepare, confirm, control. */
export function campaignRoutes(deps: Deps) {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["campaigns"],
      request: { query: paginationQuerySchema },
      responses: { ...jsonOk(dataPageSchema, "Page of campaigns."), ...problemResponses(400) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const { after, limit } = parsePagination(c);
      const rows = await deps.db
        .select()
        .from(campaigns)
        .where(
          and(
            eq(campaigns.workspaceId, workspaceId),
            ...(after !== null ? [gt(campaigns.id, after)] : []),
          ),
        )
        .orderBy(asc(campaigns.id))
        .limit(limit + 1);
      return c.json(toCursorPage(rows, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["campaigns"],
      request: { body: { content: { "application/json": { schema: campaignInput } } } },
      responses: {
        ...jsonCreated(dataSchema, "Created campaign with version 1."),
        ...problemResponses(400),
      },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const inserted = await deps.db
        .insert(campaigns)
        .values({
          workspaceId: p.workspaceId,
          name: input.name,
          relayId: input.relayId ?? null,
          senderIdentityId: input.senderIdentityId ?? null,
        })
        .returning();
      const campaign = inserted[0];
      if (campaign === undefined) {
        throw new HTTPException(400, { message: "Campaign insert failed." });
      }
      const version = await insertVersion(deps.db, campaign.id, input, 1);
      await deps.db
        .update(campaigns)
        .set({ currentVersionId: version.id })
        .where(eq(campaigns.id, campaign.id));
      const issues = await lintCampaignVersion(deps.db, p.workspaceId, version);
      if (!hasLintErrors(issues)) {
        await casCampaignStatus(deps.db, campaign.id, ["draft"], "ready");
      }
      await audit(deps.db, p, "campaign.create", "campaign", campaign.id);
      return c.json({ ...campaign, currentVersionId: version.id, version, lint: issues }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: ["campaigns"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Campaign."), ...problemResponses(404) },
    }),
    async (c) => {
      const { workspaceId } = c.get("principal") as Principal;
      const campaign = await loadCampaign(deps.db, workspaceId, c.req.valid("param").id);
      c.header("etag", etagOf(campaign.updatedAt));
      const version = campaign.currentVersionId
        ? await loadCurrentVersion(deps.db, campaign)
        : null;
      return c.json({ ...campaign, version }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: ["campaigns"],
      request: {
        params: idParamSchema,
        body: { content: { "application/json": { schema: campaignPatch } } },
      },
      responses: {
        ...jsonOk(dataSchema, "Updated campaign (new immutable version)."),
        ...problemResponses(400, 404, 409, 428),
      },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const campaign = await loadCampaign(deps.db, p.workspaceId, c.req.valid("param").id);
      requireIfMatch(c, campaign.updatedAt);
      assertEditable(campaign);
      const input = c.req.valid("json");

      if (input.status === "ready") {
        const version = await loadCurrentVersion(deps.db, campaign);
        const issues = await lintCampaignVersion(deps.db, p.workspaceId, version);
        if (hasLintErrors(issues)) {
          throw new DomainError("lint_failed", "Campaign has lint errors.", 422);
        }
        assertCampaignTransition(campaign.status, "ready");
        await casCampaignStatus(deps.db, campaign.id, [campaign.status], "ready");
      }

      const contentKeys = [
        "subject",
        "previewText",
        "fromName",
        "fromEmail",
        "replyTo",
        "bodyHtml",
        "bodyText",
        "audienceRef",
        "trackingOptions",
        "templateVersionId",
      ] as const;
      const hasContentChange = contentKeys.some((k) => input[k] !== undefined);
      let version = null;
      if (hasContentChange) {
        const current = await loadCurrentVersion(deps.db, campaign);
        const merged = {
          subject: input.subject ?? current.subject,
          previewText: input.previewText ?? current.previewText,
          fromName: input.fromName ?? current.fromName,
          fromEmail: input.fromEmail ?? current.fromEmail,
          replyTo: input.replyTo === undefined ? (current.replyTo ?? undefined) : input.replyTo,
          bodyHtml: input.bodyHtml ?? current.bodyHtml,
          bodyText: input.bodyText ?? current.bodyText,
          audienceRef: input.audienceRef ?? current.audienceRef,
          trackingOptions: input.trackingOptions ?? current.trackingOptions,
          templateVersionId:
            input.templateVersionId === undefined
              ? (current.templateVersionId ?? undefined)
              : input.templateVersionId,
        };
        const nextNumber = await nextVersionNumber(deps.db, campaign.id);
        version = await insertVersion(deps.db, campaign.id, merged, nextNumber);
        await deps.db
          .update(campaigns)
          .set({
            currentVersionId: version.id,
            ...(input.relayId !== undefined ? { relayId: input.relayId } : {}),
            ...(input.senderIdentityId !== undefined
              ? { senderIdentityId: input.senderIdentityId }
              : {}),
          })
          .where(eq(campaigns.id, campaign.id));
      } else if (input.relayId !== undefined || input.senderIdentityId !== undefined) {
        await deps.db
          .update(campaigns)
          .set({
            ...(input.relayId !== undefined ? { relayId: input.relayId } : {}),
            ...(input.senderIdentityId !== undefined
              ? { senderIdentityId: input.senderIdentityId }
              : {}),
          })
          .where(eq(campaigns.id, campaign.id));
      }
      const updatedAt = await touchCampaign(deps.db, campaign.id);
      await audit(deps.db, p, "campaign.update", "campaign", campaign.id);
      const fresh = await loadCampaign(deps.db, p.workspaceId, campaign.id);
      c.header("etag", etagOf(updatedAt));
      return c.json({ ...fresh, version }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/preview",
      tags: ["campaigns"],
      request: { params: idParamSchema },
      responses: { ...jsonOk(dataSchema, "Rendered preview and warnings."), ...problemResponses(404) },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const campaign = await loadCampaign(deps.db, p.workspaceId, c.req.valid("param").id);
      const version = await loadCurrentVersion(deps.db, campaign);
      const issues = await lintCampaignVersion(deps.db, p.workspaceId, version);
      const samples = await sampleRenders(deps, p.workspaceId, version);
      return c.json({ lint: issues, samples, recipientCounts: await recipientCounts(deps.db, campaign.id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/prepare",
      tags: ["campaigns"],
      request: { params: idParamSchema },
      responses: {
        ...jsonOk(dataSchema, "Audience snapshot and confirmation token."),
        ...problemResponses(404, 409, 422),
      },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const campaign = await loadCampaign(deps.db, p.workspaceId, c.req.valid("param").id);
      if (campaign.status !== "ready") {
        throw new DomainError(
          "invalid_transition",
          `Campaign must be ready to prepare (status: ${campaign.status}).`,
          409,
        );
      }
      const version = await loadCurrentVersion(deps.db, campaign);
      const result = await prepareCampaign(deps.db, p, campaign, version);
      await audit(deps.db, p, "campaign.prepare", "campaign", campaign.id, {
        included: result.included,
        excluded: result.excluded,
      });
      return c.json(
        {
          campaignId: campaign.id,
          campaignVersionId: version.id,
          included: result.included,
          excluded: result.excluded,
          audienceHash: result.audienceHash,
          confirmationToken: result.confirmationToken,
          expiresAt: result.expiresAt,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/confirm-send",
      tags: ["campaigns"],
      request: {
        params: idParamSchema,
        headers: idempotencyHeaders,
        body: { content: { "application/json": { schema: confirmInput } } },
      },
      responses: {
        ...jsonOk(dataSchema, "Campaign sending."),
        ...problemResponses(400, 403, 404, 409, 422),
      },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const { body } = await withIdempotencyKey(
        deps.db,
        p,
        "campaigns.confirm-send",
        c,
        async () => confirmSend(deps, p, c.req.valid("param").id, c.req.valid("json")),
      );
      return c.json(body, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/schedule",
      tags: ["campaigns"],
      request: {
        params: idParamSchema,
        headers: idempotencyHeaders,
        body: { content: { "application/json": { schema: scheduleInput } } },
      },
      responses: {
        ...jsonOk(dataSchema, "Campaign scheduled."),
        ...problemResponses(400, 404, 409),
      },
    }),
    async (c) => {
      const p = c.get("principal") as Principal;
      const input = c.req.valid("json");
      const { body } = await withIdempotencyKey(
        deps.db,
        p,
        "campaigns.schedule",
        c,
        async () => {
          const campaign = await loadCampaign(deps.db, p.workspaceId, c.req.valid("param").id);
          const confirmation = await consumeConfirmation(deps.db, campaign, input.confirmationToken);
          assertCampaignTransition(campaign.status, "scheduled");
          const moved = await casCampaignStatus(deps.db, campaign.id, [campaign.status], "scheduled", {
            scheduledAt: new Date(input.scheduledAt),
          });
          if (moved === null) {
            throw new DomainError("invalid_transition", "Campaign state changed; refetch.", 409);
          }
          await audit(deps.db, p, "campaign.schedule", "campaign", campaign.id, {
            scheduledAt: input.scheduledAt,
          });
          return { campaign: moved, recipientCount: confirmation.recipientCount };
        },
      );
      return c.json(body, 200);
    },
  );

  for (const [action, to] of [
    ["pause", "paused"],
    ["resume", "sending"],
    ["cancel", "cancelled"],
  ] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/{id}/${action}`,
        tags: ["campaigns"],
        request: { params: idParamSchema },
        responses: {
          ...jsonOk(dataSchema, `Campaign ${action}.`),
          ...problemResponses(404, 409),
        },
      }),
      async (c) => {
        const p = c.get("principal") as Principal;
        const campaign = await loadCampaign(deps.db, p.workspaceId, c.req.valid("param").id);
        assertCampaignTransition(campaign.status, to);
        const moved = await casCampaignStatus(deps.db, campaign.id, [campaign.status], to);
        if (moved === null) {
          throw new DomainError("invalid_transition", "Campaign state changed; refetch.", 409);
        }
        await audit(deps.db, p, `campaign.${action}`, "campaign", campaign.id);
        return c.json({ campaign: moved }, 200);
      },
    );
  }

  return app;
}

async function insertVersion(
  db: Database,
  campaignId: string,
  input: {
    subject: string;
    previewText: string;
    fromName: string;
    fromEmail: string;
    replyTo?: string | undefined;
    bodyHtml: string;
    bodyText: string;
    audienceRef: string;
    templateVersionId?: string | undefined;
    trackingOptions: { opens: boolean; clicks: boolean };
  },
  version: number,
) {
  const inserted = await db
    .insert(campaignVersions)
    .values({
      campaignId,
      version,
      subject: input.subject,
      previewText: input.previewText,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      replyTo: input.replyTo ?? null,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
      audienceRef: input.audienceRef,
      templateVersionId: input.templateVersionId ?? null,
      trackingOptions: input.trackingOptions,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new HTTPException(400, { message: "Campaign version insert failed." });
  }
  return row;
}

async function nextVersionNumber(db: Database, campaignId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${campaignVersions.version}), 0) + 1` })
    .from(campaignVersions)
    .where(eq(campaignVersions.campaignId, campaignId));
  return rows[0]?.max ?? 1;
}

async function consumeConfirmation(
  db: Parameters<typeof consumeSendConfirmation>[0],
  campaign: { id: string; currentVersionId: string | null },
  rawToken: string,
) {
  const confirmation = await consumeSendConfirmation(db, hashToken(rawToken));
  if (confirmation === null || confirmation.campaignId !== campaign.id) {
    throw new DomainError(
      "invalid_confirmation",
      "Confirmation token is invalid, expired, or already used.",
      409,
    );
  }
  if (campaign.currentVersionId !== confirmation.campaignVersionId) {
    throw new DomainError(
      "invalid_confirmation",
      "Campaign content changed since prepare; prepare again.",
      409,
    );
  }
  return confirmation;
}

async function confirmSend(
  deps: Deps,
  p: Principal,
  campaignId: string,
  input: z.infer<typeof confirmInput>,
): Promise<Record<string, unknown>> {
  const campaign = await loadCampaign(deps.db, p.workspaceId, campaignId);
  await loadVerifiedIdentity(deps.db, campaign.senderIdentityId);
  if (campaign.relayId === null) {
    throw new DomainError("no_relay", "Campaign has no relay.", 422);
  }
  const relayRows = await deps.db
    .select()
    .from(relays)
    .where(and(eq(relays.id, campaign.relayId), eq(relays.workspaceId, p.workspaceId)))
    .limit(1);
  if (relayRows[0] === undefined || relayRows[0].status === "error") {
    throw new DomainError("relay_not_ready", "Campaign relay is not ready.", 422);
  }
  const confirmation = await consumeConfirmation(deps.db, campaign, input.confirmationToken);

  const keyRows = await deps.db.query.apiKeys.findMany({
    where: (t, { eq: e }) => e(t.id, p.actorId),
    limit: 1,
  });
  const sendLimit = keyRows[0]?.sendLimit ?? null;
  if (sendLimit !== null && confirmation.recipientCount > sendLimit) {
    throw new DomainError(
      "send_limit_exceeded",
      `Recipient count ${confirmation.recipientCount} exceeds this key's send limit ${sendLimit}.`,
      403,
    );
  }

  // Atomic per architecture §6 step 5: transition + outbox row in one commit.
  const moved = await deps.db.transaction(async (tx) => {
    const transitioned = await casCampaignStatus(tx, campaign.id, [campaign.status], "preparing", {
      startedAt: new Date(),
    });
    if (transitioned === null) {
      throw new DomainError("invalid_transition", "Campaign state changed; refetch.", 409);
    }
    await appendOutbox(tx, {
      workspaceId: p.workspaceId,
      topic: OUTBOX_TOPICS.campaignSend,
      payload: { workspaceId: p.workspaceId, campaignId: campaign.id },
    });
    return transitioned;
  });
  await audit(deps.db, p, "campaign.confirm_send", "campaign", campaign.id, {
    recipientCount: confirmation.recipientCount,
  });
  return { campaign: moved, recipientCount: confirmation.recipientCount };
}

async function sampleRenders(
  deps: Deps,
  workspaceId: string,
  version: { subject: string; bodyHtml: string; bodyText: string; audienceRef: string },
) {
  const rows = await deps.db
    .select({
      email: contacts.emailNormalized,
      customFields: contacts.customFields,
    })
    .from(listMemberships)
    .innerJoin(contacts, eq(listMemberships.contactId, contacts.id))
    .where(
      and(
        eq(listMemberships.workspaceId, workspaceId),
        eq(listMemberships.listId, version.audienceRef),
        eq(listMemberships.state, "subscribed"),
      ),
    )
    .limit(3);
  return rows.map((row) => {
    const fields = { email: row.email, ...row.customFields };
    return {
      email: row.email,
      subject: renderMergeTags(version.subject, fields, { escape: false }),
      html: renderMergeTags(version.bodyHtml, fields, { escape: true }),
      text: renderMergeTags(version.bodyText, fields, { escape: false }),
    };
  });
}
