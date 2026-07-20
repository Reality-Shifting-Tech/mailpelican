export interface DispatchClientOptions {
  /** Base URL of the dispatch API, e.g. http://localhost:3000. */
  apiUrl: string;
  /** Scoped API key (dk_...). */
  apiKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class DispatchApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`dispatch API ${status}: ${detail}`);
    this.name = "DispatchApiError";
    this.status = status;
  }
}

export interface DispatchClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body?: unknown, idempotencyKey?: string) => Promise<unknown>;
}

/** Thin authenticated client for the /v1 REST surface. */
export function createDispatchClient(options: DispatchClientOptions): DispatchClient {
  const base = `${options.apiUrl.replace(/\/$/, "")}/v1`;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call(method: string, path: string, body?: unknown, idempotencyKey?: string) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        ...(idempotencyKey !== undefined ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail =
        typeof parsed === "object" && parsed !== null && "detail" in parsed
          ? String((parsed as { detail: unknown }).detail)
          : text;
      throw new DispatchApiError(res.status, detail);
    }
    return parsed;
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body, idempotencyKey) => call("POST", path, body, idempotencyKey),
  };
}
