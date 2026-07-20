import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  findUnknownMergeTags,
  parseMergeTags,
  renderMergeTags,
} from "./merge-tags.js";

describe("merge tags", () => {
  it("parses distinct sorted tag names", () => {
    expect(parseMergeTags("Hi {{ first_name }}, from {{company}} to {{ first_name }}")).toEqual([
      "company",
      "first_name",
    ]);
  });

  it("escapes HTML values on render", () => {
    const out = renderMergeTags(
      "<p>Hello {{ name }}</p>",
      { name: '<script>alert("x")</script>' },
      { escape: true },
    );
    expect(out).toBe("<p>Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  });

  it("renders plain text without escaping", () => {
    expect(renderMergeTags("Hi {{ name }}", { name: "A & B" }, { escape: false })).toBe(
      "Hi A & B",
    );
  });

  it("leaves unknown tags literal for lint to catch", () => {
    expect(renderMergeTags("Hi {{ typo }}", {}, { escape: true })).toBe("Hi {{ typo }}");
    expect(findUnknownMergeTags("Hi {{ typo }} {{ first_name }}", ["first_name"])).toEqual([
      "typo",
    ]);
  });

  it("treats reserved tags as known", () => {
    expect(findUnknownMergeTags('<a href="{{unsubscribe_url}}">unsub</a>', [])).toEqual([]);
  });

  it("escapes every HTML-sensitive character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
