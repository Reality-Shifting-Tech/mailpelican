export interface ComplianceIdentity {
  organizationName: string;
  postalAddress: string;
}

/**
 * Visible unsubscribe footer required on every marketing message
 * (architecture §10). Appended at send time so no template can omit it.
 */
export function buildComplianceFooter(
  identity: ComplianceIdentity,
  unsubscribeUrl: string,
): { html: string; text: string } {
  const html = [
    '<div style="margin-top:24px;padding-top:12px;font-size:12px;color:#666">',
    `<p>${identity.organizationName} · ${identity.postalAddress}</p>`,
    `<p><a href="${unsubscribeUrl}">Unsubscribe</a> from these emails.</p>`,
    "</div>",
  ].join("");
  const text = [
    "",
    "---",
    `${identity.organizationName} · ${identity.postalAddress}`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");
  return { html, text };
}

/** RFC 8058 headers for one-click unsubscribe from mail clients. */
export function buildListUnsubscribeHeaders(
  unsubscribeUrl: string,
  oneClickUrl: string,
): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>, <${oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
