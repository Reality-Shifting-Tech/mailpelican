import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  NormalizedEvent,
  PreparedMessage,
  RawWebhookRequest,
  RelayCapabilities,
  RelayHealth,
  RelayProvider,
  SendContext,
  SendResult,
  VerifiedWebhook,
} from "./types.js";

export interface ResendCredentials {
  apiKey: string;
}

/** Minimal Resend client surface so tests inject a fake without the SDK. */
export interface ResendClientLike {
  emails: {
    send(input: Record<string, unknown>): Promise<{
      data: { id: string } | null;
      error: { name: string; message: string } | null;
    }>;
  };
  domains: {
    list(): Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

const CAPABILITIES: RelayCapabilities = {
  // Resend has no send idempotency key; our message id still dedups at the DB.
  providerIdempotency: false,
  deliveryEvents: true,
  bounceEvents: true,
  complaintEvents: true,
  scheduling: true,
};

const SVIX_TOLERANCE_MS = 5 * 60_000;

export class ResendSendError extends Error {
  readonly code: string;

  constructor(name: string, message: string) {
    super(message);
    this.name = "ResendSendError";
    this.code = name;
  }
}

/**
 * Resend driver using the official SDK surface (architecture §8). Webhooks
 * are Svix-signed: HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>`.
 */
export class ResendRelay implements RelayProvider {
  readonly type = "resend" as const;
  readonly capabilities = CAPABILITIES;

  private readonly client: ResendClientLike;
  private readonly webhookSecret: string | undefined;

  constructor(client: ResendClientLike, webhookSecret: string | undefined) {
    this.client = client;
    this.webhookSecret = webhookSecret;
  }

  async testConnection(): Promise<RelayHealth> {
    const { error } = await this.client.domains.list();
    if (error !== null) {
      return { ok: false, detail: error.message };
    }
    return { ok: true, detail: "resend api reachable" };
  }

  async send(message: PreparedMessage, context: SendContext): Promise<SendResult> {
    const { data, error } = await this.client.emails.send({
      from: `${message.fromName} <${message.fromEmail}>`,
      to: [message.toEmail],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo !== null ? { replyTo: message.replyTo } : {}),
      headers: message.headers,
      tags: [
        { name: "dispatch_message_id", value: message.messageId },
        ...(context.campaignId !== undefined
          ? [{ name: "dispatch_campaign_id", value: context.campaignId }]
          : []),
      ],
    });
    if (error !== null) {
      throw new ResendSendError(error.name, error.message);
    }
    return { providerMessageId: data?.id ?? null };
  }

  async verifyWebhook(request: RawWebhookRequest): Promise<VerifiedWebhook> {
    if (this.webhookSecret === undefined) {
      return { valid: false, reason: "webhook secret not configured" };
    }
    const id = request.headers["svix-id"];
    const timestamp = request.headers["svix-timestamp"];
    const signatureHeader = request.headers["svix-signature"];
    if (id === undefined || timestamp === undefined || signatureHeader === undefined) {
      return { valid: false, reason: "missing svix headers" };
    }
    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SVIX_TOLERANCE_MS) {
      return { valid: false, reason: "svix timestamp outside tolerance" };
    }
    const secret = this.webhookSecret.startsWith("whsec_")
      ? this.webhookSecret.slice("whsec_".length)
      : this.webhookSecret;
    const expected = createHmac("sha256", Buffer.from(secret, "base64"))
      .update(`${id}.${timestamp}.${request.body}`, "utf8")
      .digest("base64");
    const offered = signatureHeader
      .split(" ")
      .map((entry) => entry.split(",")[1])
      .filter((value): value is string => value !== undefined);
    const matched = offered.some((candidate) => {
      const a = Buffer.from(candidate);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!matched) {
      return { valid: false, reason: "svix signature mismatch" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      return { valid: false, reason: "malformed resend payload" };
    }
    return { valid: true, payload: { svixId: id, event: parsed } };
  }

  async normalizeWebhook(event: VerifiedWebhook): Promise<NormalizedEvent[]> {
    if (!event.valid) {
      return [];
    }
    const { svixId, event: body } = event.payload as {
      svixId: string;
      event: { type?: string; created_at?: string; data?: { email_id?: string } };
    };
    const occurredAt = Date.parse(body.created_at ?? "");
    return [
      {
        providerEventId: svixId,
        type: mapResendEventType(body.type),
        providerMessageId: body.data?.email_id ?? null,
        occurredAt: Number.isNaN(occurredAt) ? new Date() : new Date(occurredAt),
        meta: { resend: body },
      },
    ];
  }
}

function mapResendEventType(type: string | undefined): NormalizedEvent["type"] {
  switch (type) {
    case "email.sent":
      return "accepted";
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.failed":
      return "rejected";
    default:
      return "unknown";
  }
}
