export interface DnsRecordExpectation {
  type: string;
  name: string;
  value: string;
}

export interface DnsRecordResult {
  record: DnsRecordExpectation;
  found: boolean;
  actual: string[];
}

/** DNS record types the platform looks up. */
export type DnsRecordType = "TXT" | "CNAME" | "A" | "MX" | "PTR";

/** Resolve a DNS name to record values; empty when the name has none. */
export type DnsResolver = (name: string, recordType: DnsRecordType) => Promise<string[]>;

/**
 * Value placed in provider-specific records (DKIM) until the relay driver
 * supplies real keys; unverifiable by definition, so skipped by checks.
 */
export const DNS_VALUE_PENDING = "dkim.pending";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * True when any actual record satisfies the expectation. SPF and DMARC are
 * presence checks on the policy marker (operators merge includes into one
 * SPF record, so exact equality would be wrong); anything else compares
 * case-insensitively with trailing-dot tolerance.
 */
function matches(expected: string, actual: string[]): boolean {
  if (expected.startsWith("v=spf1")) {
    return actual.some((value) => value.startsWith("v=spf1"));
  }
  if (expected.includes("v=DMARC1")) {
    return actual.some((value) => value.includes("v=DMARC1"));
  }
  const wanted = normalize(expected);
  return actual.some((value) => normalize(value) === wanted);
}

/**
 * Check an identity's expected DNS records against live DNS. Records whose
 * value is still the provider-pending placeholder are reported as skipped
 * (found = true) — there is nothing meaningful to look up yet.
 */
export async function checkDnsRecords(
  records: DnsRecordExpectation[],
  resolve: DnsResolver,
): Promise<{ ok: boolean; results: DnsRecordResult[] }> {
  const results: DnsRecordResult[] = [];
  for (const record of records) {
    if (record.value === DNS_VALUE_PENDING) {
      results.push({ record, found: true, actual: [] });
      continue;
    }
    const type = record.type === "CNAME" ? "CNAME" : "TXT";
    const actual = await resolve(record.name, type).catch(() => [] as string[]);
    results.push({ record, found: matches(record.value, actual), actual });
  }
  return { ok: results.every((result) => result.found), results };
}
