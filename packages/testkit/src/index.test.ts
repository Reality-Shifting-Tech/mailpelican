import { describe, expect, it } from "vitest";
import { ControlledClock, FakeRelay } from "./index.js";

const baseMessage = {
  messageId: "m-1",
  fromEmail: "a@example.com",
  fromName: "A",
  replyTo: null,
  toEmail: "b@example.org",
  subject: "s",
  html: "<p>x</p>",
  text: "x",
  headers: {},
};
const context = { workspaceId: "w", relayId: "r", campaignId: "c" };

describe("FakeRelay", () => {
  it("records sends", async () => {
    const relay = new FakeRelay();
    const result = await relay.send(baseMessage, context);
    expect(result.providerMessageId).toBe("fake-ses-1");
    expect(relay.sent).toHaveLength(1);
  });

  it("dedups retries by message id when idempotent", async () => {
    const relay = new FakeRelay({ providerIdempotency: true });
    await relay.send(baseMessage, context);
    const second = await relay.send(baseMessage, context);
    expect(second.providerMessageId).toBe("fake-ses-1");
    expect(relay.sendCalls).toBe(2);
    expect(relay.sent).toHaveLength(1);
  });

  it("models a lost response after acceptance", async () => {
    const relay = new FakeRelay();
    relay.loseNextSendResponse();
    await expect(relay.send(baseMessage, context)).rejects.toThrow("ETIMEDOUT");
    const retry = await relay.send(baseMessage, context);
    expect(retry.providerMessageId).toBe("fake-ses-1");
    expect(relay.sent).toHaveLength(1);
  });

  it("fails the next send on request", async () => {
    const relay = new FakeRelay();
    relay.failNextSend();
    await expect(relay.send(baseMessage, context)).rejects.toThrow();
    expect(await relay.send(baseMessage, context)).toBeTruthy();
  });
});

describe("ControlledClock", () => {
  it("advances deterministically", () => {
    const clock = new ControlledClock();
    const before = clock.now().getTime();
    clock.advance(1500);
    expect(clock.now().getTime() - before).toBe(1500);
  });
});
