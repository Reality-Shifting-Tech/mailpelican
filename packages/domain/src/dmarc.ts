import { XMLParser } from "fast-xml-parser";
import { DomainError } from "./errors.js";

export interface DmarcPolicy {
  domain: string;
  p: string;
  sp: string | null;
  adkim: string | null;
  aspf: string | null;
  pct: number | null;
}

export interface DmarcRecord {
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  headerFrom: string;
}

export interface DmarcAggregateReport {
  orgName: string;
  reportId: string;
  policy: DmarcPolicy;
  dateBegin: Date;
  dateEnd: Date;
  records: DmarcRecord[];
}

interface RawReport {
  feedback?: {
    report_metadata?: {
      org_name?: string;
      report_id?: string;
      date_range?: { begin?: number | string; end?: number | string };
    };
    policy_published?: {
      domain?: string;
      adkim?: string;
      aspf?: string;
      p?: string;
      sp?: string;
      pct?: number | string;
    };
    record?: RawRecord | RawRecord[];
  };
}

interface RawRecord {
  row?: {
    source_ip?: string;
    count?: number | string;
    policy_evaluated?: { disposition?: string; dkim?: string; spf?: string };
  };
  identifiers?: { header_from?: string };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function epoch(value: number | string | undefined, field: string): Date {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new DomainError("invalid_dmarc_report", `DMARC report has no valid ${field}.`, 400);
  }
  return new Date(seconds * 1000);
}

/**
 * Parse a DMARC aggregate (rua) report — the free daily telemetry mailbox
 * providers send every domain owner (RFC 7489). Strict on the envelope
 * (org, dates, at least one record), lenient on optional policy fields.
 */
export function parseDmarcAggregate(xml: string): DmarcAggregateReport {
  let parsed: RawReport;
  try {
    parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(
      xml,
    ) as RawReport;
  } catch {
    throw new DomainError("invalid_dmarc_report", "DMARC report is not well-formed XML.", 400);
  }
  const feedback = parsed.feedback;
  const meta = feedback?.report_metadata;
  const policy = feedback?.policy_published;
  if (feedback === undefined || meta === undefined || policy?.domain === undefined) {
    throw new DomainError(
      "invalid_dmarc_report",
      "XML is not a DMARC aggregate report (missing feedback metadata).",
      400,
    );
  }
  const records = asArray(feedback.record).map((record) => {
    const row = record.row;
    const evaluated = row?.policy_evaluated;
    return {
      sourceIp: row?.source_ip ?? "unknown",
      count: Number(row?.count ?? 0),
      disposition: evaluated?.disposition ?? "none",
      dkim: evaluated?.dkim ?? "unknown",
      spf: evaluated?.spf ?? "unknown",
      headerFrom: record.identifiers?.header_from ?? "",
    };
  });
  if (records.length === 0) {
    throw new DomainError("invalid_dmarc_report", "DMARC report contains no records.", 400);
  }
  const pct = Number(policy.pct);
  return {
    orgName: meta.org_name ?? "unknown",
    reportId: meta.report_id ?? "",
    policy: {
      domain: policy.domain,
      p: policy.p ?? "none",
      sp: policy.sp ?? null,
      adkim: policy.adkim ?? null,
      aspf: policy.aspf ?? null,
      pct: Number.isFinite(pct) ? pct : null,
    },
    dateBegin: epoch(meta.date_range?.begin, "begin date"),
    dateEnd: epoch(meta.date_range?.end, "end date"),
    records,
  };
}
