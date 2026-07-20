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
} from "@dispatch/relays";

export interface SentRecord {
  message: PreparedMessage;
  context: SendContext;
}

export interface FakeRelayOptions {
  type?: "ses" | "resend" | "smtp";
  capabilities?: Partial<RelayCapabilities>;
  /** When true, resending the same message id returns the first result. */
  providerIdempotency?: boolean;
}

/**
 * In-memory RelayProvider for tests and local development. Records every
 * accepted message, can be scripted to fail, and — when idempotent — dedups
 * retries by our message id exactly like a provider idempotency key.
 */
export class FakeRelay implements RelayProvider {
  readonly type: "ses" | "resend" | "smtp";
  readonly capabilities: RelayCapabilities;

  /** Every underlying send the provider accepted (post-dedup). */
  readonly sent: SentRecord[] = [];
  /** Total send calls, including idempotent replays. */
  sendCalls = 0;

  private readonly providerIdempotency: boolean;
  private readonly acceptedByMessageId = new Map<string, string>();
  private failure: Error | null = null;
  private failureAfterAccept = false;
  private providerCounter = 0;

  constructor(options: FakeRelayOptions = {}) {
    this.type = options.type ?? "ses";
    this.providerIdempotency = options.providerIdempotency ?? true;
    this.capabilities = {
      providerIdempotency: this.providerIdempotency,
      deliveryEvents: true,
      bounceEvents: true,
      complaintEvents: true,
      scheduling: false,
      ...options.capabilities,
    };
  }

  /** Make the next send throw (default: retryable timeout). */
  failNextSend(error?: Error): void {
    this.failure = error ?? new Error("ETIMEDOUT");
    this.failureAfterAccept = false;
  }

  /**
   * Make the next send accept the message internally but lose the response
   * (provider timeout after acceptance). A retry with the same message id
   * must not deliver twice.
   */
  loseNextSendResponse(): void {
    this.failure = new Error("ETIMEDOUT");
    this.failureAfterAccept = true;
  }

  async testConnection(): Promise<RelayHealth> {
    return { ok: true, detail: "fake relay always healthy" };
  }

  async send(message: PreparedMessage, context: SendContext): Promise<SendResult> {
    this.sendCalls += 1;
    if (this.providerIdempotency) {
      const known = this.acceptedByMessageId.get(message.messageId);
      if (known !== undefined) {
        return { providerMessageId: known };
      }
    }
    const failure = this.failure;
    if (failure !== null && !this.failureAfterAccept) {
      this.failure = null;
      throw failure;
    }
    this.providerCounter += 1;
    const providerMessageId = `fake-${this.type}-${this.providerCounter}`;
    this.sent.push({ message, context });
    this.acceptedByMessageId.set(message.messageId, providerMessageId);
    if (failure !== null) {
      this.failure = null;
      throw failure;
    }
    return { providerMessageId };
  }

  /** Fake relays accept pre-verified webhook payloads in tests. */
  async verifyWebhook(request: RawWebhookRequest): Promise<VerifiedWebhook> {
    try {
      return { valid: true, payload: JSON.parse(request.body) };
    } catch {
      return { valid: false, reason: "malformed fake payload" };
    }
  }

  async normalizeWebhook(event: VerifiedWebhook): Promise<NormalizedEvent[]> {
    if (!event.valid) {
      return [];
    }
    const payload = event.payload as Partial<NormalizedEvent>;
    return [
      {
        providerEventId: payload.providerEventId ?? null,
        type: payload.type ?? "unknown",
        providerMessageId: payload.providerMessageId ?? null,
        occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : new Date(),
        meta: payload.meta ?? {},
      },
    ];
  }
}

/** Deterministic clock for scheduling and backoff tests. */
export class ControlledClock {
  private currentMs: number;

  constructor(start: Date = new Date("2025-06-01T00:00:00.000Z")) {
    this.currentMs = start.getTime();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}
