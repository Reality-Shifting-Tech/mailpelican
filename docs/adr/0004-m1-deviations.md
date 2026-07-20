# ADR-0004: M1 deviations from the architecture contract

- Status: Accepted
- Date: 2025-06-02

## Context

M1 ("first safe send") implements the architecture contract
(`mvp-technical-architecture.md`). Four deliberate deviations were needed to
keep the milestone shippable without compromising any send-safety invariant.

## Decisions

1. **Unsubscribe tokens are per-message and not single-use.**
   §10 says tokens are "single-use where appropriate". Unsubscribing is
   idempotent, and a single-use link would break legitimate second clicks
   (mail scanner prefetch, user retry). We mint one hashed token per message;
   each stays valid until its own expiry. Double opt-in confirmation tokens
   remain strictly single-use.

2. **Session auth deferred; API keys are the M1 auth surface.**
   §4 describes owner sessions and API keys. M0 shipped no user/session
   tables and M1 adds none: all `/v1` routes authenticate scoped API keys
   (`dk_<prefix>.<secret>`, SHA-256 stored). A `pnpm --filter @dispatch/api
bootstrap` command creates the first workspace + owner key. Argon2id
   sessions land with the web UI milestone. Audit attribution works fully via
   `actor_type = api_key`.

3. **Message id equals campaign recipient id.**
   §4 makes the message id "the logical send idempotency key". We use the
   recipient row id directly, so audience-snapshot uniqueness
   (`UNIQUE(campaign_id, contact_id)`) and message uniqueness share one key
   and re-runs of message creation are conflict-free by construction.

4. **Render artifacts and live DNS verification deferred.**
   `template_render_artifacts` (§4) as a separate table remains deferred; the
   `@dispatch/render` pipeline (ADR-0002) compiles `design_json` to HTML/text
   inline on the immutable template version at authoring time, and campaign
   versions carry the complete message definition inline. Sender
   identity verification is an explicit operator action (`POST
/sender-identities/:id/verify`) returning placeholder DNS records; live
   SPF/DKIM/DMARC checks land with the onboarding UI. `approval_threshold` on
   API keys is enforced at confirm-send and schedule: above it the caller
   must re-confirm with `approved: true` (`send_limit` remains a hard cap).

## Consequences

No deviation weakens consent, suppression, immutable content, idempotency, or
audit guarantees. All four items have explicit upgrade paths tracked for
M2–M4.
