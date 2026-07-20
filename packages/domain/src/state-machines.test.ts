import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "./errors.js";
import {
  assertCampaignTransition,
  assertRecipientTransition,
  canCampaignTransition,
  isCampaignEditable,
  isRecipientTerminal,
} from "./state-machines.js";

describe("campaign state machine", () => {
  it("follows the documented happy path", () => {
    const path = ["draft", "ready", "scheduled", "preparing", "sending", "completed"] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      if (from !== undefined && to !== undefined) {
        expect(() => assertCampaignTransition(from, to)).not.toThrow();
      }
    }
  });

  it("supports pause and resume", () => {
    expect(canCampaignTransition("sending", "paused")).toBe(true);
    expect(canCampaignTransition("paused", "sending")).toBe(true);
  });

  it("rejects transitions out of terminal states with a 409-mapped error", () => {
    try {
      assertCampaignTransition("completed", "sending");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).httpStatus).toBe(409);
    }
  });

  it("allows editing only in draft and ready", () => {
    expect(isCampaignEditable("draft")).toBe(true);
    expect(isCampaignEditable("ready")).toBe(true);
    expect(isCampaignEditable("sending")).toBe(false);
  });
});

describe("recipient state machine", () => {
  it("walks included to delivered", () => {
    assertRecipientTransition("included", "queued");
    assertRecipientTransition("queued", "sending");
    assertRecipientTransition("sending", "accepted");
    assertRecipientTransition("accepted", "delivered");
  });

  it("treats post-delivery feedback as the only legal exit from delivered", () => {
    assertRecipientTransition("delivered", "bounced");
    assertRecipientTransition("delivered", "complained");
    expect(() => assertRecipientTransition("delivered", "sending")).toThrow(
      InvalidTransitionError,
    );
  });

  it("marks exclusion states terminal", () => {
    expect(isRecipientTerminal("suppressed")).toBe(true);
    expect(isRecipientTerminal("included")).toBe(false);
  });
});
