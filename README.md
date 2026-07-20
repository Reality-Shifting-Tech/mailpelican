# dispatch 📨

> The open-source, self-hostable, agent-native email marketing platform.

![Status: early development](https://img.shields.io/badge/status-early%20development-orange)

dispatch is an AGPL-3.0 Mailchimp alternative designed from the ground up for
self-hosters and for AI agents as first-class operators. It is currently at
milestone **M1**: the first safe send. The `/v1` API covers contacts, lists,
consent, suppressions, relays (SES v2, Resend, SMTP), sender identities,
templates, campaigns (lint → preview → prepare → confirmation token → send),
provider webhook inbox, RFC 8058 one-click unsubscribe, stats, and audit
events. The worker runs the outbox-backed send pipeline with per-dispatch
consent rechecks and bounce/complaint auto-pause.

## Quickstart

Prerequisites: Node 24 (>= 22 works locally), pnpm 10, Docker.

```bash
# Start PostgreSQL and Redis
docker compose -f docker/docker-compose.yml up -d postgres redis

# Configure the environment (see packages/config for the full schema)
export APP_URL=http://localhost:3000 \
       PUBLIC_URL=http://localhost:3000 \
       TRACKING_URL=http://localhost:3000 \
       DATABASE_URL=postgres://dispatch:dispatch@localhost:5432/dispatch \
       REDIS_URL=redis://localhost:6379 \
       CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32) \
       SESSION_SECRET=$(openssl rand -hex 32)

pnpm install
pnpm build
pnpm --filter @dispatch/db migrate   # apply database migrations
pnpm --filter @dispatch/api bootstrap "My Workspace" "My Org Inc" "1 Main St"
pnpm dev                             # api on :3000, web on :5173, worker
```

The bootstrap command prints the owner API key exactly once; store it. All
`/v1` calls authenticate with `Authorization: Bearer dk_...`.

Tests run without Docker (PGlite in-process PostgreSQL). The
Testcontainers-based suite runs additionally when a Docker daemon is present
and `DISPATCH_DOCKER_TESTS=1` is set.

A full all-in-one container (API + worker + web static bundle) is available via
`docker compose -f docker/docker-compose.yml up --build app`. The image runs
`pnpm build` internally, so no local build artifacts are required.

## Repository layout

```
apps/
  api/        Hono REST API under /v1, OpenAPI, API-key auth, public routes
  web/        Vite + React 19 control surface (stub)
  worker/     BullMQ worker: send pipeline, webhook normalization, scheduler
packages/
  config/     Zod-validated environment configuration, fail-fast
  db/         Drizzle ORM schema, migrations, repositories (PostgreSQL 16)
  domain/     State machines, consent decisions, tokens, merge tags, retry
  contracts/  API conventions: RFC 9457 problem details, cursor pagination
  relays/     RelayProvider contract + SES v2 / Resend / SMTP drivers
  queue/      Job contracts, outbox dispatcher, rate limiters
  testkit/    Fake relay, controlled clock
docker/       docker-compose for local dev and the all-in-one image
docs/adr/     Architecture decision records
```

## Use with AI agents

dispatch is being built agent-native: every operation the UI exposes will also
be reachable by automation. A first-class MCP server is planned for an upcoming
milestone; watch this space.

## Documentation

- [Architecture decision records](docs/adr/)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

[AGPL-3.0](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
