/**
 * Bootstrap a first workspace plus owner API key. Run once after migrations:
 *
 *   pnpm --filter @dispatch/api bootstrap "My Workspace" "My Org" "1 Main St"
 *
 * The raw key is printed exactly once; only its hash is stored.
 */
import { loadEnv } from "@dispatch/config";
import { apiKeys, closeDb, createDb, workspaces } from "@dispatch/db";
import { eq } from "drizzle-orm";
import { issueApiKey } from "./routes/api-keys.js";

const [name, organizationName, postalAddress] = process.argv.slice(2);
if (name === undefined || organizationName === undefined || postalAddress === undefined) {
  console.error("usage: bootstrap <workspace-name> <organization-name> <postal-address>");
  process.exit(1);
}

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

const slug = name
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "-")
  .replaceAll(/(^-|-$)/g, "");

const inserted = await db
  .insert(workspaces)
  .values({ name, slug, organizationName, postalAddress })
  .onConflictDoNothing()
  .returning();
const workspace =
  inserted[0] ?? (await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1))[0];
if (workspace === undefined) {
  console.error("workspace insert failed");
  await closeDb(db);
  process.exit(1);
}
if (inserted[0] === undefined) {
  console.log(`workspace already exists: ${workspace.id} (${workspace.slug})`);
  await closeDb(db);
  process.exit(0);
}

const issued = issueApiKey();
await db.insert(apiKeys).values({
  workspaceId: workspace.id,
  name: "owner",
  prefix: issued.prefix,
  secretHash: issued.secretHash,
  scopes: ["read", "write", "send"],
});

console.log(`workspace: ${workspace.id} (${workspace.slug})`);
console.log(`owner api key (store it now): ${issued.raw}`);
await closeDb(db);
