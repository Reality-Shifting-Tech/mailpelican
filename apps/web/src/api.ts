const KEY_STORAGE = "dispatch.apiKey";

export interface Page<T> {
  data: T[];
  pageInfo: { nextCursor: string | null; hasNextPage: boolean };
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AudienceList {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Contact {
  id: string;
  emailOriginal: string;
  createdAt: string;
}

export interface CampaignStats {
  messages: Record<string, number>;
  recipients: Record<string, number>;
  events: Record<string, number>;
  totals: {
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    uniqueOpens: number;
    uniqueClicks: number;
  };
}

export interface LintIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface CampaignPreview {
  lint: LintIssue[];
  samples: { email: string; subject: string; html: string; text: string }[];
  recipientCounts: Record<string, number>;
  spam: SpamScore | null;
}

export interface CampaignDraftInput {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  audienceRef: string;
  fromEmail: string;
  fromName: string;
  previewText?: string;
}

export interface PreparedCampaign {
  campaignId: string;
  campaignVersionId: string;
  included: number;
  excluded: number;
  audienceHash: string;
  confirmationToken: string;
  expiresAt: string;
  approvalRequired: boolean;
}

export interface ImportSummary {
  created: number;
  existing: number;
  rejected: { email: string; reason: string }[];
}

export interface DeliverabilityReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface SpamScore {
  score: number;
  action: string;
  symbols: { name: string; score: number; description: string | null }[];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
  }
}

export function loadApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function storeApiKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

export function createApi(getKey: () => string | null, onUnauthorized: () => void) {
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${getKey() ?? ""}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) {
      clearApiKey();
      onUnauthorized();
      throw new ApiError(401, "API key rejected.");
    }
    const parsed: unknown = await res.json();
    if (!res.ok) {
      const detail =
        typeof parsed === "object" && parsed !== null && "detail" in parsed
          ? String((parsed as { detail: unknown }).detail)
          : `Request failed (${res.status}).`;
      throw new ApiError(res.status, detail);
    }
    return parsed as T;
  }

  function page(path: string, cursor: string | null): string {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor !== null) {
      params.set("cursor", cursor);
    }
    return `${path}?${params.toString()}`;
  }

  return {
    listCampaigns: (cursor: string | null) =>
      call<Page<Campaign>>("GET", page("/v1/campaigns", cursor)),
    campaignStats: (id: string) => call<CampaignStats>("GET", `/v1/stats/campaigns/${id}`),
    createCampaign: (input: CampaignDraftInput) => call<Campaign>("POST", "/v1/campaigns", input),
    previewCampaign: (id: string) => call<CampaignPreview>("POST", `/v1/campaigns/${id}/preview`),
    prepareCampaign: (id: string) => call<PreparedCampaign>("POST", `/v1/campaigns/${id}/prepare`),
    confirmSend: (id: string, confirmationToken: string, approved: boolean) =>
      call<{ recipientCount: number }>(
        "POST",
        `/v1/campaigns/${id}/confirm-send`,
        { confirmationToken, approved },
        { "idempotency-key": crypto.randomUUID() },
      ),
    listLists: (cursor: string | null) =>
      call<Page<AudienceList>>("GET", page("/v1/lists", cursor)),
    createList: (name: string, description: string) =>
      call<AudienceList>("POST", "/v1/lists", { name, description }),
    listContacts: (cursor: string | null) =>
      call<Page<Contact>>("GET", page("/v1/contacts", cursor)),
    importContacts: (listId: string, emails: string[]) =>
      call<ImportSummary>(
        "POST",
        "/v1/contacts/import",
        { listId, source: "console", contacts: emails.map((email) => ({ email })) },
        { "idempotency-key": crypto.randomUUID() },
      ),
    checkDeliverability: (domain: string, ip: string) => {
      const params = new URLSearchParams({ domain });
      if (ip.length > 0) {
        params.set("ip", ip);
      }
      return call<DeliverabilityReport>("GET", `/v1/deliverability/check?${params.toString()}`);
    },
  };
}

export type Api = ReturnType<typeof createApi>;
