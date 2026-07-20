export type MembershipState = "pending" | "subscribed" | "unsubscribed";

export type ExclusionReason = "not_subscribed" | "pending" | "unsubscribed" | "suppressed";

export interface SendabilityInput {
  /** Current per-list membership state, or null when no membership exists. */
  membershipState: MembershipState | null;
  /** True when the email is on the workspace-global suppression list. */
  suppressed: boolean;
}

export type Sendability = { ok: true } | { ok: false; reason: ExclusionReason };

/**
 * Decide whether a contact may receive a marketing message right now.
 * Suppression is workspace-global and overrides list membership
 * (architecture §4); an unsubscribe always wins over an audience snapshot
 * taken earlier (architecture §6 step 7). Pending (unconfirmed) contacts
 * never receive marketing mail.
 */
export function decideSendability(input: SendabilityInput): Sendability {
  if (input.suppressed) {
    return { ok: false, reason: "suppressed" };
  }
  if (input.membershipState === null) {
    return { ok: false, reason: "not_subscribed" };
  }
  if (input.membershipState === "pending") {
    return { ok: false, reason: "pending" };
  }
  if (input.membershipState === "unsubscribed") {
    return { ok: false, reason: "unsubscribed" };
  }
  return { ok: true };
}

/** Normalize an email address for storage and comparison. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Structural email validation; deliberately simple, deliverability decides. */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email.trim()) && email.length <= 320;
}
