import { useEffect, useState } from "react";
import type { Api, CampaignPreview } from "../api.js";

export function PreviewPanel({ api, campaignId }: { api: Api; campaignId: string }) {
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewCampaign(campaignId)
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, campaignId]);

  if (error !== null) {
    return <p className="error">{error}</p>;
  }
  if (preview === null) {
    return <p className="muted">Loading preview…</p>;
  }
  const errors = preview.lint.filter((issue) => issue.severity === "error");
  const warnings = preview.lint.filter((issue) => issue.severity === "warning");
  const sample = preview.samples[0];
  return (
    <div className="preview-panel">
      <p className={errors.length > 0 ? "error" : "muted"}>
        Lint: {errors.length} errors, {warnings.length} warnings
        {Object.entries(preview.recipientCounts)
          .map(([status, count]) => ` · ${status}: ${count}`)
          .join("")}
      </p>
      {preview.lint.length > 0 && (
        <ul className="lint-list">
          {preview.lint.map((issue) => (
            <li key={issue.code} className={issue.severity === "error" ? "error" : "muted"}>
              [{issue.severity}] {issue.message}
            </li>
          ))}
        </ul>
      )}
      {sample !== undefined && (
        <div>
          <p className="muted">
            Sample for {sample.email} — {sample.subject}
          </p>
          <iframe className="preview-frame" sandbox="" title="Sample render" srcDoc={sample.html} />
        </div>
      )}
    </div>
  );
}
