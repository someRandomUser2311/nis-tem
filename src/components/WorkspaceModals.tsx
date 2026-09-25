// Workspace-wide dialogs: find & replace in a collection, environment compare, and a side-by-side diff.
import { json } from "@codemirror/lang-json";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { baseTheme, syntax } from "../lib/cm";
import { diffEnvironments, makeMatcher, replaceInItems, type ReplaceField } from "../lib/search";
import { clone } from "../lib/utils";
import { closeModal, openModal, refreshCleanTabs, updateCollection, useStore, type Modal } from "../store";
import { Icon, ModalFrame, Toggle } from "./ui";

// ---------------------------------------------------------------- find & replace

const FIELDS: { id: ReplaceField; label: string }[] = [
  { id: "url", label: "URLs" },
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Bodies" },
  { id: "auth", label: "Auth values" },
];

export function ReplaceModal({ collectionId }: { collectionId: string }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === collectionId));
  const [find, setFind] = useState("");
  const [repl, setRepl] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [fields, setFields] = useState<ReplaceField[]>(["url", "params", "headers", "body"]);

  const opts = { regex, caseSensitive, fields };
  const invalid = !!find && !makeMatcher(find, opts);
  const preview = useMemo(
    () => (collection && find && !invalid ? replaceInItems(clone(collection.items), find, repl, opts) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, find, repl, regex, caseSensitive, fields.join(), invalid],
  );
  if (!collection) return null;
  const total = preview.reduce((n, p) => n + p.count, 0);
  const requests = new Set(preview.map((p) => p.itemId)).size;

  const apply = () => {
    const items = clone(collection.items);
    replaceInItems(items, find, repl, opts);
    updateCollection(collection.id, { items });
    // Open tabs without unsaved edits show the new values; edited tabs keep the user's draft.
    refreshCleanTabs(collection.id);
    closeModal();
  };

  return (
    <ModalFrame title={`Find & replace in “${collection.name}”`} onClose={closeModal} width={760}
      footer={<>
        <span className="muted">{find ? (invalid ? "Invalid regular expression" : `${total} match${total === 1 ? "" : "es"} in ${requests} request${requests === 1 ? "" : "s"}`) : ""}</span>
        <div className="flex-1" />
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" disabled={!total} onClick={apply}>Replace all</button>
      </>}>
      <div className="replace-form">
        <label className="field-label">Find</label>
        <input className="input mono" autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="e.g. https://staging.example.com" />
        <label className="field-label">Replace with</label>
        <input className="input mono" value={repl} onChange={(e) => setRepl(e.target.value)} placeholder={regex ? "Use $1, $2… for groups" : "e.g. {{baseUrl}}"} />
      </div>
      <div className="replace-opts">
        <Toggle checked={caseSensitive} onChange={setCaseSensitive} label="Match case" />
        <Toggle checked={regex} onChange={setRegex} label="Regular expression" />
        <span className="replace-fields">
          {FIELDS.map((f) => (
            <label key={f.id} className="radio">
              <input type="checkbox" checked={fields.includes(f.id)} onChange={(e) => setFields(e.target.checked ? [...fields, f.id] : fields.filter((x) => x !== f.id))} />
              {f.label}
            </label>
          ))}
        </span>
      </div>
      <div className="replace-preview">
        {!find && <div className="muted pad">Matches are previewed here before anything changes.</div>}
        {preview.map((p, i) => (
          <div key={i} className="replace-row">
            <div className="replace-row-head"><b>{p.name}</b> <span className="muted">· {p.field} · {p.count}×</span></div>
            <div className="replace-diff mono"><span className="del">{p.before}</span><span className="add">{p.after}</span></div>
          </div>
        ))}
      </div>
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- environment compare

export function EnvCompareModal({ a: a0, b: b0 }: { a?: string; b?: string }) {
  const environments = useStore((s) => s.environments);
  const globals = useStore((s) => s.globals);
  const options = [{ id: "__globals", name: "Globals", variables: globals }, ...environments];
  const [a, setA] = useState(a0 ?? environments[0]?.id ?? "__globals");
  const [b, setB] = useState(b0 ?? environments[1]?.id ?? environments[0]?.id ?? "__globals");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const ea = options.find((o) => o.id === a);
  const eb = options.find((o) => o.id === b);
  const rows = ea && eb ? diffEnvironments(ea.variables, eb.variables) : [];
  const shown = onlyDiff ? rows.filter((r) => r.status !== "same") : rows;
  const secret = (env: typeof ea, key: string) => env?.variables.find((v) => v.key === key)?.secret;

  const pick = (value: string, set: (v: string) => void) => (
    <select className="select" value={value} onChange={(e) => set(e.target.value)}>
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );

  return (
    <ModalFrame title="Compare environments" onClose={closeModal} width={820}
      footer={<><Toggle checked={onlyDiff} onChange={setOnlyDiff} label="Only show differences" /><div className="flex-1" /><button className="btn" onClick={closeModal}>Close</button></>}>
      <div className="env-compare-pick">{pick(a, setA)}<Icon name="chevronRight" />{pick(b, setB)}</div>
      {shown.length === 0 ? <div className="muted pad">{rows.length ? "No differences." : "Both environments are empty."}</div> : (
        <table className="data-table env-compare">
          <thead><tr><th>Variable</th><th>{ea?.name}</th><th>{eb?.name}</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className={`env-diff-${r.status}`}>
                <td className="mono">{r.key}</td>
                <td className="mono selectable">{r.a === undefined ? <span className="muted">missing</span> : secret(ea, r.key) ? "••••••" : r.a}</td>
                <td className="mono selectable">{r.b === undefined ? <span className="muted">missing</span> : secret(eb, r.key) ? "••••••" : r.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ModalFrame>
  );
}

// ---------------------------------------------------------------- diff

export function DiffModal({ modal }: { modal: Extract<Modal, { kind: "diff" }> }) {
  const host = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState(true);
  useEffect(() => {
    if (!host.current) return;
    const ext = [
      baseTheme, syntax, EditorState.readOnly.of(true), EditorView.editable.of(false),
      ...(modal.language === "json" ? [json()] : []), ...(wrap ? [EditorView.lineWrapping] : []),
    ];
    const view = new MergeView({
      a: { doc: modal.left, extensions: ext },
      b: { doc: modal.right, extensions: ext },
      parent: host.current,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    return () => view.destroy();
  }, [modal, wrap]);
  const same = modal.left === modal.right;
  return (
    <ModalFrame title={modal.title} onClose={closeModal} width={1100} className="diff-modal"
      footer={<><Toggle checked={wrap} onChange={setWrap} label="Wrap lines" />{same && <span className="muted">The two sides are identical.</span>}<div className="flex-1" /><button className="btn" onClick={closeModal}>Close</button></>}>
      <div className="diff-labels"><span>{modal.leftLabel}</span><span>{modal.rightLabel}</span></div>
      <div className="diff-host" ref={host} />
    </ModalFrame>
  );
}

/** Open the diff dialog; JSON is pretty-printed on both sides so formatting noise disappears. */
export function openDiff(title: string, left: { label: string; text: string }, right: { label: string; text: string }) {
  const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return null; } };
  const pl = pretty(left.text), pr = pretty(right.text);
  const isJson = pl !== null && pr !== null;
  openModal({
    kind: "diff", title, leftLabel: left.label, rightLabel: right.label,
    left: isJson ? pl : left.text, right: isJson ? pr : right.text, language: isJson ? "json" : "text",
  });
}
