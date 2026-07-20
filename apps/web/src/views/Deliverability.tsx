import { useEffect, useState } from "react";
import type { Api, DeliverabilityReport, DmarcStats, Relay } from "../api.js";

function PreflightSection({ api }: { api: Api }) {
  const [domain, setDomain] = useState("");
  const [ip, setIp] = useState("");
  const [report, setReport] = useState<DeliverabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section>
      <h3>Preflight</h3>
      <p className="muted">
        SPF, DMARC, MX, reverse DNS, and the Spamhaus blocklist for a sending domain and IP.
      </p>
      <form
        className="row-actions"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          api
            .checkDeliverability(domain.trim(), ip.trim())
            .then((result) => {
              setReport(result);
              setBusy(false);
            })
            .catch((err: Error) => {
              setError(err.message);
              setBusy(false);
            });
        }}
      >
        <input
          placeholder="example.com"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          required
        />
        <input
          placeholder="Sending IP (optional)"
          value={ip}
          onChange={(event) => setIp(event.target.value)}
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Run checks"}
        </button>
      </form>
      {error !== null && <p className="error">{error}</p>}
      {report !== null && (
        <>
          <p className={report.ok ? "muted" : "error"}>
            {report.ok
              ? "All checks pass — this setup should reach the inbox."
              : "Some checks failed — fix these before sending."}
          </p>
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.name}>
                  <td>{check.name}</td>
                  <td>
                    <span className={`status-pill ${check.ok ? "completed" : "failed"}`}>
                      {check.ok ? "pass" : "fail"}
                    </span>
                  </td>
                  <td className="muted">{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function DmarcSection({ api }: { api: Api }) {
  const [xml, setXml] = useState("");
  const [domain, setDomain] = useState("");
  const [stats, setStats] = useState<DmarcStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadStats(target: string) {
    if (target.length === 0) {
      return;
    }
    api
      .dmarcStats(target)
      .then(setStats)
      .catch((err: Error) => setError(err.message));
  }

  return (
    <section>
      <h3>DMARC reports</h3>
      <p className="muted">
        Paste an aggregate (rua) report from your dmarc@ inbox; stats aggregate per domain.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          api
            .ingestDmarcReport(xml)
            .then((result) => {
              setNotice(result.stored ? "Report stored." : "Duplicate — already stored.");
              setXml("");
              loadStats(domain);
            })
            .catch((err: Error) => setError(err.message));
        }}
      >
        <textarea
          placeholder="<feedback>…</feedback>"
          value={xml}
          onChange={(event) => setXml(event.target.value)}
          rows={5}
          required
        />
        <div className="row-actions">
          <button className="primary" type="submit" disabled={xml.trim().length === 0}>
            Ingest report
          </button>
        </div>
      </form>
      {notice !== null && <p className="muted">{notice}</p>}
      <form
        className="row-actions"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          loadStats(domain.trim());
        }}
      >
        <input
          placeholder="Domain for stats"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          required
        />
        <button className="primary" type="submit">
          Load stats
        </button>
      </form>
      {error !== null && <p className="error">{error}</p>}
      {stats !== null && (
        <>
          <p className="muted">
            {stats.reports} reports · {stats.messages} messages
            {stats.latestReport !== null && ` · latest from ${stats.latestReport.orgName}`}
          </p>
          <table>
            <thead>
              <tr>
                <th>Disposition</th>
                <th>SPF</th>
                <th>DKIM</th>
                <th>Top sources</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  {Object.entries(stats.dispositions)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ") || "—"}
                </td>
                <td>
                  {Object.entries(stats.spf)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ") || "—"}
                </td>
                <td>
                  {Object.entries(stats.dkim)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ") || "—"}
                </td>
                <td>
                  {stats.topSources
                    .slice(0, 3)
                    .map((s) => `${s.ip} (${s.count})`)
                    .join(", ") || "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function WarmupSection({ api }: { api: Api }) {
  const [relays, setRelays] = useState<Relay[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listRelays(null)
      .then((page) => setRelays(page.data))
      .catch((err: Error) => setError(err.message));
  }, [api]);

  return (
    <section>
      <h3>Relays & IP warmup</h3>
      {error !== null && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Relay</th>
            <th>Status</th>
            <th>Warmup</th>
            <th>Today's cap</th>
          </tr>
        </thead>
        <tbody>
          {relays.map((relay) => (
            <tr key={relay.id}>
              <td>
                {relay.name} <span className="muted">({relay.type})</span>
              </td>
              <td>
                <span className={`status-pill ${relay.status}`}>{relay.status}</span>
              </td>
              <td className="muted">
                {relay.warmupDays !== null
                  ? `${relay.warmupDays}-day ramp, started ${
                      relay.warmupStartedAt !== null
                        ? new Date(relay.warmupStartedAt).toLocaleDateString()
                        : "—"
                    }`
                  : "off"}
              </td>
              <td>
                {relay.currentWarmupDailyCap !== null ? (
                  <strong>{relay.currentWarmupDailyCap}/day</strong>
                ) : (
                  <span className="muted">uncapped</span>
                )}
              </td>
            </tr>
          ))}
          {relays.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No relays configured.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export function DeliverabilityView({ api }: { api: Api }) {
  return (
    <>
      <PreflightSection api={api} />
      <DmarcSection api={api} />
      <WarmupSection api={api} />
    </>
  );
}
