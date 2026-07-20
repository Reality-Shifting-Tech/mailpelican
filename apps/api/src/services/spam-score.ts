import type { Env } from "@mailpelican/config";

export interface SpamScore {
  /** rspamd composite score; higher is spammier. */
  score: number;
  /** rspamd verdict: no action, greylist, add header, rewrite subject, reject. */
  action: string;
  /** Rules that fired, sorted by contribution. */
  symbols: { name: string; score: number; description: string | null }[];
}

interface SampleMessage {
  fromEmail: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
}

function buildMime(message: SampleMessage): string {
  const boundary = "----mailpelican-preview";
  return [
    `From: ${message.fromEmail}`,
    `To: ${message.toEmail}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    message.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "",
    message.html,
    `--${boundary}--`,
  ].join("\r\n");
}

interface RspamdResponse {
  score?: number;
  action?: string;
  symbols?: Record<string, { score?: number; description?: string }>;
}

/**
 * Score a rendered message with rspamd (open-source filter ISPs themselves
 * run), surfaced at preview time so operators see exactly which rules their
 * content trips. Returns null when rspamd is unconfigured or unreachable —
 * scoring is advisory and never blocks the send flow.
 */
export async function checkSpamScore(env: Env, message: SampleMessage): Promise<SpamScore | null> {
  if (env.RSPAMD_URL === undefined) {
    return null;
  }
  try {
    const res = await fetch(`${env.RSPAMD_URL.replace(/\/$/, "")}/checkv2`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: buildMime(message),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as RspamdResponse;
    return {
      score: body.score ?? 0,
      action: body.action ?? "unknown",
      symbols: Object.entries(body.symbols ?? {})
        .map(([name, symbol]) => ({
          name,
          score: symbol.score ?? 0,
          description: symbol.description ?? null,
        }))
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
    };
  } catch {
    return null;
  }
}
