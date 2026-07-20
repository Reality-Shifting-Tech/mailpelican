import { useState } from "react";
import type { Api, DeliverabilityReport } from "../api.js";

export function DeliverabilityView({ api }: { api: Api }) {
  const [domain, setDomain] = useState("");
  const [ip, setIp] = useState("");
  const [report, setReport] = useState<DeliverabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section>
      <p className="muted">
        Preflight a sending domain and the IP it sends from: SPF, DMARC, MX, reverse DNS, and the
        Spamhaus blocklist.
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
