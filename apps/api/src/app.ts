import { PROBLEM_CONTENT_TYPE, problem } from "@dispatch/contracts";
import type { ApiKeyScope } from "@dispatch/db";
import { DomainError } from "@dispatch/domain";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAuthMiddleware, requestIdMiddleware } from "./auth.js";
import type { Deps } from "./deps.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { contactRoutes } from "./routes/contacts.js";
import { healthRoutes } from "./routes/health.js";
import { listRoutes, membershipRoutes } from "./routes/lists.js";
import { observabilityRoutes } from "./routes/observability.js";
import { publicRoutes } from "./routes/public.js";
import { relayRoutes, senderIdentityRoutes } from "./routes/relays.js";
import { suppressionRoutes } from "./routes/suppressions.js";
import { templateRoutes } from "./routes/templates.js";
import { trackingRoutes } from "./routes/tracking.js";
import { webhookRoutes } from "./routes/webhooks.js";

const SEND_ACTIONS = /\/campaigns\/[^/]+\/(confirm-send|schedule|pause|resume|cancel)$/;

/**
 * Resolve the API-key scope a request needs: read for safe methods, send for
 * send-control actions, write for everything else.
 */
function scopeGuard(sendPattern?: RegExp) {
  return async (c: Context, next: Next) => {
    let scope: ApiKeyScope = c.req.method === "GET" || c.req.method === "HEAD" ? "read" : "write";
    if (sendPattern !== undefined && sendPattern.test(c.req.path)) {
      scope = "send";
    }
    const principal = c.get("principal");
    if (!principal.scopes.includes(scope)) {
      throw new HTTPException(403, { message: `Missing required scope: ${scope}.` });
    }
    await next();
  };
}

export function createApp(deps: Deps) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          problem({
            status: 400,
            detail: result.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          }),
          400,
          { "content-type": PROBLEM_CONTENT_TYPE },
        );
      }
      return undefined;
    },
  });

  app.use("*", requestIdMiddleware);
  app.route("/health", healthRoutes(deps));

  const v1 = new OpenAPIHono();
  v1.route("/public", publicRoutes(deps));
  v1.route("/webhooks", webhookRoutes(deps));
  v1.route("/track", trackingRoutes(deps));

  const secured = new OpenAPIHono();
  secured.use("*", createAuthMiddleware(deps.db));
  secured.use("/contacts/*", scopeGuard());
  secured.use("/lists/*", scopeGuard());
  secured.use("/memberships/*", scopeGuard());
  secured.use("/suppressions/*", scopeGuard());
  secured.use("/relays/*", scopeGuard());
  secured.use("/sender-identities/*", scopeGuard());
  secured.use("/templates/*", scopeGuard());
  secured.use("/campaigns/*", scopeGuard(SEND_ACTIONS));
  secured.use("/api-keys/*", scopeGuard());
  secured.use("/events", scopeGuard());
  secured.use("/stats/*", scopeGuard());
  secured.use("/audit-events", scopeGuard());
  secured.use("/webhook-deliveries/*", scopeGuard());

  secured.route("/contacts", contactRoutes(deps));
  secured.route("/lists", listRoutes(deps));
  secured.route("/memberships", membershipRoutes(deps));
  secured.route("/suppressions", suppressionRoutes(deps));
  secured.route("/relays", relayRoutes(deps));
  secured.route("/sender-identities", senderIdentityRoutes(deps));
  secured.route("/templates", templateRoutes(deps));
  secured.route("/campaigns", campaignRoutes(deps));
  secured.route("/api-keys", apiKeyRoutes(deps));
  secured.route("/", observabilityRoutes(deps));

  v1.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "dispatch API", version: "0.1.0" },
  });

  v1.route("/", secured);

  app.route("/v1", v1);

  app.notFound((c) => {
    return c.json(problem({ status: 404, detail: "Route not found." }), 404, {
      "content-type": PROBLEM_CONTENT_TYPE,
    });
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json(problem({ status: error.status, detail: error.message }), error.status, {
        "content-type": PROBLEM_CONTENT_TYPE,
      });
    }
    if (error instanceof DomainError) {
      const status = error.httpStatus as 400;
      return c.json(problem({ status, detail: error.message }), status, {
        "content-type": PROBLEM_CONTENT_TYPE,
      });
    }
    console.error("unhandled error", error);
    return c.json(problem({ status: 500 }), 500, { "content-type": PROBLEM_CONTENT_TYPE });
  });

  return app;
}
