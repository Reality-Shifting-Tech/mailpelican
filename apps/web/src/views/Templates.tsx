import { useCallback, useEffect, useState } from "react";
import type { Api, DesignBlock, Template, TemplateVersion } from "../api.js";

type Align = "left" | "center" | "right";

function AlignSelect({ value, onChange }: { value: Align; onChange: (a: Align) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Align)}>
      <option value="left">left</option>
      <option value="center">center</option>
      <option value="right">right</option>
    </select>
  );
}

function BlockEditor({
  block,
  onChange,
  onMove,
  onRemove,
  first,
  last,
}: {
  block: DesignBlock;
  onChange: (b: DesignBlock) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  first: boolean;
  last: boolean;
}) {
  return (
    <div className="block-row">
      <span className="block-type">{block.type}</span>
      {block.type === "heading" && (
        <>
          <input
            placeholder="Heading text"
            value={block.content}
            onChange={(e) => onChange({ ...block, content: e.target.value })}
          />
          <AlignSelect
            value={block.align ?? "left"}
            onChange={(align) => onChange({ ...block, align })}
          />
        </>
      )}
      {block.type === "text" && (
        <>
          <input
            placeholder="Paragraph text ({{ first_name }} works)"
            value={block.content}
            onChange={(e) => onChange({ ...block, content: e.target.value })}
          />
          <AlignSelect
            value={block.align ?? "left"}
            onChange={(align) => onChange({ ...block, align })}
          />
        </>
      )}
      {block.type === "button" && (
        <>
          <input
            placeholder="Label"
            value={block.label}
            onChange={(e) => onChange({ ...block, label: e.target.value })}
          />
          <input
            placeholder="https://…"
            value={block.href}
            onChange={(e) => onChange({ ...block, href: e.target.value })}
          />
          <AlignSelect
            value={block.align ?? "left"}
            onChange={(align) => onChange({ ...block, align })}
          />
        </>
      )}
      {block.type === "image" && (
        <>
          <input
            placeholder="Image URL"
            value={block.src}
            onChange={(e) => onChange({ ...block, src: e.target.value })}
          />
          <input
            placeholder="Alt text"
            value={block.alt}
            onChange={(e) => onChange({ ...block, alt: e.target.value })}
          />
        </>
      )}
      {block.type === "divider" && <span className="muted">horizontal rule</span>}
      <span className="block-actions">
        <button className="link-button" disabled={first} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button className="link-button" disabled={last} onClick={() => onMove(1)}>
          ↓
        </button>
        <button className="link-button" onClick={onRemove}>
          ✕
        </button>
      </span>
    </div>
  );
}

const STARTER: DesignBlock[] = [
  { type: "heading", content: "Hi {{ first_name }}", align: "left" },
  { type: "text", content: "Write your message here.", align: "left" },
];

export function TemplatesView({ api }: { api: Api }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [newName, setNewName] = useState("");
  const [subject, setSubject] = useState("");
  const [blocks, setBlocks] = useState<DesignBlock[]>(STARTER);
  const [saved, setSaved] = useState<TemplateVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listTemplates(null)
      .then((page) => {
        setTemplates(page.data);
        setSelectedId((current) => current ?? page.data[0]?.id ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (selectedId === null) {
      setVersions([]);
      return;
    }
    api
      .listTemplateVersions(selectedId)
      .then(setVersions)
      .catch((err: Error) => setError(err.message));
  }, [api, selectedId]);

  function updateBlock(index: number, block: DesignBlock) {
    setBlocks((current) => current.map((b, i) => (i === index ? block : b)));
  }

  function moveBlock(index: number, dir: -1 | 1) {
    setBlocks((current) => {
      const next = [...current];
      const target = index + dir;
      const [item] = next.splice(index, 1);
      if (item !== undefined) {
        next.splice(target, 0, item);
      }
      return next;
    });
  }

  function addBlock(block: DesignBlock) {
    setBlocks((current) => [...current, block]);
  }

  return (
    <section>
      <div className="row-actions">
        <select value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value)}>
          {templates.length === 0 && <option value="">No templates yet</option>}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          placeholder="New template name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          className="primary"
          disabled={newName.trim().length === 0}
          onClick={() => {
            api
              .createTemplate(newName.trim())
              .then((t) => {
                setNewName("");
                load();
                setSelectedId(t.id);
              })
              .catch((err: Error) => setError(err.message));
          }}
        >
          Create template
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
      {selectedId !== null && (
        <>
          <p className="muted">
            {versions.length} version{versions.length === 1 ? "" : "s"} — newest: v
            {versions[0]?.version ?? 0}
          </p>
          <div className="campaign-form">
            <div className="row-actions">
              <input
                placeholder="Subject line"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            {blocks.map((block, index) => (
              <BlockEditor
                key={index}
                block={block}
                first={index === 0}
                last={index === blocks.length - 1}
                onChange={(b) => updateBlock(index, b)}
                onMove={(dir) => moveBlock(index, dir)}
                onRemove={() => setBlocks((current) => current.filter((_, i) => i !== index))}
              />
            ))}
            <div className="row-actions">
              <button
                className="link-button"
                onClick={() => addBlock({ type: "heading", content: "", align: "left" })}
              >
                + Heading
              </button>
              <button
                className="link-button"
                onClick={() => addBlock({ type: "text", content: "", align: "left" })}
              >
                + Text
              </button>
              <button
                className="link-button"
                onClick={() => addBlock({ type: "button", label: "", href: "", align: "center" })}
              >
                + Button
              </button>
              <button
                className="link-button"
                onClick={() => addBlock({ type: "image", src: "", alt: "" })}
              >
                + Image
              </button>
              <button className="link-button" onClick={() => addBlock({ type: "divider" })}>
                + Divider
              </button>
            </div>
            <div className="row-actions">
              <button
                className="primary"
                disabled={busy || blocks.length === 0}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  api
                    .createTemplateVersion(selectedId, subject, blocks)
                    .then((version) => {
                      setSaved(version);
                      setBusy(false);
                      api
                        .listTemplateVersions(selectedId)
                        .then(setVersions)
                        .catch(() => {});
                    })
                    .catch((err: Error) => {
                      setError(err.message);
                      setBusy(false);
                    });
                }}
              >
                {busy ? "Rendering…" : "Save & render version"}
              </button>
            </div>
          </div>
          {saved !== null && (
            <div>
              <p className="muted">
                v{saved.version} rendered ({saved.editorSchemaVersion}) — {saved.bodyText.length}{" "}
                chars of plain text
              </p>
              <iframe
                className="preview-frame"
                sandbox=""
                title="Template render"
                srcDoc={saved.bodyHtml}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
