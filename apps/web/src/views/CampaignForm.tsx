import { useEffect, useState } from "react";
import type { Api, AudienceList } from "../api.js";

const EMPTY = {
  name: "",
  subject: "",
  fromEmail: "",
  fromName: "",
  bodyHtml: "",
  bodyText: "",
};

export function CampaignForm({ api, onCreated }: { api: Api; onCreated: () => void }) {
  const [lists, setLists] = useState<AudienceList[]>([]);
  const [listId, setListId] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listLists(null)
      .then((page) => {
        setLists(page.data);
        setListId((current) => current || (page.data[0]?.id ?? ""));
      })
      .catch((err: Error) => setError(err.message));
  }, [api]);

  function set(field: keyof typeof EMPTY) {
    return (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [field]: event.target.value }));
  }

  return (
    <form
      className="campaign-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        api
          .createCampaign({ ...form, audienceRef: listId })
          .then(() => {
            setForm(EMPTY);
            setBusy(false);
            onCreated();
          })
          .catch((err: Error) => {
            setError(err.message);
            setBusy(false);
          });
      }}
    >
      <div className="row-actions">
        <input placeholder="Campaign name" value={form.name} onChange={set("name")} required />
        <select value={listId} onChange={(event) => setListId(event.target.value)} required>
          {lists.length === 0 && <option value="">No lists — create one first</option>}
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row-actions">
        <input placeholder="Subject" value={form.subject} onChange={set("subject")} required />
        <input placeholder="From name" value={form.fromName} onChange={set("fromName")} required />
        <input
          placeholder="From email"
          type="email"
          value={form.fromEmail}
          onChange={set("fromEmail")}
          required
        />
      </div>
      <textarea
        placeholder="Body HTML"
        value={form.bodyHtml}
        onChange={set("bodyHtml")}
        rows={4}
        required
      />
      <textarea
        placeholder="Body text"
        value={form.bodyText}
        onChange={set("bodyText")}
        rows={3}
        required
      />
      {error !== null && <p className="error">{error}</p>}
      <div className="row-actions">
        <button className="primary" type="submit" disabled={busy || listId === ""}>
          {busy ? "Creating…" : "Create draft"}
        </button>
      </div>
    </form>
  );
}
