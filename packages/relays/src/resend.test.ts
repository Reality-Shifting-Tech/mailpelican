import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ResendRelay, ResendSendError } from "./resend.js";
import type { PreparedMessage } from "./types.js";

const message: PreparedMessage = {
  messageId: "018e0f5e-0000-7000-8000-000000000002",
  fromEmail: "news@example.com",
  fromName: "News",
  replyTo: "support@example.com",
  toEmail: "user@example.org",
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
  headers: { "List-Unsubscribe": "<https://example.com/unsub/abc>" },
};

const context = { workspaceId: "w", relayId: "r", campaignId: "c" };

const secretRaw = Buffer.from("test-secret-key-material").toString("base64");
const webhookSecret = `whsec_${secretRaw}`;

function signRequest(body: string, id = "msg_123", timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", Buffer.from(secretRaw, "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  return {
    headers: {
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${signature}`,
    },
    body,
  };
}

describe("ResendRelay.send", () => {
  it("sends through the SDK surface and returns the provider id", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "re_1" }, error: null });
    const relay = new ResendRelay({ emails: { send }, domains: { list: vi.fn() } }, webhookSecret);
    const result = await relay.send(message, context);
    expect(result.providerMessageId).toBe("re_1");
    const input = send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.headers).toEqual(message.headers);
    expect(input.replyTo).toBe("support@example.com");
  });

  it("throws a classified error on provider rejection", async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "bad from" },
    });
    const relay = new ResendRelay({ emails: { send }, domains: { list: vi.fn() } }, webhookSecret);
    await expect(relay.send(message, context)).rejects.toBeInstanceOf(ResendSendError);
  });
});

describe("ResendRelay webhooks", () => {
  const body = JSON.stringify({
    type: "email.delivered",
    created_at: "2025-06-01T00:00:00.000Z",
    data: { email_id: "re_1" },
  });

  it("verifies a correctly signed webhook", async () => {
    const relay = new ResendRelay(
      { emails: { send: vi.fn() }, domains: { list: vi.fn() } },
      webhookSecret,
    );
    const result = await relay.verifyWebhook(signRequest(body));
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const relay = new ResendRelay(
      { emails: { send: vi.fn() }, domains: { list: vi.fn() } },
      webhookSecret,
    );
    const signed = signRequest(body);
    const result = await relay.verifyWebhook({
      ...signed,
      body: body.replace("delivered", "bounced"),
    });
    expect(result.valid).toBe(false);
  });

  it("rejects stale timestamps", async () => {
    const relay = new ResendRelay(
      { emails: { send: vi.fn() }, domains: { list: vi.fn() } },
      webhookSecret,
    );
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const result = await relay.verifyWebhook(signRequest(body, "msg_1", stale));
    expect(result).toEqual({ valid: false, reason: "svix timestamp outside tolerance" });
  });

  it("normalizes events using the svix id for dedup", async () => {
    const relay = new ResendRelay(
      { emails: { send: vi.fn() }, domains: { list: vi.fn() } },
      webhookSecret,
    );
    const verified = await relay.verifyWebhook(signRequest(body));
    const events = await relay.normalizeWebhook(verified);
    expect(events[0]).toMatchObject({
      providerEventId: "msg_123",
      type: "delivered",
      providerMessageId: "re_1",
    });
  });
});
