// Docs details for one parameter / header / form field: required, type, format, allowed values…
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ParamDoc, ParamType } from "../../types";

const TYPES: ParamType[] = ["string", "integer", "number", "boolean", "array", "object"];

/** Drop empty fields so untouched rows don't carry `doc: {}`. */
function clean(d: ParamDoc): ParamDoc | undefined {
  const out: ParamDoc = {};
  if (d.required) out.required = true;
  if (d.type) out.type = d.type;
  if (d.format?.trim()) out.format = d.format.trim();
  if (d.enum?.length) out.enum = d.enum;
  if (d.default?.trim()) out.default = d.default;
  if (d.example?.trim()) out.example = d.example;
  if (d.deprecated) out.deprecated = true;
  return Object.keys(out).length ? out : undefined;
}

export function ParamDocPopover({ anchor, name, doc, onChange, onClose }: {
  anchor: HTMLElement; name: string; doc: ParamDoc | undefined; onChange: (d: ParamDoc | undefined) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [enumText, setEnumText] = useState((doc?.enum ?? []).join(", "));
  const d = doc ?? {};
  const set = (patch: Partial<ParamDoc>) => onChange(clean({ ...d, ...patch }));

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 300, h = ref.current?.offsetHeight ?? 320;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const top = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="param-doc-pop" style={pos} role="dialog" aria-label={`Docs for ${name || "field"}`}>
      <div className="param-doc-title">Docs · <span className="mono">{name || "(unnamed)"}</span></div>
      <label className="param-doc-check"><input type="checkbox" checked={!!d.required} onChange={(e) => set({ required: e.target.checked })} /> Required</label>
      <div className="param-doc-grid">
        <label>Type
          <select className="select select-sm" value={d.type ?? ""} onChange={(e) => set({ type: (e.target.value || undefined) as ParamType | undefined })}>
            <option value="">—</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>Format
          <input className="input input-sm" list="param-formats" value={d.format ?? ""} onChange={(e) => set({ format: e.target.value })} placeholder="e.g. uuid" />
        </label>
        <label className="span-2">Allowed values
          <input className="input input-sm" value={enumText} placeholder="Comma-separated, e.g. asc, desc"
            onChange={(e) => { setEnumText(e.target.value); set({ enum: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }); }} />
        </label>
        <label>Default
          <input className="input input-sm mono" value={d.default ?? ""} onChange={(e) => set({ default: e.target.value })} />
        </label>
        <label>Example
          <input className="input input-sm mono" value={d.example ?? ""} onChange={(e) => set({ example: e.target.value })} />
        </label>
      </div>
      <label className="param-doc-check"><input type="checkbox" checked={!!d.deprecated} onChange={(e) => set({ deprecated: e.target.checked })} /> Deprecated</label>
      <datalist id="param-formats">
        {["date-time", "date", "uuid", "email", "uri", "int32", "int64", "float", "double", "byte", "binary", "password"].map((f) => <option key={f} value={f} />)}
      </datalist>
    </div>,
    document.body,
  );
}

/** Compact summary chips shown next to a documented key. */
export function ParamDocChips({ doc }: { doc?: ParamDoc }) {
  if (!doc) return null;
  return (
    <span className="param-doc-chips">
      {doc.required && <span className="req" title="Required">*</span>}
      {doc.type && <span title="Type">{doc.type}{doc.format ? `:${doc.format}` : ""}</span>}
      {doc.deprecated && <span className="dep" title="Deprecated">deprecated</span>}
    </span>
  );
}
