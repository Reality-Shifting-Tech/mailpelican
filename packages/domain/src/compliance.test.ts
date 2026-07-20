import { describe, expect, it } from "vitest";
import { appendFooter } from "./compliance.js";

describe("appendFooter", () => {
  it("appends to a fragment without a body tag", () => {
    expect(appendFooter("<p>Hi</p>", "<div>footer</div>")).toBe("<p>Hi</p><div>footer</div>");
  });

  it("inserts before </body> in a full document", () => {
    const result = appendFooter("<html><body><p>Hi</p></body></html>", "<div>footer</div>");
    expect(result).toBe("<html><body><p>Hi</p><div>footer</div></body></html>");
  });

  it("matches the closing tag case-insensitively", () => {
    const result = appendFooter("<BODY>Hi</BODY>", "F");
    expect(result).toBe("<BODY>HiF</BODY>");
  });
});
