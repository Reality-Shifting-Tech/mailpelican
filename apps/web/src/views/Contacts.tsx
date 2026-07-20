import { useCallback, useEffect, useState } from "react";
import type { Api, AudienceList, Contact, ImportSummary } from "../api.js";

function ImportForm({ api, onImported }: { api: Api; onImported: () => void }) {
  const [lists, setLists] = useState<AudienceList[]>([]);
  const [listId, setListId] = useState("");
  const [emails, setEmails] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
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

  return (
    <form
      className="campaign-form"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = emails
          .split(/[\n,;]+/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (parsed.length === 0) {
          return;
        }
        setBusy(true);
        setError(null);
        setSummary(null);
        api
          .importContacts(listId, parsed)
          .then((result) => {
            setSummary(result);
            setEmails("");
            setBusy(false);
            onImported();
          })
          .catch((err: Error) => {
            setError(err.message);
            setBusy(false);
          });
      }}
    >
      <div className="row-actions">
        <select value={listId} onChange={(event) => setListId(event.target.value)} required>
          {lists.length === 0 && <option value="">No lists — create one first</option>}
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </div>
      <textarea
        placeholder={"One email per line (or comma-separated)\nada@example.com\ngrace@example.com"}
        value={emails}
        onChange={(event) => setEmails(event.target.value)}
        rows={5}
        required
      />
      {error !== null && <p className="error">{error}</p>}
      {summary !== null && (
        <p className="muted">
          Imported {summary.created}, {summary.existing} already existed, {summary.rejected.length}{" "}
          rejected
          {summary.rejected.length > 0 &&
            ` (${summary.rejected
              .slice(0, 3)
              .map((r) => r.email)
              .join(", ")}${summary.rejected.length > 3 ? "…" : ""})`}
          .
        </p>
      )}
      <div className="row-actions">
        <button className="primary" type="submit" disabled={busy || listId === ""}>
          {busy ? "Importing…" : "Import contacts"}
        </button>
      </div>
    </form>
  );
}

export function ContactsView({ api }: { api: Api }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(
    (after: string | null) => {
      api
        .listContacts(after)
        .then((result) => {
          setContacts((prev) => (after === null ? result.data : [...prev, ...result.data]));
          setCursor(result.pageInfo.nextCursor);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    },
    [api],
  );

  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <section>
      <div className="row-actions">
        <button className="primary" onClick={() => setShowImport((current) => !current)}>
          {showImport ? "Close" : "Import contacts"}
        </button>
      </div>
      {showImport && <ImportForm api={api} onImported={() => load(null)} />}
      {error !== null && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Added</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact) => (
            <tr key={contact.id}>
              <td>{contact.emailOriginal}</td>
              <td className="muted">{new Date(contact.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {contacts.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">
                No contacts yet.
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
