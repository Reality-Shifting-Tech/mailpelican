import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DispatchApiError, type DispatchClient } from "./client.js";

const pagination = z.object({
  cursor: z.string().optional().describe("Cursor from a previous page's pageInfo.nextCursor."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size, max 200."),
});

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
  const message =
    error instanceof DispatchApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "unknown error";
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function qs(params: { cursor?: string | undefined; limit?: number | undefined }): string {
  const search = new URLSearchParams();
  if (params.cursor !== undefined) {
    search.set("cursor", params.cursor);
  }
  if (params.limit !== undefined) {
    search.set("limit", String(params.limit));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : "";
}

/**
 * The dispatch MCP surface (agent-native operation, README roadmap). Tools
 * mirror the /v1 API: full read access plus draft authoring. Sending is
 * deliberately excluded — an agent prepares, a human (or a send-scoped
 * automation with a confirmation token) confirms.
 */
export function createDispatchMcpServer(client: DispatchClient): McpServer {
  const server = new McpServer({ name: "dispatch", version: "0.1.0" });

  async function runSafely(run: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      return jsonResult(await run());
    } catch (error) {
      return errorResult(error);
    }
  }

  server.registerTool(
    "dispatch_list_lists",
    {
      description: "List audience lists (segments) in the workspace, paginated.",
      inputSchema: pagination,
    },
    (args) => runSafely(() => client.get(`/lists${qs(args)}`)),
  );

  server.registerTool(
    "dispatch_create_list",
    {
      description: "Create a new audience list.",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
      }),
    },
    (args) => runSafely(() => client.post("/lists", args)),
  );

  server.registerTool(
    "dispatch_list_contacts",
    { description: "List contacts, paginated.", inputSchema: pagination },
    (args) => runSafely(() => client.get(`/contacts${qs(args)}`)),
  );

  server.registerTool(
    "dispatch_list_campaigns",
    { description: "List campaigns with their status, paginated.", inputSchema: pagination },
    (args) => runSafely(() => client.get(`/campaigns${qs(args)}`)),
  );

  server.registerTool(
    "dispatch_get_campaign",
    {
      description: "Get one campaign with its current version and lifecycle status.",
      inputSchema: z.object({ campaignId: z.string().uuid() }),
    },
    (args) => runSafely(() => client.get(`/campaigns/${args.campaignId}`)),
  );

  server.registerTool(
    "dispatch_campaign_stats",
    {
      description: "Get send, delivery, bounce, complaint, and open/click totals for a campaign.",
      inputSchema: z.object({ campaignId: z.string().uuid() }),
    },
    (args) => runSafely(() => client.get(`/stats/campaigns/${args.campaignId}`)),
  );

  server.registerTool(
    "dispatch_list_templates",
    { description: "List templates, paginated.", inputSchema: pagination },
    (args) => runSafely(() => client.get(`/templates${qs(args)}`)),
  );

  server.registerTool(
    "dispatch_create_campaign_draft",
    {
      description:
        "Create a draft campaign against an audience list. The draft must still go " +
        "through lint → preview → prepare → confirm before it can send.",
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        subject: z.string().max(998),
        bodyHtml: z.string(),
        bodyText: z.string(),
        listId: z.string().uuid().describe("Audience list id (audienceRef)."),
        fromEmail: z.string().email(),
        fromName: z.string().max(120),
        previewText: z.string().max(998).optional(),
      }),
    },
    (args) =>
      runSafely(() => {
        const { listId, ...rest } = args;
        return client.post("/campaigns", { ...rest, audienceRef: listId });
      }),
  );

  server.registerTool(
    "dispatch_preview_campaign",
    {
      description: "Lint a campaign version and render sample messages for review.",
      inputSchema: z.object({ campaignId: z.string().uuid() }),
    },
    (args) => runSafely(() => client.post(`/campaigns/${args.campaignId}/preview`)),
  );

  return server;
}
