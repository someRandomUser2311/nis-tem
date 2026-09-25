// Building blocks shared by the Dev toolbox tabs: per-tool state, output boxes, copy and
// "Use in request".
import { useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { RawLanguage } from "../../types";
import { kv } from "../../lib/utils";
import { newRequestTab, setActiveTab, updateDraft, useStore } from "../../store";
import { CodeEditor, type CodeLang } from "../CodeEditor";
import { Icon, IconButton, menuFromEvent, type MenuItem } from "../ui";

/**
 * Tool inputs live here (in memory only — keys and tokens are never written to disk), so switching
 * tabs doesn't lose them.
 */
const useToolStore = create<Record<string, unknown>>(() => ({}));

export function useToolField<T>(key: string, init: T): [T, (v: T) => void] {
  const v = useToolStore((s) => (key in s ? (s[key] as T) : init));
  return [v, (next: T) => useToolStore.setState({ [key]: next })];
}

/** Run an async transform whenever its inputs change; returns the latest result or error. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { value?: T; error?: string } {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    fn().then((value) => live && setState({ value }), (e) => live && setState({ error: String(e?.message ?? e) }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function Seg<T extends string>({ options, value, onChange }: { options: readonly { id: T; label: string }[] | readonly T[]; value: T; onChange: (v: T) => void }) {
  const opts = options.map((o) => (typeof o === "string" ? { id: o, label: o } : o)) as { id: T; label: string }[];
  return (
    <div className="seg">
      {opts.map((o) => <button key={o.id} type="button" className={`seg-btn ${value === o.id ? "active" : ""}`} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

export function CopyButton({ text, title = "Copy" }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton icon={done ? "check" : "copy"} title={title} disabled={!text}
      onClick={() => { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1000); }} />
  );
}

// ---------------------------------------------------------------- use in request

/** The request tab the user was last on, so tools know where "Use in request" goes. */
let lastRequestTabId: string | undefined;
useStore.subscribe((s) => {
  const t = s.tabs.find((x) => x.id === s.activeTabId);
  if (t?.kind === "request") lastRequestTabId = t.id;
});

/** The last request tab the user was on, else the right-most open request tab, else a new one. */
function targetTab(): string {
  const requests = useStore.getState().tabs.filter((x) => x.kind === "request" && x.draft);
  const t = requests.find((x) => x.id === lastRequestTabId) ?? requests[requests.length - 1];
  return t ? t.id : newRequestTab().id;
}

export type UseTarget = { kind: "body"; language?: RawLanguage } | { kind: "header"; name: string } | { kind: "bearer" };

export function sendToRequest(value: string, target: UseTarget) {
  const id = targetTab();
  const draft = useStore.getState().tabs.find((t) => t.id === id)!.draft!;
  switch (target.kind) {
    case "body":
      updateDraft(id, { body: { ...draft.body, mode: "raw", raw: value, rawLanguage: target.language ?? (/^\s*[[{]/.test(value) ? "json" : "text") } });
      break;
    case "header": {
      const i = draft.headers.findIndex((h) => h.key.toLowerCase() === target.name.toLowerCase() && target.name);
      const headers = i >= 0 ? draft.headers.map((h, j) => (j === i ? { ...h, value, enabled: true } : h)) : [...draft.headers, kv(target.name, value)];
      updateDraft(id, { headers });
      break;
    }
    case "bearer":
      updateDraft(id, { auth: { ...draft.auth, type: "bearer", bearer: { ...draft.auth.bearer, token: value } } });
      break;
  }
  setActiveTab(id);
}

/** `headerValue` overrides what goes into the header (e.g. "Bearer <token>"). */
export function UseInRequest({ value, header, headerValue, bearer, language }: { value: string; header?: string; headerValue?: string; bearer?: boolean; language?: RawLanguage }) {
  const items: MenuItem[] = [
    ...(bearer ? [{ label: "Set as Bearer token", onClick: () => sendToRequest(value, { kind: "bearer" }) }] : []),
    { label: header ? `Set header ${header}` : "Add as header", onClick: () => sendToRequest(headerValue ?? value, { kind: "header", name: header ?? "" }) },
    { label: "Use as request body", onClick: () => sendToRequest(value, { kind: "body", language }) },
  ];
  return (
    <button type="button" className="btn btn-sm" disabled={!value} onClick={(e) => menuFromEvent(e, items)} title="Put this into the request you last worked on">
      Use in request <Icon name="chevronDown" size={11} />
    </button>
  );
}

// ---------------------------------------------------------------- layout

export function Section({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="tool-section">
      <div className="tool-section-head"><span>{title}</span><div className="tool-section-right">{right}</div></div>
      {children}
    </section>
  );
}

/** A labelled CodeMirror box. Read-only when `onChange` is missing. */
export function Editor({ value, onChange, language = "text", height = 160, placeholder }: {
  value: string; onChange?: (v: string) => void; language?: CodeLang; height?: number; placeholder?: string;
}) {
  return (
    <div className="tool-editor" style={{ height }}>
      <CodeEditor value={value} onChange={onChange} readOnly={!onChange} language={language} wrap placeholder={placeholder} />
    </div>
  );
}

/** One read-only value with copy and "Use in request". */
export function OutputRow({ label, value, header, bearer, mono = true }: { label: string; value: string; header?: string; bearer?: boolean; mono?: boolean }) {
  return (
    <div className="tool-output-row">
      <span className="tool-output-label">{label}</span>
      <span className={`tool-output-value ${mono ? "mono" : ""}`} title={value}>{value}</span>
      <CopyButton text={value} />
      {header !== undefined && <UseInRequest value={value} header={header || undefined} bearer={bearer} />}
    </div>
  );
}

export function ErrorLine({ error }: { error?: string }) {
  return error ? <div className="tool-error"><Icon name="close" size={11} /> {error}</div> : null;
}
