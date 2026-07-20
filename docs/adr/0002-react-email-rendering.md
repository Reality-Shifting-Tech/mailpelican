# ADR-0002: React Email as the template rendering foundation

- Status: Accepted
- Date: 2025-06-01

## Context

Transactional and campaign email must render consistently across clients with
radically different HTML capabilities. Hand-writing table-layout HTML is
error-prone; MJML solves the layout problem but introduces a second component
model, an XML dialect that does not type-check, and a shrinking maintenance
community.

## Decision

Adopt React Email as the rendering foundation. Templates are ordinary React
components, compiled to client-safe HTML at render time. MJML is rejected: its
abstraction duplicates what React components already give us (composition,
props, type-checking) while adding a build step we do not control.

Implemented in `@dispatch/render`: editors author a typed `design-v1` JSON
document (heading/text/button/image/divider blocks); `POST
/v1/templates/:id/versions` validates it and compiles HTML + plain-text
artifacts onto the immutable version, so lint, preview, and the send pipeline
consume rendered output unchanged. Merge tags pass through the renderer
untouched and are substituted per recipient at send time.

## Consequences

Template authors write TypeScript and get compiler-checked props and preview
tooling for free. We accept the responsibility of curating email-safe
component primitives, which MJML would have provided out of the box.
