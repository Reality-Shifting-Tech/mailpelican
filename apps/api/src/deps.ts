import type { Env } from "@dispatch/config";
import type { Database } from "@dispatch/db";
import type { ApiKeyScope } from "@dispatch/db";
import type { DnsResolver } from "@dispatch/domain";
import type { RelayProvider } from "@dispatch/relays";

/** Authenticated caller attached to every /v1 request after auth middleware. */
export interface Principal {
  workspaceId: string;
  actorType: "api_key" | "owner";
  actorId: string;
  scopes: ApiKeyScope[];
}

/**
 * External services the API depends on. Injected into the app factory so
 * health routes and tests never touch real infrastructure implicitly.
 */
export interface Deps {
  env: Env;
  db: Database;
  checkDatabase: () => Promise<void>;
  checkRedis: () => Promise<void>;
  close: () => Promise<void>;
  /** Lazily build a RelayProvider for a stored relay row. */
  createProvider: (relayId: string) => Promise<RelayProvider>;
  /** Live DNS lookups for sender-identity verification. */
  resolveDns: DnsResolver;
}
