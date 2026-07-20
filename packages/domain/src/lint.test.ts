import { describe, expect, it } from "vitest";
import { hasLintErrors, lintCampaign } from "./lint.js";

const base = {
  subject: "June update",
  previewText: "What we shipped",
  bodyHtml: "<p>Hello {{ first_name }}</p>",
  bodyText: "Hello {{ first_name }}",
  fromEmail: "news@example.com",
  fromName: "News",
  organizationName: "Example Inc",
  postalAddress: "1 Main St",
  knownMergeFields: ["first_name"],
};

describe("campaign lint", () => {
  it("passes a complete draft", () => {
    expect(lintCampaign(base)).toEqual([]);
  });

  it("requires compliance identity before marketing sends", () => {
    const issues = lintCampaign({ ...base, postalAddress: "" });
    expect(issues.some((i) => i.code === "missing_sender_identity" && i.severity === "error"))
      .toBe(true);
    expect(hasLintErrors(issues)).toBe(true);
  });

  it("rejects unknown merge tags", () => {
    const issues = lintCampaign({ ...base, bodyHtml: "<p>{{ frist_name }}</p>" });
    expect(issues.some((i) => i.code === "unknown_merge_tags")).toBe(true);
  });

  it("warns on insecure links without blocking", () => {
    const issues = lintCampaign({ ...base, bodyHtml: '<a href="http://x.com">x</a>' });
    expect(issues).toEqual([
      expect.objectContaining({ code: "insecure_link", severity: "warning" }),
    ]);
    expect(hasLintErrors(issues)).toBe(false);
  });
});
