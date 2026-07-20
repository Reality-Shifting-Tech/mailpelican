import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createTestContext, type TestContext } from "./test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

function json(method: string, path: string, body?: unknown) {
  return ctx.app.request(path, {
    method,
    headers: { ...auth(ctx), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("template versions", () => {
  it("keeps M1 behavior for plain subject/body versions", async () => {
    const template = (await (await json("POST", "/v1/templates", { name: "plain" })).json()) as {
      id: string;
    };
    const res = await json("POST", `/v1/templates/${template.id}/versions`, {
      subject: "Hello",
      bodyHtml: "<p>Hi {{ first_name }}</p>",
      bodyText: "Hi {{ first_name }}",
    });
    expect(res.status).toBe(201);
    const version = (await res.json()) as {
      editorSchemaVersion: string;
      bodyHtml: string;
      designJson: unknown;
    };
    expect(version.editorSchemaVersion).toBe("m1-simple");
    expect(version.bodyHtml).toBe("<p>Hi {{ first_name }}</p>");
    expect(version.designJson).toBeNull();
  });

  it("renders a design document into html/text artifacts at authoring time", async () => {
    const template = (await (await json("POST", "/v1/templates", { name: "designed" })).json()) as {
      id: string;
    };
    const res = await json("POST", `/v1/templates/${template.id}/versions`, {
      subject: "News",
      designJson: {
        type: "document",
        children: [
          { type: "heading", content: "Hi {{ first_name }}" },
          { type: "text", content: "Something happened." },
          { type: "button", label: "Read", href: "https://example.com/a" },
        ],
      },
    });
    expect(res.status).toBe(201);
    const version = (await res.json()) as {
      editorSchemaVersion: string;
      bodyHtml: string;
      bodyText: string;
    };
    expect(version.editorSchemaVersion).toBe("design-v1");
    expect(version.bodyHtml).toContain("<!DOCTYPE html");
    expect(version.bodyHtml).toContain("Hi {{ first_name }}");
    expect(version.bodyHtml).toContain('href="https://example.com/a"');
    expect(version.bodyText).toContain("Something happened.");
  });

  it("rejects an invalid design document with 400", async () => {
    const template = (await (await json("POST", "/v1/templates", { name: "broken" })).json()) as {
      id: string;
    };
    const res = await json("POST", `/v1/templates/${template.id}/versions`, {
      subject: "News",
      designJson: { type: "document", children: [{ type: "video", src: "x" }] },
    });
    expect(res.status).toBe(400);
  });
});
