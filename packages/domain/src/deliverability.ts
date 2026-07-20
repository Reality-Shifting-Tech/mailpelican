import type { DnsResolver } from "./dns-verification.js";

export interface DeliverabilityCheck {
  name: "spf" | "dmarc" | "mx" | "ptr" | "blocklist";
  ok: boolean;
  detail: string;
}

export interface DeliverabilityReport {
  ok: boolean;
  checks: DeliverabilityCheck[];
}

/** Spamhaus ZEN combined blocklist zone; any answer means listed. */
const BLOCKLIST_ZONE = "zen.spamhaus.org";

function reverseIpv4(ip: string): string {
  return ip.split(".").reverse().join(".");
}

/**
 * Deliverability preflight for a sending domain and (optionally) the IP it
 * sends from — the checks the "just add DNS records" claim leaves out.
 * Authentication (SPF/DMARC) is only part of the picture: mailbox providers
 * also expect MX, forward-confirmed reverse DNS on the sending IP, and an IP
 * that is not on a blocklist. Pure by injection so tests run offline.
 */
export async function checkDeliverability(
  input: { domain: string; ip?: string | undefined },
  resolve: DnsResolver,
): Promise<DeliverabilityReport> {
  const checks: DeliverabilityCheck[] = [];

  const spf = await resolve(input.domain, "TXT").catch(() => [] as string[]);
  const hasSpf = spf.some((value) => value.startsWith("v=spf1"));
  checks.push({
    name: "spf",
    ok: hasSpf,
    detail: hasSpf ? "SPF record present." : `No SPF record at ${input.domain}.`,
  });

  const dmarc = await resolve(`_dmarc.${input.domain}`, "TXT").catch(() => [] as string[]);
  const hasDmarc = dmarc.some((value) => value.includes("v=DMARC1"));
  checks.push({
    name: "dmarc",
    ok: hasDmarc,
    detail: hasDmarc ? "DMARC record present." : `No DMARC record at _dmarc.${input.domain}.`,
  });

  const mx = await resolve(input.domain, "MX").catch(() => [] as string[]);
  checks.push({
    name: "mx",
    ok: mx.length > 0,
    detail:
      mx.length > 0
        ? `MX: ${mx.join(", ")}.`
        : `No MX records at ${input.domain}; bounces have nowhere to go.`,
  });

  if (input.ip !== undefined) {
    const ptrNames = await resolve(`${reverseIpv4(input.ip)}.in-addr.arpa`, "PTR").catch(
      () => [] as string[],
    );
    const ptr = ptrNames[0];
    let ptrOk = false;
    let ptrDetail = `No PTR record for ${input.ip}; set reverse DNS with your host.`;
    if (ptr !== undefined) {
      const forward = await resolve(ptr, "A").catch(() => [] as string[]);
      ptrOk = forward.includes(input.ip);
      ptrDetail = ptrOk
        ? `PTR ${ptr} forward-confirms ${input.ip}.`
        : `PTR ${ptr} does not resolve back to ${input.ip} (FCrDNS fails).`;
    }
    checks.push({ name: "ptr", ok: ptrOk, detail: ptrDetail });

    const listed = await resolve(`${reverseIpv4(input.ip)}.${BLOCKLIST_ZONE}`, "A").catch(
      () => [] as string[],
    );
    checks.push({
      name: "blocklist",
      ok: listed.length === 0,
      detail:
        listed.length === 0
          ? `${input.ip} is not on the Spamhaus ZEN blocklist.`
          : `${input.ip} is LISTED on Spamhaus ZEN (${listed.join(", ")}); expect spam foldering.`,
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
