import { problemDetailsSchema } from "@dispatch/contracts";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { PROBLEM_CONTENT_TYPE, problem } from "@dispatch/contracts";

/** OpenAPI sub-app with problem-details validation errors (RFC 9457). */
export function createRouter() {
  return new OpenAPIHono({
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
}

export const idParamSchema = z.object({ id: z.string().uuid() });

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Loose JSON response for entity payloads; keeps OpenAPI honest but lean. */
export const dataSchema = z.record(z.string(), z.unknown());

export const dataPageSchema = z.object({
  data: z.array(dataSchema),
  pageInfo: z.object({
    nextCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  }),
});

export function jsonOk(schema: z.ZodType, description: string) {
  return {
    200: {
      content: { "application/json": { schema } },
      description,
    },
  };
}

export function jsonCreated(schema: z.ZodType, description: string) {
  return {
    201: {
      content: { "application/json": { schema } },
      description,
    },
  };
}

/** Problem-details error responses shared by every route. */
export function problemResponses(...statuses: number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        content: { "application/problem+json": { schema: problemDetailsSchema } },
        description: "Error.",
      },
    ]),
  );
}

export const emailSchema = z.string().email().max(320);

export const customFieldsSchema = z.record(z.string(), z.string());
