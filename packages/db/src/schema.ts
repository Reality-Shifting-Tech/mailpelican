import { sql } from "drizzle-orm";
import type { DmarcPolicy, DmarcRecord } from "@mailpelican/domain";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "./uuidv7.js";

const id = () => uuid("id").primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("UTC"),
  organizationName: text("organization_name").notNull(),
  postalAddress: text("postal_address").notNull(),
  createdAt: createdAt(),
});

export const apiKeyScopes = ["read", "write", "send"] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

/**
 * Scoped API keys (architecture §4). `secretHash` is a SHA-256 digest; the
 * raw key is shown once at creation. `sendLimit` caps recipients per
 * campaign; `approvalThreshold` requires an extra confirmation above it.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    scopes: jsonb("scopes").$type<ApiKeyScope[]>().notNull(),
    sendLimit: integer("send_limit"),
    approvalThreshold: integer("approval_threshold"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_prefix_unique").on(t.prefix)],
);

export const auditActorTypes = ["owner", "api_key", "system"] as const;
export const auditActorTypeEnum = pgEnum("audit_actor_type", auditActorTypes);

/** Append-only attribution log; never updated or deleted (architecture §4). */
export const auditEvents = pgTable("audit_events", {
  id: id(),
  workspaceId: workspaceId(),
  actorType: auditActorTypeEnum("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  requestId: text("request_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    workspaceId: workspaceId(),
    emailNormalized: text("email_normalized").notNull(),
    emailOriginal: text("email_original").notNull(),
    customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default({}),
    trackingDisabled: boolean("tracking_disabled").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("contacts_workspace_email_unique").on(t.workspaceId, t.emailNormalized)],
);

export const lists = pgTable(
  "lists",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [unique("lists_workspace_name_unique").on(t.workspaceId, t.name)],
);

export const membershipStates = ["pending", "subscribed", "unsubscribed"] as const;
export const membershipStateEnum = pgEnum("membership_state", membershipStates);
export type MembershipStateValue = (typeof membershipStates)[number];

/** Per-list subscription state; a contact may differ across lists (§4). */
export const listMemberships = pgTable(
  "list_memberships",
  {
    id: id(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id),
    state: membershipStateEnum("state").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("list_memberships_contact_list_unique").on(t.contactId, t.listId)],
);

export const consentEventTypes = [
  "requested",
  "confirmed",
  "subscribed",
  "unsubscribed",
  "imported",
  "erased",
] as const;
export const consentEventTypeEnum = pgEnum("consent_event_type", consentEventTypes);

/** Append-only consent trail; the legal record of how a contact subscribed. */
export const consentEvents = pgTable("consent_events", {
  id: id(),
  workspaceId: workspaceId(),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id),
  listId: uuid("list_id").references(() => lists.id),
  type: consentEventTypeEnum("type").notNull(),
  source: text("source").notNull(),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
});

export const confirmationTokenActions = ["confirm_subscription", "unsubscribe"] as const;
export const confirmationTokenActionEnum = pgEnum(
  "confirmation_token_action",
  confirmationTokenActions,
);

/**
 * Hashed, scoped, expiring tokens (architecture §4). `usedAt` enforces
 * single-use where the action requires it; unsubscribe tokens stay reusable
 * because unsubscribing is idempotent (see ADR-0004).
 */
export const confirmationTokens = pgTable(
  "confirmation_tokens",
  {
    id: id(),
    workspaceId: workspaceId(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    listId: uuid("list_id").references(() => lists.id),
    action: confirmationTokenActionEnum("action").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("confirmation_tokens_hash_unique").on(t.tokenHash)],
);

export const suppressionReasons = ["hard_bounce", "complaint", "abuse", "manual"] as const;
export const suppressionReasonEnum = pgEnum("suppression_reason", suppressionReasons);

/** Workspace-global suppression; overrides every list membership (§4). */
export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    workspaceId: workspaceId(),
    emailNormalized: text("email_normalized").notNull(),
    reason: suppressionReasonEnum("reason").notNull(),
    source: text("source").notNull(),
    createdAt: createdAt(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (t) => [unique("suppressions_workspace_email_unique").on(t.workspaceId, t.emailNormalized)],
);

export const relayTypes = ["ses", "resend", "smtp"] as const;
export const relayTypeEnum = pgEnum("relay_type", relayTypes);
export type RelayTypeValue = (typeof relayTypes)[number];

export const relayStatuses = ["pending", "ready", "error", "paused"] as const;
export const relayStatusEnum = pgEnum("relay_status", relayStatuses);

/** Declared driver capabilities, snapshotted from the RelayProvider (§8). */
export interface RelayCapabilitiesValue {
  providerIdempotency: boolean;
  deliveryEvents: boolean;
  bounceEvents: boolean;
  complaintEvents: boolean;
  scheduling: boolean;
}

export const relays = pgTable("relays", {
  id: id(),
  workspaceId: workspaceId(),
  type: relayTypeEnum("type").notNull(),
  name: text("name").notNull(),
  credentialsEncrypted: text("credentials_encrypted").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  capabilities: jsonb("capabilities").$type<RelayCapabilitiesValue>().notNull(),
  /** Sustained send rate in messages per second; null means unlimited. */
  rateLimit: integer("rate_limit"),
  status: relayStatusEnum("status").notNull().default("pending"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
});

export const verificationStatuses = ["pending", "verified", "failed"] as const;
export const verificationStatusEnum = pgEnum("verification_status", verificationStatuses);

export const senderIdentities = pgTable(
  "sender_identities",
  {
    id: id(),
    workspaceId: workspaceId(),
    relayId: uuid("relay_id").references(() => relays.id),
    domain: text("domain").notNull(),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name").notNull(),
    replyTo: text("reply_to"),
    returnPath: text("return_path"),
    verificationStatus: verificationStatusEnum("verification_status").notNull().default("pending"),
    dnsRecords: jsonb("dns_records")
      .$type<{ type: string; name: string; value: string }[]>()
      .notNull()
      .default([]),
    trackingDomain: text("tracking_domain"),
    createdAt: createdAt(),
  },
  (t) => [unique("sender_identities_workspace_email_unique").on(t.workspaceId, t.fromEmail)],
);

export const templates = pgTable("templates", {
  id: id(),
  workspaceId: workspaceId(),
  name: text("name").notNull(),
  /** Back-pointer to the current version; no FK to avoid a circular DDL. */
  currentVersionId: uuid("current_version_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Immutable authored source (§4). M1 stores a simple subject/body version;
 * `designJson` + `editorSchemaVersion` are the slots the React Email editor
 * fills in M2 without a schema change.
 */
export const templateVersions = pgTable(
  "template_versions",
  {
    id: id(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    version: integer("version").notNull(),
    editorSchemaVersion: text("editor_schema_version").notNull().default("m1-simple"),
    designJson: jsonb("design_json").$type<Record<string, unknown>>(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull(),
    sourceHash: text("source_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("template_versions_version_unique").on(t.templateId, t.version)],
);

export const campaignStatuses = [
  "draft",
  "ready",
  "scheduled",
  "preparing",
  "sending",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;
export const campaignStatusEnum = pgEnum("campaign_status", campaignStatuses);

export const campaigns = pgTable("campaigns", {
  id: id(),
  workspaceId: workspaceId(),
  name: text("name").notNull(),
  status: campaignStatusEnum("status").notNull().default("draft"),
  /** Back-pointer to the current version; no FK to avoid a circular DDL. */
  currentVersionId: uuid("current_version_id"),
  relayId: uuid("relay_id").references(() => relays.id),
  senderIdentityId: uuid("sender_identity_id").references(() => senderIdentities.id),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const audienceTypes = ["list"] as const;
export const audienceTypeEnum = pgEnum("audience_type", audienceTypes);

/** Immutable complete message definition (§4); edits create a new version. */
export const campaignVersions = pgTable(
  "campaign_versions",
  {
    id: id(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    version: integer("version").notNull(),
    templateVersionId: uuid("template_version_id").references(() => templateVersions.id),
    subject: text("subject").notNull(),
    previewText: text("preview_text").notNull().default(""),
    fromName: text("from_name").notNull(),
    fromEmail: text("from_email").notNull(),
    replyTo: text("reply_to"),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull(),
    audienceType: audienceTypeEnum("audience_type").notNull().default("list"),
    audienceRef: uuid("audience_ref").notNull(),
    trackingOptions: jsonb("tracking_options")
      .$type<{ opens: boolean; clicks: boolean }>()
      .notNull()
      .default({ opens: true, clicks: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("campaign_versions_version_unique").on(t.campaignId, t.version)],
);

export const recipientStatuses = [
  "included",
  "queued",
  "sending",
  "accepted",
  "delivered",
  "excluded",
  "suppressed",
  "unsubscribed",
  "failed",
  "bounced",
  "complained",
  "cancelled",
] as const;
export const recipientStatusEnum = pgEnum("recipient_status", recipientStatuses);
export type RecipientStatusValue = (typeof recipientStatuses)[number];

/**
 * Immutable audience snapshot taken at prepare time (§4). Rows are written
 * once; only `status` moves through the recipient state machine.
 */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: id(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    campaignVersionId: uuid("campaign_version_id")
      .notNull()
      .references(() => campaignVersions.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    email: text("email").notNull(),
    personalization: jsonb("personalization").$type<Record<string, string>>().notNull().default({}),
    status: recipientStatusEnum("status").notNull().default("included"),
    exclusionReason: text("exclusion_reason"),
    createdAt: createdAt(),
  },
  (t) => [unique("campaign_recipients_contact_unique").on(t.campaignId, t.contactId)],
);

/** One row per recipient; `id` is the logical send idempotency key (§4). */
export const messages = pgTable("messages", {
  id: id(),
  workspaceId: workspaceId(),
  campaignId: uuid("campaign_id")
    .notNull()
    .references(() => campaigns.id),
  campaignRecipientId: uuid("campaign_recipient_id")
    .notNull()
    .references(() => campaignRecipients.id),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contacts.id),
  relayId: uuid("relay_id")
    .notNull()
    .references(() => relays.id),
  providerMessageId: text("provider_message_id"),
  status: recipientStatusEnum("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const eventTypes = [
  "accepted",
  "delivered",
  "bounced",
  "complained",
  "rejected",
  "opened",
  "clicked",
  "unknown",
] as const;
export const eventTypeEnum = pgEnum("event_type", eventTypes);

/** Append-only normalized provider feedback (§4). */
export const events = pgTable(
  "events",
  {
    id: id(),
    workspaceId: workspaceId(),
    messageId: uuid("message_id").references(() => messages.id),
    relayId: uuid("relay_id")
      .notNull()
      .references(() => relays.id),
    providerEventId: text("provider_event_id"),
    payloadHash: text("payload_hash").notNull(),
    type: eventTypeEnum("type").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("events_relay_provider_event_unique")
      .on(t.relayId, t.providerEventId)
      .where(sql`provider_event_id is not null`),
    uniqueIndex("events_relay_payload_hash_unique").on(t.relayId, t.payloadHash),
  ],
);

export const webhookStates = ["received", "processed", "failed", "dead"] as const;
export const webhookStateEnum = pgEnum("webhook_state", webhookStates);

/**
 * Verified raw provider payloads stored before normalization (§6). The
 * (relay_id, payload_hash) uniqueness makes inbox storage idempotent;
 * `replayOf` links admin replays to the original row.
 */
export const inboundWebhookEvents = pgTable(
  "inbound_webhook_events",
  {
    id: id(),
    workspaceId: workspaceId(),
    relayId: uuid("relay_id")
      .notNull()
      .references(() => relays.id),
    headers: jsonb("headers").$type<Record<string, string>>().notNull(),
    payload: text("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: webhookStateEnum("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    replayOf: uuid("replay_of"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("inbound_webhook_events_dedup_unique").on(t.relayId, t.payloadHash)],
);

/**
 * Parsed DMARC aggregate (rua) reports — the free daily authentication
 * telemetry mailbox providers send domain owners. `payloadHash` of the raw
 * XML makes ingestion idempotent across replays and duplicate deliveries.
 */
export const dmarcReports = pgTable(
  "dmarc_reports",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The domain the report's policy was published for. */
    domain: text("domain").notNull(),
    orgName: text("org_name").notNull(),
    reportId: text("report_id").notNull().default(""),
    dateBegin: timestamp("date_begin", { withTimezone: true }).notNull(),
    dateEnd: timestamp("date_end", { withTimezone: true }).notNull(),
    policy: jsonb("policy").$type<DmarcPolicy>().notNull(),
    records: jsonb("records").$type<DmarcRecord[]>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("dmarc_reports_workspace_hash_unique").on(t.workspaceId, t.payloadHash)],
);

export const outboxStatuses = ["pending", "dispatched", "dead"] as const;
export const outboxStatusEnum = pgEnum("outbox_status", outboxStatuses);

/**
 * Committed side effects awaiting enqueue (§4). Rows are written in the same
 * transaction as the state change they belong to; the dispatcher retries
 * until delivered or dead-lettered.
 */
export const outbox = pgTable("outbox", {
  id: id(),
  workspaceId: workspaceId(),
  topic: text("topic").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: outboxStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: createdAt(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
});

/**
 * Server-issued, hashed, single-use send confirmations bound to actor,
 * campaign version, audience hash, and recipient count (§6 step 4).
 */
export const sendConfirmations = pgTable(
  "send_confirmations",
  {
    id: id(),
    workspaceId: workspaceId(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    campaignVersionId: uuid("campaign_version_id")
      .notNull()
      .references(() => campaignVersions.id),
    tokenHash: text("token_hash").notNull(),
    actorType: auditActorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    audienceHash: text("audience_hash").notNull(),
    recipientCount: integer("recipient_count").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("send_confirmations_hash_unique").on(t.tokenHash)],
);

/**
 * Server-side record of Idempotency-Key handling for mutations that need it
 * (§9). Replays within the retention window return the stored response.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    workspaceId: workspaceId(),
    key: text("key").notNull(),
    endpoint: text("endpoint").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("idempotency_keys_unique").on(t.workspaceId, t.endpoint, t.key)],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type List = typeof lists.$inferSelect;
export type ListMembership = typeof listMemberships.$inferSelect;
export type ConsentEvent = typeof consentEvents.$inferSelect;
export type ConfirmationToken = typeof confirmationTokens.$inferSelect;
export type Suppression = typeof suppressions.$inferSelect;
export type Relay = typeof relays.$inferSelect;
export type SenderIdentity = typeof senderIdentities.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type TemplateVersion = typeof templateVersions.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignVersion = typeof campaignVersions.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Event = typeof events.$inferSelect;
export type DmarcReport = typeof dmarcReports.$inferSelect;
export type InboundWebhookEvent = typeof inboundWebhookEvents.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type SendConfirmation = typeof sendConfirmations.$inferSelect;
