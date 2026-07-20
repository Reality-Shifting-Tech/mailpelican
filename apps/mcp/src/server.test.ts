import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "@dispatch/api/src/test-utils.js";
import { createDispatchClient } from "./client.js";
import { createDispatchMcpServer } from "./server.js";

/**
 * End-to-end: MCP client → in-memory transport → dispatch MCP server →
 * fetch → the real Hono app on PGlite. No stdio, no network.
 */

let ctx: TestContext;
let client: Client;

beforeAll(async () => {
  ctx = await createTestContext();
  const fetchImpl = ((url: string | URL, init?: RequestInit) =>
    ctx.app.request(String(url), init)) as typeof fetch;
  const server = createDispatchMcpServer(
    createDispatchClient({ apiUrl: "http://test.local", apiKey: ctx.rawKey, fetchImpl }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await ctx.close();
});

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

describe("dispatch MCP server", () => {
  it("exposes the curated tool surface", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("dispatch_list_lists");
    expect(names).toContain("dispatch_create_campaign_draft");
    expect(names).toContain("dispatch_campaign_stats");
    expect(names).not.toContain("dispatch_send_campaign");
  });

  it("creates and lists resources through the real API", async () => {
    const created = await client.callTool({
      name: "dispatch_create_list",
      arguments: { name: "mcp-list", description: "created via MCP" },
    });
    expect(created.isError).toBeFalsy();
    const list = JSON.parse(textOf(created)) as { id: string; name: string };
    expect(list.name).toBe("mcp-list");

    const listed = await client.callTool({
      name: "dispatch_list_lists",
      arguments: { limit: 10 },
    });
    const page = JSON.parse(textOf(listed)) as { data: { name: string }[] };
    expect(page.data.some((l) => l.name === "mcp-list")).toBe(true);
  });

  it("authors a draft campaign and previews it", async () => {
    const listed = await client.callTool({ name: "dispatch_list_lists", arguments: {} });
    const page = JSON.parse(textOf(listed)) as { data: { id: string }[] };
    const listId = page.data[0]?.id ?? "";

    const created = await client.callTool({
      name: "dispatch_create_campaign_draft",
      arguments: {
        name: "mcp-campaign",
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
        bodyText: "Hi",
        listId,
        fromEmail: "news@example.com",
        fromName: "News",
      },
    });
    expect(created.isError).toBeFalsy();
    const campaign = JSON.parse(textOf(created)) as { id: string; status: string };
    expect(campaign.status).toBe("draft");

    const preview = await client.callTool({
      name: "dispatch_preview_campaign",
      arguments: { campaignId: campaign.id },
    });
    expect(preview.isError).toBeFalsy();
    const rendered = JSON.parse(textOf(preview)) as { lint: unknown[] };
    expect(Array.isArray(rendered.lint)).toBe(true);
  });

  it("surfaces API problem details as tool errors", async () => {
    const result = await client.callTool({
      name: "dispatch_campaign_stats",
      arguments: { campaignId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("404");
  });
});
