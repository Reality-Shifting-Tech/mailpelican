import { z } from "zod";

const urlSchema = z.string().url();

const secretSchema = (minLength: number) =>
  z.string().min(minLength, `must be at least ${minLength} characters`);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: urlSchema,
  PUBLIC_URL: urlSchema,
  TRACKING_URL: urlSchema,
  DATABASE_URL: z.string().startsWith("postgres", "must be a PostgreSQL connection URL"),
  REDIS_URL: z.string().startsWith("redis", "must be a Redis connection URL"),
  CREDENTIAL_ENCRYPTION_KEY: secretSchema(32),
  SESSION_SECRET: secretSchema(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Optional rspamd HTTP endpoint for pre-send spam scoring (off when unset). */
  RSPAMD_URL: urlSchema.optional(),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    const lines = issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Parse and validate process environment. Fails fast with a ConfigError that
 * lists every invalid variable; call once at process bootstrap.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }
  return result.data;
}
