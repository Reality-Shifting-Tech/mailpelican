import { createVerify } from "node:crypto";
import { GetAccountCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";
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

export interface SesCredentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  configurationSetName?: string;
}

/** Minimal SESv2 surface so tests inject a fake without the AWS SDK. */
export interface SesClientLike {
  send(command: SendEmailCommand | GetAccountCommand): Promise<{ MessageId?: string }>;
}

const CAPABILITIES: RelayCapabilities = {
  providerIdempotency: true,
  deliveryEvents: true,
  bounceEvents: true,
  complaintEvents: true,
  scheduling: false,
};

const MIME_EOL = "\r\n";

/**
 * Build a minimal multipart/alternative MIME message. SES v2 only accepts
 * custom headers (List-Unsubscribe is mandatory for us) on raw sends.
 */
export function buildRawMime(message: PreparedMessage): string {
  const boundary = `----dispatch-${message.messageId}`;
  const headers: Record<string, string> = {
    "Message-ID": `<${message.messageId}@dispatch>`,
    From: `${message.fromName} <${message.fromEmail}>`,
    To: message.toEmail,
    Subject: message.subject,
    "MIME-Version": "1.0",
    "Content-Type": `multipart/alternative; boundary="${boundary}"`,
    ...message.headers,
  };
  if (message.replyTo !== null) {
    headers["Reply-To"] = message.replyTo;
  }
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const safe = (value: string) => value.replaceAll(/[\r\n]+/g, " ");
  const head = Object.entries(headers)
    .map(([name, value]) => `${name}: ${safe(value)}`)
    .join(MIME_EOL);
  return [
    head,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encode(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encode(message.html),
    `--${boundary}--`,
    "",
  ].join(MIME_EOL);
}

interface SnsNotification {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Subject?: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

/**
 * Amazon SES v2 driver (architecture §8). Feedback arrives as SNS
 * notifications wrapping SES event-publishing JSON; signatures are verified
 * against the SNS signing certificate before parsing.
 */
export class SesRelay implements RelayProvider {
  readonly type = "ses" as const;
  readonly capabilities = CAPABILITIES;

  private readonly client: SesClientLike;
  private readonly configurationSetName: string | undefined;
  private readonly fetchCertificate: (url: string) => Promise<string>;

  constructor(
    client: SesClientLike,
    configurationSetName: string | undefined,
    fetchCertificate: (url: string) => Promise<string>,
  ) {
    this.client = client;
    this.configurationSetName = configurationSetName;
    this.fetchCertificate = fetchCertificate;
  }

  async testConnection(): Promise<RelayHealth> {
    try {
      await this.client.send(new GetAccountCommand({}));
      return { ok: true, detail: "ses account reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "unknown error" };
    }
  }

  async send(message: PreparedMessage, context: SendContext): Promise<SendResult> {
    const raw = buildRawMime(message);
    const command = new SendEmailCommand({
      FromEmailAddress: message.fromEmail,
      Destination: { ToAddresses: [message.toEmail] },
      Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
      ...(this.configurationSetName !== undefined || context.configurationSetName !== undefined
        ? {
            ConfigurationSetName: context.configurationSetName ?? this.configurationSetName,
          }
        : {}),
      EmailTags: [
        { Name: "dispatch_message_id", Value: message.messageId },
        { Name: "dispatch_campaign_id", Value: context.campaignId },
      ],
    });
    const response = await this.client.send(command);
    return { providerMessageId: response.MessageId ?? null };
  }

  async verifyWebhook(request: RawWebhookRequest): Promise<VerifiedWebhook> {
    let notification: SnsNotification;
    try {
      notification = JSON.parse(request.body) as SnsNotification;
    } catch {
      return { valid: false, reason: "malformed sns payload" };
    }
    if (notification.SignatureVersion !== "1") {
      return { valid: false, reason: "unsupported sns signature version" };
    }
    const canonical = snsSigningString(notification);
    try {
      const certificate = await this.fetchCertificate(notification.SigningCertURL);
      const verifier = createVerify("RSA-SHA1");
      verifier.update(canonical, "utf8");
      const ok = verifier.verify(certificate, notification.Signature, "base64");
      if (!ok) {
        return { valid: false, reason: "sns signature mismatch" };
      }
    } catch {
      return { valid: false, reason: "sns signature verification failed" };
    }
    const timestamp = Date.parse(notification.Timestamp);
    if (Number.isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 15 * 60_000) {
      return { valid: false, reason: "sns timestamp outside tolerance" };
    }
    return { valid: true, payload: notification };
  }

  async normalizeWebhook(event: VerifiedWebhook): Promise<NormalizedEvent[]> {
    if (!event.valid) {
      return [];
    }
    const notification = event.payload as SnsNotification;
    if (notification.Type === "SubscriptionConfirmation") {
      return [];
    }
    let sesEvent: Record<string, unknown>;
    try {
      sesEvent = JSON.parse(notification.Message) as Record<string, unknown>;
    } catch {
      return [unknownEvent(notification.MessageId)];
    }
    const mail = (sesEvent.mail ?? {}) as { messageId?: string };
    const type = mapSesEventType(sesEvent.eventType as string | undefined);
    const occurredAt = Date.parse(
      (sesEvent[sesEvent.eventType as string] as { timestamp?: string } | undefined)?.timestamp ??
        "",
    );
    return [
      {
        providerEventId: notification.MessageId,
        type,
        providerMessageId: mail.messageId ?? null,
        occurredAt: Number.isNaN(occurredAt) ? new Date() : new Date(occurredAt),
        meta: { ses: sesEvent },
      },
    ];
  }
}

function unknownEvent(providerEventId: string): NormalizedEvent {
  return {
    providerEventId,
    type: "unknown",
    providerMessageId: null,
    occurredAt: new Date(),
    meta: {},
  };
}

function mapSesEventType(eventType: string | undefined): NormalizedEvent["type"] {
  switch (eventType) {
    case "Send":
      return "accepted";
    case "Delivery":
      return "delivered";
    case "Bounce":
      return "bounced";
    case "Complaint":
      return "complained";
    case "Reject":
      return "rejected";
    default:
      return "unknown";
  }
}

/** Canonical string SNS signs for Notification messages (SignatureVersion 1). */
export function snsSigningString(n: SnsNotification): string {
  const fields: [string, string | undefined][] = [
    ["Message", n.Message],
    ["MessageId", n.MessageId],
    ["Subject", n.Subject],
    ["Timestamp", n.Timestamp],
    ["TopicArn", n.TopicArn],
    ["Type", n.Type],
  ];
  let out = "";
  for (const [name, value] of fields) {
    if (value !== undefined) {
      out += `${name}\n${value}\n`;
    }
  }
  return out;
}

/** Guard used by the production certificate fetcher to restrict cert URLs. */
export function isAllowedSnsCertUrl(url: string): boolean {
  return /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//.test(url);
}
