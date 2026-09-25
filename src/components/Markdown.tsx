// Markdown description field: rendered preview with an edit toggle.
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo, useState } from "react";

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "iframe"], FORBID_ATTR: ["style"] });
}

export function MarkdownField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [editing, setEditing] = useState(!value.trim());
  const html = useMemo(() => renderMarkdown(value), [value]);
  return (
    <div className="markdown-field">
      <div className="markdown-toolbar">
        <div className="seg">
          <button className={`seg-btn ${!editing ? "active" : ""}`} onClick={() => setEditing(false)} disabled={!value.trim()}>Preview</button>
          <button className={`seg-btn ${editing ? "active" : ""}`} onClick={() => setEditing(true)}>Edit</button>
        </div>
        <span className="muted">Markdown supported</span>
      </div>
      {editing ? (
        <textarea className="textarea mono" rows={14} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoFocus={!!value} />
      ) : (
        <div
          className="markdown-body selectable"
          onDoubleClick={() => setEditing(true)}
          onClick={(e) => {
            // Links open in the system browser, never inside the app window.
            const a = (e.target as HTMLElement).closest("a");
            if (!a) return;
            e.preventDefault();
            const href = a.getAttribute("href");
            if (href && /^https?:\/\//i.test(href)) openUrl(href).catch(() => {});
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
