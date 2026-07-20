import { appendFooter } from "./compliance.js";

/** 1×1 transparent GIF served by the open-tracking endpoint. */
export const TRACKING_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function pixelTag(pixelUrl: string): string {
  return `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;border:0">`;
}

/** Insert the open-tracking pixel inside `</body>` (or append for fragments). */
export function injectTrackingPixel(html: string, pixelUrl: string): string {
  return appendFooter(html, pixelTag(pixelUrl));
}

/**
 * Rewrite every trackable `href` in an HTML body through `makeUrl`, which
 * returns the tracking redirect URL — or null to leave the link untouched
 * (mailto:, anchors, unsubscribe links). Regex-based by design: the input is
 * renderer- or operator-produced HTML, not arbitrary user markup.
 */
export function rewriteLinks(html: string, makeUrl: (url: string) => string | null): string {
  return html.replace(/href="([^"]*)"/g, (match, url: string) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return match;
    }
    const tracked = makeUrl(url);
    return tracked === null ? match : `href="${tracked}"`;
  });
}
