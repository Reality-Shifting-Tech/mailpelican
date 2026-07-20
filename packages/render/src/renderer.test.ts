import { describe, expect, it } from "vitest";
import { designDocumentSchema } from "./design-document.js";
import { renderDesign } from "./renderer.js";

const document = designDocumentSchema.parse({
  type: "document",
  children: [
    { type: "heading", content: "Hi {{ first_name }}", align: "center" },
    { type: "text", content: "Welcome to the newsletter." },
    { type: "button", label: "Read more", href: "https://example.com/post", align: "center" },
    { type: "image", src: "https://example.com/hero.png", alt: "Hero", width: 560 },
    { type: "divider" },
  ],
});

describe("designDocumentSchema", () => {
  it("accepts a valid document and rejects unknown blocks", () => {
    expect(document.children).toHaveLength(5);
    expect(
      designDocumentSchema.safeParse({ type: "document", children: [{ type: "video" }] }).success,
    ).toBe(false);
    expect(designDocumentSchema.safeParse({ type: "document", children: [] }).success).toBe(false);
  });
});

describe("renderDesign", () => {
  it("renders email-safe HTML with every block and intact merge tags", async () => {
    const { html } = await renderDesign(document);
    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("Hi {{ first_name }}");
    expect(html).toContain('href="https://example.com/post"');
    expect(html).toContain("Read more");
    expect(html).toContain('src="https://example.com/hero.png"');
    expect(html).toContain("<hr");
    expect(html).toContain("text-align:center");
  });

  it("renders a plain-text alternative", async () => {
    const { text } = await renderDesign(document);
    expect(text).toContain("Hi {{ first_name }}");
    expect(text).toContain("Welcome to the newsletter.");
    expect(text).toContain("Read more");
    expect(text).not.toContain("<p>");
  });
});
