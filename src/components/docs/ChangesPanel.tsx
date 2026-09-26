// Versions and API changes: save snapshots, and compare the collection with a snapshot or a file.
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import type { Collection } from "../../types";
import { api } from "../../lib/api";
import { changelogMarkdown, diffCollections, isEmptyDiff } from "../../lib/docs/changelog";
import { detectImport } from "../../lib/importexport";
import {
  confirmDialog, deleteDocsSnapshot, loadDocsSnapshots, prompt, saveDocsSnapshot, upsertChangesPage, useDocsSnapshots,
} from "../../store";
import { Icon, IconButton } from "../ui";
import { DocsMarkdown } from "./DocsBlocks";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function ChangesPanel({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const all = useDocsSnapshots((s) => s.list);
  const snapshots = useMemo(() => all.filter((s) => s.collectionId === collection.id), [all, collection.id]);
  const [base, setBase] = useState<{ label: string; collection: Collection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { loadDocsSnapshots(); }, []);
  useEffect(() => { if (!base && snapshots[0]) setBase({ label: snapshots[0].label, collection: snapshots[0].collection }); }, [snapshots, base]);

  const current = collection.docsConfig?.version ? `v${collection.docsConfig.version}` : "current";
  const diff = useMemo(() => (base ? diffCollections(base.collection, collection) : null), [base, collection]);
  const md = diff && base ? changelogMarkdown(diff, base.label, current) : "";

  const fromFile = async () => {
    setError(null);
    const path = await open({ multiple: false, title: "Compare with a collection file (Postman, OpenAPI, backup…)" });
    if (typeof path !== "string") return;
    try {
      const d = detectImport(await api.readTextFile(path), path.split(/[\\/]/).pop());
      const c = d.kind === "collection" ? d.collection : d.kind === "bundle" ? d.collections[0] : d.kind === "workspace" ? d.data.collections.find((x) => x.name === collection.name) ?? d.data.collections[0] : undefined;
      if (!c) throw new Error("That file has no collection");
      setBase({ label: path.split(/[\\/]/).pop() ?? "file", collection: c });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="docs-checks">
      <div className="docs-settings-head">
        <span className="setting-title">Versions &amp; changes</span>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={async () => {
          const label = await prompt("Save docs snapshot", collection.docsConfig?.version ? `v${collection.docsConfig.version}` : "", "Version label (empty = date and time)", "Save");
          if (label === null) return;
          const s = await saveDocsSnapshot(collection.id, label.trim() || undefined);
          if (s) setBase(null);
        }}><Icon name="save" size={11} /> Save snapshot</button>
        <IconButton icon="close" size={12} title="Close" onClick={onClose} />
      </div>
      <div className="docs-changes-bar">
        <span className="muted">Compare</span>
        <select className="select select-sm" value={base ? snapshots.find((s) => s.collection === base.collection)?.id ?? "file" : ""}
          onChange={(e) => { const s = snapshots.find((x) => x.id === e.target.value); if (s) setBase({ label: s.label, collection: s.collection }); }}>
          {!base && <option value="">Choose a baseline…</option>}
          {snapshots.map((s) => <option key={s.id} value={s.id}>{s.label} · {new Date(s.createdAt).toLocaleDateString()}</option>)}
          {base && !snapshots.some((s) => s.collection === base.collection) && <option value="file">{base.label}</option>}
        </select>
        <button className="btn btn-sm" onClick={fromFile} disabled={!inTauri}>From a file…</button>
        <span className="muted">→ {current}</span>
        <div className="flex-1" />
        {base && snapshots.some((s) => s.collection === base.collection) && (
          <button className="link-btn" onClick={async () => {
            const s = snapshots.find((x) => x.collection === base.collection)!;
            if (await confirmDialog("Delete snapshot", `Delete snapshot “${s.label}”?`, { confirmText: "Delete", danger: true })) { await deleteDocsSnapshot(s.id); setBase(null); }
          }}>Delete snapshot</button>
        )}
      </div>
      {error && <div className="err-text">{error}</div>}
      {!base && !snapshots.length && <p className="help">Save a snapshot when you publish a version. Later, compare the collection with it to get an “API changes” page listing added, removed and changed endpoints.</p>}
      {diff && (
        <>
          <div className="docs-changes-summary">
            <span className="tool-badge ok">+{diff.added.length} added</span>
            <span className="tool-badge bad">−{diff.removed.length} removed</span>
            <span className="tool-badge warn">{diff.changed.length} changed</span>
            {diff.changed.some((c) => c.breaking) || diff.removed.length ? <span className="tool-badge bad">may break clients</span> : null}
            <div className="flex-1" />
            <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(md)}><Icon name="copy" size={11} /> Copy Markdown</button>
            <button className="btn btn-sm btn-primary" disabled={isEmptyDiff(diff)} onClick={() => upsertChangesPage(collection.id, md)}><Icon name="docs" size={11} /> Add as “API changes” page</button>
          </div>
          <div className="docs-changes-md"><DocsMarkdown source={md} /></div>
        </>
      )}
    </div>
  );
}
