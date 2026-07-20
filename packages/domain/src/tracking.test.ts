import { describe, expect, it } from "vitest";
import { injectTrackingPixel, rewriteLinks, TRACKING_PIXEL_GIF } from "./tracking.js";

describe("injectTrackingPixel", () => {
  it("places the pixel before </body> in a full document", () => {
    const out = injectTrackingPixel("<html><body><p>Hi</p></body></html>", "https://t.example/o/1");
    expect(out).toContain('<img src="https://t.example/o/1" width="1" height="1"');
    expect(out.indexOf("<img")).toBeLessThan(out.indexOf("</body>"));
  });

  it("appends to fragments", () => {
    const out = injectTrackingPixel("<p>Hi</p>", "https://t.example/o/1");
    expect(out.startsWith("<p>Hi</p>")).toBe(true);
    expect(out).toContain("<img");
  });

  it("ships a valid 1x1 GIF", () => {
    expect(TRACKING_PIXEL_GIF.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(TRACKING_PIXEL_GIF.length).toBeGreaterThan(30);
  });
});

describe("rewriteLinks", () => {
  const track = (url: string) => `https://t.example/c/1?url=${encodeURIComponent(url)}`;

  it("rewrites http(s) links and leaves other hrefs alone", () => {
    const html =
      '<a href="https://example.com/a">A</a><a href="mailto:x@y.z">M</a><a href="#s">S</a>';
    const out = rewriteLinks(html, track);
    expect(out).toContain(`href="${track("https://example.com/a")}"`);
    expect(out).toContain('href="mailto:x@y.z"');
    expect(out).toContain('href="#s"');
  });

  it("keeps links the callback declines (e.g. unsubscribe)", () => {
    const html = '<a href="https://mail.example.com/unsubscribe/abc">U</a>';
    const out = rewriteLinks(html, () => null);
    expect(out).toBe(html);
  });
});
