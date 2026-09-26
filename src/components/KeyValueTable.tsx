import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { KV } from "../types";
import { uid } from "../lib/utils";
import { Icon, IconButton } from "./ui";
import { VarInput } from "./VarInput";
import { ParamDocChips, ParamDocPopover } from "./docs/ParamDocPopover";

interface Props {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  variant?: "default" | "formdata" | "variables";
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  title?: string;
  /** Extra read-only rows (e.g. auto-generated headers) shown above. */
  readonlyRows?: { key: string; value: string; note?: string }[];
  allowBulk?: boolean;
  /** Show per-row API docs details (required, type, enum…). */
  docs?: boolean;
}

function toBulk(rows: KV[]) {
  return rows.map((r) => `${r.enabled ? "" : "//"}${r.key}:${r.value}`).join("\n");
}

function fromBulk(text: string, old: KV[]): KV[] {
  return text.split("\n").filter((l) => l.trim()).map((line, i) => {
    let enabled = true;
    let l = line;
    if (l.startsWith("//")) { enabled = false; l = l.slice(2); }
    const idx = l.indexOf(":");
    const key = (idx < 0 ? l : l.slice(0, idx)).trim();
    const value = idx < 0 ? "" : l.slice(idx + 1).trim();
    return { ...(old[i] ?? {}), id: old[i]?.id ?? uid(), key, value, enabled };
  });
}

export function KeyValueTable({ rows, onChange, variant = "default", keyPlaceholder = "Key", valuePlaceholder = "Value", title, readonlyRows, allowBulk = true, docs }: Props) {
  const [docFor, setDocFor] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [ghostId, setGhostId] = useState(uid);
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [showReadonly, setShowReadonly] = useState(false);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const update = (id: string, patch: Partial<KV>) => {
    if (id === ghostId) {
      onChange([...rows, { id: ghostId, key: "", value: "", enabled: true, ...(variant === "formdata" ? { type: "text" as const } : {}), ...patch }]);
      setGhostId(uid());
      return;
    }
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));
  const allEnabled = rows.length > 0 && rows.every((r) => r.enabled);

  const display: (KV & { ghost?: boolean })[] = [...rows, { id: ghostId, key: "", value: "", enabled: true, ghost: true, type: "text" }];

  const pickFile = async (id: string) => {
    const path = await open({ multiple: false, directory: false });
    if (typeof path === "string") update(id, { value: path, type: "file" });
  };

  return (
    <div className="kv">
      <div className="kv-toolbar">
        {title && <span className="kv-title">{title}</span>}
        {readonlyRows && readonlyRows.length > 0 && (
          <button className="link-btn" onClick={() => setShowReadonly(!showReadonly)}>
            <Icon name={showReadonly ? "eye" : "eyeOff"} size={12} /> {showReadonly ? "Hide" : "Show"} {readonlyRows.length} auto-generated
          </button>
        )}
        <div className="flex-1" />
        {allowBulk && (
          <button
            className="link-btn"
            onClick={() => {
              if (!bulk) setBulkText(toBulk(rows));
              setBulk(!bulk);
            }}
          >
            {bulk ? "Key-Value Edit" : "Bulk Edit"}
          </button>
        )}
      </div>

      {bulk ? (
        <textarea
          className="bulk-edit"
          value={bulkText}
          spellCheck={false}
          placeholder={"Rows are separated by new lines\nKeys and values are separated by :\nPrepend // to any row you want to add but keep disabled"}
          onChange={(e) => { setBulkText(e.target.value); onChange(fromBulk(e.target.value, rows)); }}
        />
      ) : (
        <table className="kv-table">
          <thead>
            <tr>
              <th className="kv-check">
                <input type="checkbox" checked={allEnabled} onChange={() => onChange(rows.map((r) => ({ ...r, enabled: !allEnabled })))} />
              </th>
              <th>{variant === "variables" ? "Variable" : "Key"}</th>
              <th>Value</th>
              {variant !== "variables" && <th>Description</th>}
              <th className="kv-actions" />
            </tr>
          </thead>
          <tbody>
            {showReadonly && readonlyRows?.map((r, i) => (
              <tr key={`ro-${i}`} className="kv-readonly">
                <td className="kv-check"><input type="checkbox" checked readOnly disabled /></td>
                <td><div className="kv-static">{r.key}</div></td>
                <td><div className="kv-static">{r.value}</div></td>
                {variant !== "variables" && <td><div className="kv-static muted">{r.note}</div></td>}
                <td className="kv-actions"><span title="Auto-generated"><Icon name="lock" size={12} /></span></td>
              </tr>
            ))}
            {display.map((r) => (
              <tr key={r.id} className={`${r.ghost ? "kv-ghost" : ""} ${!r.enabled ? "kv-disabled" : ""}`}>
                <td className="kv-check">
                  {!r.ghost && <input type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} />}
                </td>
                <td>
                  <div className="kv-cell">
                    <VarInput value={r.key} onChange={(v) => update(r.id, { key: v })} placeholder={keyPlaceholder} />
                    {docs && <ParamDocChips doc={r.doc} />}
                    {variant === "formdata" && (
                      <select
                        className="kv-type"
                        value={r.type ?? "text"}
                        onChange={(e) => update(r.id, { type: e.target.value as "text" | "file", value: "" })}
                      >
                        <option value="text">Text</option>
                        <option value="file">File</option>
                      </select>
                    )}
                  </div>
                </td>
                <td>
                  {variant === "formdata" && r.type === "file" ? (
                    <div className="kv-cell">
                      <button className="file-pick" onClick={() => pickFile(r.id)} title={r.value}>
                        <Icon name="file" size={12} /> {r.value ? r.value.split(/[\\/]/).pop() : "Select file"}
                      </button>
                    </div>
                  ) : variant === "variables" && r.secret && !reveal[r.id] ? (
                    <div className="kv-cell">
                      <input className="kv-plain" type="password" value={r.value} onChange={(e) => update(r.id, { value: e.target.value })} placeholder={valuePlaceholder} />
                    </div>
                  ) : (
                    <div className="kv-cell">
                      <VarInput value={r.value} onChange={(v) => update(r.id, { value: v })} placeholder={valuePlaceholder} />
                    </div>
                  )}
                </td>
                {variant !== "variables" && (
                  <td>
                    <div className="kv-cell">
                      <input className="kv-plain" value={r.description ?? ""} placeholder="Description" onChange={(e) => update(r.id, { description: e.target.value })} />
                    </div>
                  </td>
                )}
                <td className="kv-actions">
                  {!r.ghost && (
                    <>
                      {variant === "variables" && (
                        <>
                          <IconButton
                            icon={r.secret ? "lock" : "eye"}
                            title={r.secret ? "Secret (masked). Click to make default" : "Default. Click to mark as secret"}
                            onClick={() => update(r.id, { secret: !r.secret })}
                            size={12}
                            active={r.secret}
                          />
                          {r.secret && (
                            <IconButton icon={reveal[r.id] ? "eyeOff" : "eye"} title="Reveal" size={12} onClick={() => setReveal({ ...reveal, [r.id]: !reveal[r.id] })} />
                          )}
                        </>
                      )}
                      {docs && (
                        <IconButton icon="docs" size={12} title="Docs details (required, type, allowed values…)" active={!!r.doc}
                          className={r.doc ? "" : "kv-del"} onClick={(e) => setDocFor(docFor?.id === r.id ? null : { id: r.id, el: e.currentTarget })} />
                      )}
                      <IconButton icon="trash" title="Delete" onClick={() => remove(r.id)} size={12} className="kv-del" />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {docFor && (() => {
        const row = rows.find((r) => r.id === docFor.id);
        return row ? <ParamDocPopover anchor={docFor.el} name={row.key} doc={row.doc} onChange={(doc) => update(row.id, { doc })} onClose={() => setDocFor(null)} /> : null;
      })()}
    </div>
  );
}
