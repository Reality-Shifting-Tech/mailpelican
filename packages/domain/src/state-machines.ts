import { InvalidTransitionError } from "./errors.js";

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

export type CampaignStatus = (typeof campaignStatuses)[number];

const campaignTransitions: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ["ready", "cancelled"],
  ready: ["draft", "scheduled", "preparing", "cancelled"],
  scheduled: ["preparing", "cancelled"],
  preparing: ["sending", "failed", "cancelled"],
  sending: ["paused", "completed", "failed", "cancelled"],
  paused: ["sending", "cancelled"],
  completed: [],
  cancelled: [],
  failed: [],
};

const editableCampaignStatuses: ReadonlySet<CampaignStatus> = new Set(["draft", "ready"]);

export function canCampaignTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return campaignTransitions[from].includes(to);
}

/**
 * Validate a campaign transition. Persistence layers must still perform the
 * transition as a compare-and-set update; this check is the domain rule.
 */
export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (!canCampaignTransition(from, to)) {
    throw new InvalidTransitionError("campaign", from, to);
  }
}

/** Only draft and ready campaigns may be edited (architecture §5). */
export function isCampaignEditable(status: CampaignStatus): boolean {
  return editableCampaignStatuses.has(status);
}

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

export type RecipientStatus = (typeof recipientStatuses)[number];

const recipientTransitions: Readonly<Record<RecipientStatus, readonly RecipientStatus[]>> = {
  included: ["queued", "excluded", "suppressed", "unsubscribed", "cancelled"],
  queued: ["sending", "suppressed", "unsubscribed", "failed", "cancelled"],
  sending: ["accepted", "failed", "bounced", "complained", "suppressed", "unsubscribed"],
  accepted: ["delivered", "bounced", "complained", "failed"],
  delivered: ["bounced", "complained"],
  excluded: [],
  suppressed: [],
  unsubscribed: [],
  failed: [],
  bounced: [],
  complained: [],
  cancelled: [],
};

/** Terminal recipient states mirror onto message rows when feedback arrives. */
const terminalRecipientStatuses: ReadonlySet<RecipientStatus> = new Set([
  "delivered",
  "excluded",
  "suppressed",
  "unsubscribed",
  "failed",
  "bounced",
  "complained",
  "cancelled",
]);

export function canRecipientTransition(from: RecipientStatus, to: RecipientStatus): boolean {
  return recipientTransitions[from].includes(to);
}

export function assertRecipientTransition(from: RecipientStatus, to: RecipientStatus): void {
  if (!canRecipientTransition(from, to)) {
    throw new InvalidTransitionError("campaign recipient", from, to);
  }
}

export function isRecipientTerminal(status: RecipientStatus): boolean {
  return terminalRecipientStatuses.has(status);
}
