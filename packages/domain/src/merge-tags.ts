/**
 * Merge tags use the `{{ field_name }}` syntax. Tag values are always
 * escaped for the target context (HTML or plain text) at render time
 * (architecture §7). Reserved tags are supplied by the platform, not by
 * contact data.
 */
export const MERGE_TAG_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

/** Reserved tags the send pipeline always provides. */
export const RESERVED_MERGE_TAGS = ["unsubscribe_url", "sender_address"] as const;

export type MergeFields = Readonly<Record<string, string>>;

/** Extract every distinct merge-tag name referenced by a template. */
export function parseMergeTags(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(MERGE_TAG_PATTERN)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Find merge-tag names in `template` that are neither known contact fields
 * nor reserved platform tags. Lint treats unknown tags as errors because a
 * misspelled tag would otherwise ship literal braces to every recipient.
 */
export function findUnknownMergeTags(template: string, knownFields: readonly string[]): string[] {
  const known = new Set<string>([...knownFields, ...RESERVED_MERGE_TAGS]);
  return parseMergeTags(template).filter((name) => !known.has(name));
}

/** Escape a value for interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Substitute merge tags with per-recipient values. Values are HTML-escaped
 * unless `escape` is false (plain-text bodies). Unknown tags are left
 * untouched; linting, not rendering, owns that decision.
 */
export function renderMergeTags(
  template: string,
  fields: MergeFields,
  options: { escape: boolean },
): string {
  return template.replace(MERGE_TAG_PATTERN, (original, name: string) => {
    const value = fields[name];
    if (value === undefined) {
      return original;
    }
    return options.escape ? escapeHtml(value) : value;
  });
}
