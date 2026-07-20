import { Fragment, useCallback, useEffect, useState } from "react";
import type { Api, Campaign, CampaignStats } from "../api.js";
import { CampaignForm } from "./CampaignForm.js";
import { PreviewPanel } from "./CampaignPreview.js";

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function StatsPanel({ api, campaignId }: { api: Api; campaignId: string }) {
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .campaignStats(campaignId)
      .then((data) => {
        if (!cancelled) {
          setStats(data);
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
  if (stats === null) {
    return <p className="muted">Loading stats…</p>;
  }
  return (
    <div className="stat-grid">
      <StatCard label="Sent" value={stats.totals.sent} />
      <StatCard label="Delivered" value={stats.totals.delivered} />
      <StatCard label="Bounced" value={stats.totals.bounced} />
      <StatCard label="Complaints" value={stats.totals.complained} />
      <StatCard label="Opens" value={stats.totals.uniqueOpens} />
      <StatCard label="Clicks" value={stats.totals.uniqueClicks} />
    </div>
  );
}

export function CampaignsView({ api }: { api: Api }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<{ id: string; panel: "stats" | "preview" } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (after: string | null) => {
      setLoading(true);
      api
        .listCampaigns(after)
        .then((result) => {
          setCampaigns((prev) => (after === null ? result.data : [...prev, ...result.data]));
          setCursor(result.pageInfo.nextCursor);
          setError(null);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    },
    [api],
  );

  useEffect(() => {
    load(null);
  }, [load]);

  function toggle(id: string, panel: "stats" | "preview") {
    setExpanded((current) =>
      current !== null && current.id === id && current.panel === panel ? null : { id, panel },
    );
  }

  return (
    <section>
      <div className="row-actions">
        <button className="primary" onClick={() => setShowForm((current) => !current)}>
          {showForm ? "Close" : "New campaign"}
        </button>
      </div>
      {showForm && (
        <CampaignForm
          api={api}
          onCreated={() => {
            setShowForm(false);
            load(null);
          }}
        />
      )}
      {error !== null && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {campaigns.map((campaign) => (
            <Fragment key={campaign.id}>
              <tr>
                <td>{campaign.name}</td>
                <td>
                  <span className={`status-pill ${campaign.status}`}>{campaign.status}</span>
                </td>
                <td className="muted">{new Date(campaign.updatedAt).toLocaleString()}</td>
                <td>
                  {(campaign.status === "draft" || campaign.status === "ready") && (
                    <button className="link-button" onClick={() => toggle(campaign.id, "preview")}>
                      {expanded?.id === campaign.id && expanded.panel === "preview"
                        ? "Hide"
                        : "Preview"}
                    </button>
                  )}{" "}
                  <button className="link-button" onClick={() => toggle(campaign.id, "stats")}>
                    {expanded?.id === campaign.id && expanded.panel === "stats" ? "Hide" : "Stats"}
                  </button>
                </td>
              </tr>
              {expanded?.id === campaign.id && (
                <tr>
                  <td colSpan={4}>
                    {expanded.panel === "stats" ? (
                      <StatsPanel api={api} campaignId={campaign.id} />
                    ) : (
                      <PreviewPanel api={api} campaignId={campaign.id} />
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {campaigns.length === 0 && !loading && (
            <tr>
              <td colSpan={4} className="muted">
                No campaigns yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {cursor !== null && (
        <p>
          <button className="link-button" onClick={() => load(cursor)}>
            Load more
          </button>
        </p>
      )}
    </section>
  );
}
