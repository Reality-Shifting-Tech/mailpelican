import { findUnknownMergeTags } from "./merge-tags.js";

export interface LintIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface CampaignLintInput {
  subject: string;
  previewText: string;
  bodyHtml: string;
  bodyText: string;
  fromEmail: string;
  fromName: string;
  /** Workspace compliance identity, required before any marketing send. */
  organizationName: string;
  postalAddress: string;
  /** Merge fields available on contacts (custom field keys plus defaults). */
  knownMergeFields: readonly string[];
}

/**
 * Lint a campaign draft on save and at preview time (architecture §6 step 1).
 * Errors block prepare; warnings are reported but non-blocking.
 */
export function lintCampaign(input: CampaignLintInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (code: string, severity: "error" | "warning", message: string) => {
    issues.push({ code, severity, message });
  };

  if (input.subject.trim().length === 0) {
    push("missing_subject", "error", "Subject is required.");
  }
  if (input.previewText.trim().length === 0) {
    push("missing_preview_text", "warning", "Preview text improves inbox presentation.");
  }
  if (input.bodyHtml.trim().length === 0 && input.bodyText.trim().length === 0) {
    push("missing_body", "error", "A message body is required.");
  }
  if (input.fromEmail.trim().length === 0) {
    push("missing_from_email", "error", "A from address is required.");
  }
  if (input.organizationName.trim().length === 0 || input.postalAddress.trim().length === 0) {
    push(
      "missing_sender_identity",
      "error",
      "Organization name and postal address are required before marketing sends.",
    );
  }

  for (const [field, template] of [
    ["subject", input.subject],
    ["body_html", input.bodyHtml],
    ["body_text", input.bodyText],
  ] as const) {
    const unknown = findUnknownMergeTags(template, input.knownMergeFields);
    if (unknown.length > 0) {
      push("unknown_merge_tags", "error", `Unknown merge tags in ${field}: ${unknown.join(", ")}.`);
    }
  }

  if (/http:\/\//.test(input.bodyHtml)) {
    push("insecure_link", "warning", "Body contains insecure http:// links.");
  }

  return issues;
}

/** True when the lint result contains at least one error-severity issue. */
export function hasLintErrors(issues: readonly LintIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
