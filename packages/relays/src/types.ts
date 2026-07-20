/**
 * RelayProvider contract (architecture §8). Drivers wrap SES, Resend, and
 * generic SMTP behind this single interface so campaign logic never touches
 * provider SDKs. Tests substitute the fake relay from @dispatch/testkit.
 */

export interface RelayCapabilities {
  /** Provider deduplicates retries when we reuse the same client token. */
  providerIdempotency: boolean;
  deliveryEvents: boolean;
  bounceEvents: boolean;
  complaintEvents: boolean;
  /** Provider-side scheduled delivery. */
  scheduling: boolean;
}

export interface PreparedMessage {
  /** Our message id; also the provider idempotency/client token. */
  messageId: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  /** RFC 8058 List-Unsubscribe headers and any provider passthrough. */
  headers: Record<string, string>;
}

export interface SendContext {
  workspaceId: string;
  relayId: string;
  campaignId: string;
  /** SES configuration set that publishes feedback events, when configured. */
  configurationSetName?: string;
}

export interface SendResult {
  /** Provider-assigned id used later to match webhook feedback. */
  providerMessageId: string | null;
}

export interface RelayHealth {
  ok: boolean;
  detail: string;
}

export interface RawWebhookRequest {
  headers: Record<string, string>;
  /** Exact raw request body; signature verification happens before parsing. */
  body: string;
}

export type VerifiedWebhook = { valid: true; payload: unknown } | { valid: false; reason: string };

export type NormalizedEventType =
  "accepted" | "delivered" | "bounced" | "complained" | "rejected" | "unknown";

export interface NormalizedEvent {
  providerEventId: string | null;
  type: NormalizedEventType;
  /** Provider message id used to match our stored message row. */
  providerMessageId: string | null;
  occurredAt: Date;
  meta: Record<string, unknown>;
}

export interface RelayProvider {
  readonly type: "ses" | "resend" | "smtp";
  readonly capabilities: RelayCapabilities;
  /** Validate credentials and reachability without sending mail. */
  testConnection(): Promise<RelayHealth>;
  send(message: PreparedMessage, context: SendContext): Promise<SendResult>;
  /** Verify signature and timestamp before any parsing of the payload. */
  verifyWebhook(request: RawWebhookRequest): Promise<VerifiedWebhook>;
  /** Map a verified provider payload to normalized internal events. */
  normalizeWebhook(event: VerifiedWebhook): Promise<NormalizedEvent[]>;
}
