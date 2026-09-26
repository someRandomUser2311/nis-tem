// Markdown description field: rendered preview (docs Markdown: callouts, Mermaid…) with an edit toggle.
import { useState } from "react";
import { DocsMarkdown } from "./docs/DocsBlocks";

export function MarkdownField({ value, onChange, placeholder, anchors, onNavigate }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  /** For `#req:<id>` links (the Docs view passes its anchors). */
  anchors?: Record<string, string>; onNavigate?: (anchor: string) => void;
}) {
  const [editing, setEditing] = useState(!value.trim());
  return (
    <div className="markdown-field">
      <div className="markdown-toolbar">
        <div className="seg">
          <button className={`seg-btn ${!editing ? "active" : ""}`} onClick={() => setEditing(false)} disabled={!value.trim()}>Preview</button>
          <button className={`seg-btn ${editing ? "active" : ""}`} onClick={() => setEditing(true)}>Edit</button>
        </div>
        <span className="muted">Markdown · callouts <code>&gt; [!NOTE]</code> · <code>```mermaid</code></span>
      </div>
      {editing ? (
        <textarea className="textarea mono" rows={Math.min(24, Math.max(6, value.split("\n").length + 1))} value={value} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)} autoFocus={!!value} />
      ) : (
        <div onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          <DocsMarkdown source={value} anchors={anchors} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}
