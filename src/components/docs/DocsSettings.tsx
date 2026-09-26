// Docs settings: title, version, logo, accent colour, code sample languages, linked-folder output.
import { useRef, useState } from "react";
import type { Collection } from "../../types";
import { LANGUAGES } from "../../lib/codegen";
import { DEFAULT_LANGUAGES } from "../../lib/docs/model";
import { updateDocsConfig } from "../../store";
import { Icon, IconButton, Toggle } from "../ui";

const MAX_LOGO = 512 * 1024;

export function DocsSettings({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const cfg = collection.docsConfig ?? {};
  const set = (patch: Parameters<typeof updateDocsConfig>[1]) => updateDocsConfig(collection.id, patch);
  const langs = cfg.languages?.length ? cfg.languages : DEFAULT_LANGUAGES;
  const file = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  return (
    <div className="docs-settings">
      <div className="docs-settings-head">
        <span className="setting-title">Docs settings</span>
        <IconButton icon="close" size={12} title="Close" onClick={onClose} />
      </div>
      <div className="docs-settings-grid">
        <label>Title<input className="input input-sm" value={cfg.title ?? ""} placeholder={collection.name} onChange={(e) => set({ title: e.target.value || undefined })} /></label>
        <label>Version<input className="input input-sm" value={cfg.version ?? ""} placeholder="e.g. 1.4.0" onChange={(e) => set({ version: e.target.value || undefined })} /></label>
        <label>Accent colour
          <span className="docs-color">
            <input type="color" value={cfg.accent ?? "#ff6c37"} onChange={(e) => set({ accent: e.target.value })} />
            {cfg.accent && <button className="link-btn" onClick={() => set({ accent: undefined })}>Reset</button>}
          </span>
        </label>
        <label>Logo
          <span className="docs-logo">
            {cfg.logo ? <img src={cfg.logo} alt="" /> : <span className="muted">None</span>}
            <button className="btn btn-sm" onClick={() => file.current?.click()}><Icon name="import" size={11} /> Choose…</button>
            {cfg.logo && <button className="link-btn" onClick={() => set({ logo: undefined })}>Remove</button>}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.size > MAX_LOGO) { setLogoError("Use an image under 512 KB"); return; }
              setLogoError(null);
              const r = new FileReader();
              r.onload = () => set({ logo: String(r.result) });
              r.readAsDataURL(f);
            }} />
          </span>
          {logoError && <span className="err-text">{logoError}</span>}
        </label>
      </div>
      <div className="setting-desc">Code sample languages</div>
      <div className="docs-langs">
        {LANGUAGES.map((l) => (
          <label key={l.id} className="docs-lang">
            <input type="checkbox" checked={langs.includes(l.id)} onChange={(e) => {
              const next = e.target.checked ? [...langs, l.id] : langs.filter((x) => x !== l.id);
              set({ languages: next.length ? LANGUAGES.map((x) => x.id).filter((id) => next.includes(id)) : undefined });
            }} /> {l.label}
          </label>
        ))}
      </div>
      <Toggle
        checked={!!cfg.linkedMarkdown}
        onChange={(linkedMarkdown) => set({ linkedMarkdown: linkedMarkdown || undefined })}
        label={collection.linkedPath ? "Also write Markdown docs to api-docs/ in the linked folder" : "Also write Markdown docs to api-docs/ (link the collection to a folder first)"}
      />
    </div>
  );
}
