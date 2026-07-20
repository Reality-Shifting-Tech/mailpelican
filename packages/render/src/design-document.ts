import { z } from "zod";

/**
 * The editor-neutral design document stored in `template_versions.design_json`
 * (ADR-0002). A typed block tree the future editor writes and the renderer
 * maps to React Email components; `editor_schema_version` `design-v1`.
 */

const align = z.enum(["left", "center", "right"]);

export const headingBlock = z.object({
  type: z.literal("heading"),
  content: z.string().min(1),
  align: align.optional(),
});

export const textBlock = z.object({
  type: z.literal("text"),
  content: z.string().min(1),
  align: align.optional(),
});

export const buttonBlock = z.object({
  type: z.literal("button"),
  label: z.string().min(1),
  href: z.string().min(1),
  align: align.optional(),
});

export const imageBlock = z.object({
  type: z.literal("image"),
  src: z.string().url(),
  alt: z.string().default(""),
  width: z.number().int().min(1).max(1200).optional(),
});

export const dividerBlock = z.object({
  type: z.literal("divider"),
});

export const designBlock = z.discriminatedUnion("type", [
  headingBlock,
  textBlock,
  buttonBlock,
  imageBlock,
  dividerBlock,
]);

export const designDocumentSchema = z.object({
  type: z.literal("document"),
  children: z.array(designBlock).min(1),
});

export type DesignBlock = z.infer<typeof designBlock>;
export type DesignDocument = z.infer<typeof designDocumentSchema>;

/** Schema version written to `editor_schema_version` for design-authored rows. */
export const DESIGN_SCHEMA_VERSION = "design-v1";
