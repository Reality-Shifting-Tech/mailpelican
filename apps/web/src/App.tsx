import { useMemo, useState } from "react";
import { createApi, loadApiKey, storeApiKey, clearApiKey } from "./api.js";
import { CampaignsView } from "./views/Campaigns.js";
import { ContactsView } from "./views/Contacts.js";
import { DeliverabilityView } from "./views/Deliverability.js";
import { ListsView } from "./views/Lists.js";

type Tab = "campaigns" | "lists" | "contacts" | "deliverability";

function KeyGate({ onKey }: { onKey: (key: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <main className="key-gate">
      <h1>dispatch</h1>
      <p className="muted">Paste an API key (dk_...) to open the control surface.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim().length > 0) {
            onKey(value.trim());
          }
        }}
      >
        <input
          type="password"
          placeholder="dk_..."
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
        <button className="primary" type="submit">
          Connect
        </button>
      </form>
    </main>
  );
}

export function App() {
  const [apiKey, setApiKey] = useState<string | null>(() => loadApiKey());
  const [tab, setTab] = useState<Tab>("campaigns");
  const api = useMemo(
    () =>
      createApi(
        () => loadApiKey(),
        () => setApiKey(null),
      ),
    [],
  );

  if (apiKey === null) {
    return (
      <KeyGate
        onKey={(key) => {
          storeApiKey(key);
          setApiKey(key);
        }}
      />
    );
  }

  return (
    <main className="shell">
      <header className="shell-header">
        <h1>dispatch</h1>
        <nav className="tabs">
          {(["campaigns", "lists", "contacts", "deliverability"] as const).map((name) => (
            <button
              key={name}
              className={tab === name ? "active" : ""}
              onClick={() => setTab(name)}
            >
              {name[0]?.toUpperCase()}
              {name.slice(1)}
            </button>
          ))}
          <button
            onClick={() => {
              clearApiKey();
              setApiKey(null);
            }}
          >
            Sign out
          </button>
        </nav>
      </header>
      {tab === "campaigns" && <CampaignsView api={api} />}
      {tab === "lists" && <ListsView api={api} />}
      {tab === "contacts" && <ContactsView api={api} />}
      {tab === "deliverability" && <DeliverabilityView api={api} />}
    </main>
  );
}
