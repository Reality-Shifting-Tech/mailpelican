import { loadEnv } from "@dispatch/config";
import { apiKeys, contacts, uuidv7, workspaces } from "@dispatch/db";
import { createTestDb } from "@dispatch/db/testing";
import type { Database } from "@dispatch/db";
import { FakeRelay } from "@dispatch/testkit";
import type { RelayProvider } from "@dispatch/relays";
import type { Env } from "@dispatch/config";
import { issueApiKey } from "./routes/api-keys.js";
import { createApp } from "./app.js";
import type { Deps } from "./deps.js";

export interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Database;
  workspaceId: string;
  rawKey: string;
  providers: Map<string, RelayProvider & { sent?: unknown[] }>;
  fakeRelay: FakeRelay;
  deps: Deps;
  close: () => Promise<void>;
}

export function testEnv(): Env {
  return loadEnv({
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    PUBLIC_URL: "https://mail.example.com",
    TRACKING_URL: "https://track.example.com",
    DATABASE_URL: "postgres://localhost/dispatch",
    REDIS_URL: "redis://localhost:6379",
    CREDENTIAL_ENCRYPTION_KEY: "a".repeat(32),
    SESSION_SECRET: "b".repeat(32),
  });
}

export interface SeedOptions {
  scopes?: ("read" | "write" | "send")[];
  sendLimit?: number;
  approvalThreshold?: number;
}

/** Create an isolated app: PGlite database, one workspace, one API key. */
export async function createTestContext(options: SeedOptions = {}): Promise<TestContext> {
  const { db, close } = await createTestDb();
  const workspaceId = uuidv7();
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "Test",
    slug: `test-${workspaceId.slice(0, 8)}`,
    organizationName: "Test Inc",
    postalAddress: "1 Main St, Springfield",
  });
  const issued = issueApiKey();
  await db.insert(apiKeys).values({
    workspaceId,
    name: "test",
    prefix: issued.prefix,
    secretHash: issued.secretHash,
    scopes: options.scopes ?? ["read", "write", "send"],
    sendLimit: options.sendLimit ?? null,
    approvalThreshold: options.approvalThreshold ?? null,
  });
  const providers = new Map<string, RelayProvider & { sent?: unknown[] }>();
  const fakeRelay = new FakeRelay({ providerIdempotency: true });
  const env = testEnv();
  const deps: Deps = {
    env,
    db,
    checkDatabase: async () => {},
    checkRedis: async () => {},
    close,
    createProvider: async (relayId) => {
      const existing = providers.get(relayId);
      if (existing !== undefined) {
        return existing;
      }
      providers.set(relayId, fakeRelay);
      return fakeRelay;
    },
    // DNS always verifies in tests unless a test installs its own resolver.
    resolveDns: async (name) =>
      name.startsWith("_dmarc.") ? ["v=DMARC1; p=quarantine"] : ["v=spf1 include:test ~all"],
  };
  return {
    app: createApp(deps),
    db,
    workspaceId,
    rawKey: issued.raw,
    providers,
    fakeRelay,
    deps,
    close,
  };
}

export function auth(ctx: TestContext, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${ctx.rawKey}`, ...extra };
}

/** Seed a subscribed contact directly, bypassing HTTP. */
export async function seedContact(
  ctx: TestContext,
  email: string,
  customFields: Record<string, string> = {},
): Promise<string> {
  const id = uuidv7();
  await ctx.db.insert(contacts).values({
    id,
    workspaceId: ctx.workspaceId,
    emailNormalized: email.toLowerCase(),
    emailOriginal: email,
    customFields,
  });
  return id;
}
