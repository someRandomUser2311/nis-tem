// A collection's API documentation: outline, rendered docs (editable in place) and code samples.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, Tab } from "../../types";
import { buildDocsModel, endpoints, type DocsModel } from "../../lib/docs/model";
import {
  addDocPage, confirmDialog, deleteDocPage, log, moveDocPage, openRequest, openSpecialTab, serveDocs, updateCollection, updateDocPage, updateDocsConfig, updateItem, useDocsTarget, useStore,
} from "../../store";
import { MarkdownField } from "../Markdown";
import { exportOpenApiFile } from "../exporting";
import { Empty, Icon, IconButton, menuFromEvent } from "../ui";
import { DocsMarkdown, EndpointDoc } from "./DocsBlocks";
import { DocsSettings } from "./DocsSettings";
import { ChecksPanel, useDocsIssues } from "./ChecksPanel";
import { ChangesPanel } from "./ChangesPanel";
import { issueCounts } from "../../lib/docs/lint";
import { previewInBrowser, printDocs, publishMarkdown, publishSingleFile, publishSite } from "./publish";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Run a publish action, reporting failures in the console instead of losing them. */
const run = (fn: () => Promise<unknown>) => () => { fn().catch((e) => log("error", `Publishing failed: ${e instanceof Error ? e.message : e}`)); };

export function DocsView({ tab }: { tab: Tab }) {
  const collection = useStore((s) => s.collections.find((c) => c.id === tab.collectionId));
  const environments = useStore((s) => s.environments);
  const globals = useStore((s) => s.globals);
  const [edit, setEdit] = useState(false);
  const [lang, setLang] = useState<string>("");
  const [active, setActive] = useState<string>("overview");
  const [filter, setFilter] = useState("");
  const [panel, setPanel] = useState<"settings" | "checks" | "changes" | null>(null);
  const toggle = (p: NonNullable<typeof panel>) => setPanel(panel === p ? null : p);
  const content = useRef<HTMLDivElement>(null);
  const target = useDocsTarget((s) => (tab.collectionId ? s[tab.collectionId] : undefined));

  const envId = collection?.docsConfig?.environmentId;
  const environment = environments.find((e) => e.id === envId);
  const model: DocsModel | null = useMemo(
    () => (collection ? buildDocsModel(collection, { environment, globals }) : null),
    [collection, environment, globals],
  );
  const currentLang = lang || model?.languages[0] || "curl";
  const issues = useDocsIssues(collection, model);
  const counts = issueCounts(issues);

  const scrollTo = (anchor: string) => {
    const el = content.current?.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
    if (el) { el.scrollIntoView({ block: "start" }); setActive(anchor); }
  };

  // Jump requests from elsewhere ("View in docs").
  useEffect(() => {
    if (!target || !model || !tab.collectionId) return;
    const anchor = model.anchors[target] ?? target;
    requestAnimationFrame(() => scrollTo(anchor));
    useDocsTarget.setState({ [tab.collectionId]: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, model]);

  // Scroll spy: highlight the outline entry of the section at the top.
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 24;
      let current = "overview";
      for (const el of root.querySelectorAll<HTMLElement>("[data-anchor]")) {
        if (el.getBoundingClientRect().top <= top) current = el.dataset.anchor!;
        else break;
      }
      setActive(current);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [model]);

  if (!collection || !model) return <Empty icon="docs" title="Collection not found" />;
  const cid = collection.id;
  const q = filter.trim().toLowerCase();
  const eps = endpoints(model);
  const hiddenCount = countHidden(collection.items);

  return (
    <div className="docs-view">
      <div className="docs-toolbar">
        <Icon name="docs" size={16} />
        <span className="docs-toolbar-title">{model.title}</span>
        {model.version && <span className="docs-tag">v{model.version}</span>}
        <span className="muted">{eps.length} endpoint{eps.length === 1 ? "" : "s"}{model.pages.length ? ` · ${model.pages.length} page${model.pages.length === 1 ? "" : "s"}` : ""}</span>
        <div className="flex-1" />
        <label className="docs-env" title="Non-secret values from this environment fill {{variables}} in URLs and code samples">
          <Icon name="env" size={12} />
          <select className="select select-sm" value={envId ?? ""} onChange={(e) => updateDocsConfig(cid, { environmentId: e.target.value || undefined })}>
            <option value="">No environment</option>
            {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <div className="seg">
          <button className={`seg-btn ${!edit ? "active" : ""}`} onClick={() => setEdit(false)}>Preview</button>
          <button className={`seg-btn ${edit ? "active" : ""}`} onClick={() => setEdit(true)}><Icon name="edit" size={11} /> Edit</button>
        </div>
        <button className={`btn btn-sm docs-checks-btn ${panel === "checks" ? "active" : ""}`} onClick={() => toggle("checks")} title="What's missing or wrong in the docs">
          <Icon name="check" size={11} /> Checks
          {counts.error > 0 && <span className="docs-count error">{counts.error}</span>}
          {counts.warning > 0 && <span className="docs-count warning">{counts.warning}</span>}
        </button>
        <IconButton icon="history" title="Versions & API changes" active={panel === "changes"} onClick={() => toggle("changes")} />
        <IconButton icon="gear" title="Docs settings" active={panel === "settings"} onClick={() => toggle("settings")} />
        <button className="btn btn-primary btn-sm" onClick={(e) => menuFromEvent(e, [
          { label: "Preview in browser", onClick: run(() => previewInBrowser(collection)) },
          { label: "Serve locally (live)", onClick: run(async () => { const d = await serveDocs(cid); openSpecialTab("server", { serverId: d.id }); }), disabled: !inTauri },
          { divider: true },
          { label: "Static site (folder)…", onClick: run(() => publishSite(collection)), disabled: !inTauri },
          { label: "Single HTML file…", onClick: run(() => publishSingleFile(collection)), disabled: !inTauri },
          { label: "Markdown (folder)…", onClick: run(() => publishMarkdown(collection)), disabled: !inTauri },
          { label: "Print / Save as PDF…", onClick: run(() => printDocs(collection)), disabled: !inTauri },
          { divider: true },
          { label: "OpenAPI 3.1 (YAML)…", onClick: run(() => exportOpenApiFile(collection, "yaml")), disabled: !inTauri },
          { label: "OpenAPI 3.1 (JSON)…", onClick: run(() => exportOpenApiFile(collection, "json")), disabled: !inTauri },
        ])}><Icon name="export" size={12} /> Publish <Icon name="chevronDown" size={11} /></button>
      </div>
      {panel === "settings" && <DocsSettings collection={collection} onClose={() => setPanel(null)} />}
      {panel === "checks" && <ChecksPanel collection={collection} issues={issues} onClose={() => setPanel(null)} onJump={(id) => scrollTo(model.anchors[id] ?? "overview")} />}
      {panel === "changes" && <ChangesPanel collection={collection} onClose={() => setPanel(null)} />}

      <div className="docs-body">
        <nav className="docs-outline">
          <div className="search-box">
            <Icon name="search" size={12} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" />
          </div>
          <button className={`docs-nav ${active === "overview" ? "active" : ""}`} onClick={() => scrollTo("overview")}>Overview</button>
          {(model.pages.length > 0 || edit) && <div className="docs-nav-group">Guides{edit && <IconButton icon="plus" size={12} title="Add a page" onClick={() => { const p = addDocPage(cid); requestAnimationFrame(() => scrollTo(model.anchors[p.id] ?? "")); }} />}</div>}
          {model.pages.filter((p) => !q || p.title.toLowerCase().includes(q)).map((p) => (
            <button key={p.id} className={`docs-nav ${active === p.anchor ? "active" : ""}`} onClick={() => scrollTo(p.anchor)}>{p.title}</button>
          ))}
          <div className="docs-nav-group">API reference</div>
          {model.sections.filter((s) => !q || (s.kind === "folder" ? s.name : `${s.method} ${s.name} ${s.url}`).toLowerCase().includes(q)).map((s) => (
            <button key={s.id} className={`docs-nav ${s.kind === "folder" ? "folder" : ""} ${active === s.anchor ? "active" : ""}`}
              style={{ paddingLeft: 10 + s.depth * 12 }} onClick={() => scrollTo(s.anchor)} title={s.kind === "endpoint" ? s.url : s.name}>
              {s.kind === "endpoint" && <span className="docs-nav-method" style={{ color: `var(--m-${s.method.toLowerCase()}, var(--m-other))` }}>{s.method}</span>}
              <span className="ellipsis">{s.name}</span>
            </button>
          ))}
          {hiddenCount > 0 && <div className="help pad">{hiddenCount} item{hiddenCount === 1 ? " is" : "s are"} hidden from the docs.</div>}
        </nav>

        <div className="docs-content" ref={content}>
          <section data-anchor="overview" className="docs-overview">
            {edit ? (
              <div className="docs-edit-row">
                <input className="input docs-title-input" value={collection.docsConfig?.title ?? ""} placeholder={collection.name} onChange={(e) => updateDocsConfig(cid, { title: e.target.value || undefined })} />
                <input className="input input-sm" value={collection.docsConfig?.version ?? ""} placeholder="Version" style={{ width: 110 }} onChange={(e) => updateDocsConfig(cid, { version: e.target.value || undefined })} />
              </div>
            ) : <h1>{model.title}{model.version && <span className="docs-version">v{model.version}</span>}</h1>}
            {edit
              ? <MarkdownField value={collection.description} onChange={(description) => updateCollection(cid, { description })} anchors={model.anchors} onNavigate={scrollTo} placeholder="Introduce the API: what it's for, base URLs, authentication, rate limits…" />
              : collection.description ? <DocsMarkdown source={collection.description} anchors={model.anchors} onNavigate={scrollTo} /> : <p className="muted">No description yet. Switch to <b>Edit</b> to write one.</p>}
            {model.auth && <div className="docs-auth"><Icon name="lock" size={11} /> Authentication: {model.auth.replace(/`/g, "")}</div>}
          </section>

          {model.pages.map((p, i) => (
            <section key={p.id} data-anchor={p.anchor} className="docs-page">
              {edit ? (
                <>
                  <div className="docs-edit-row">
                    <input className="input docs-page-title" value={collection.pages?.find((x) => x.id === p.id)?.title ?? ""} onChange={(e) => updateDocPage(cid, p.id, { title: e.target.value })} placeholder="Page title" />
                    <IconButton icon="chevronUp" title="Move up" size={12} disabled={i === 0} onClick={() => moveDocPage(cid, p.id, -1)} />
                    <IconButton icon="chevronDown" title="Move down" size={12} disabled={i === model.pages.length - 1} onClick={() => moveDocPage(cid, p.id, 1)} />
                    <IconButton icon="trash" title="Delete page" size={12} onClick={async () => { if (await confirmDialog("Delete page", `Delete “${p.title}”?`, { confirmText: "Delete", danger: true })) deleteDocPage(cid, p.id); }} />
                  </div>
                  <MarkdownField value={p.body} onChange={(body) => updateDocPage(cid, p.id, { body })} anchors={model.anchors} onNavigate={scrollTo} placeholder={"# Getting started\n\nExplain authentication, errors, pagination…"} />
                </>
              ) : (
                <>
                  <h2>{p.title}</h2>
                  <DocsMarkdown source={p.body} anchors={model.anchors} onNavigate={scrollTo} />
                </>
              )}
            </section>
          ))}

          {model.sections.length === 0 && <Empty icon="docs" title="Nothing to document yet">Add requests to this collection and they'll appear here.</Empty>}
          {model.sections.map((s) => s.kind === "folder" ? (
            <section key={s.id} data-anchor={s.anchor} className="docs-folder">
              <h2 style={{ fontSize: Math.max(15, 20 - s.depth * 2) }}>{s.trail.length > 0 && <span className="muted">{s.trail.join(" / ")} / </span>}{s.name}</h2>
              {edit
                ? <MarkdownField value={s.description} onChange={(description) => updateItem(cid, s.id, { description })} anchors={model.anchors} onNavigate={scrollTo} placeholder="Describe this group of endpoints…" />
                : <DocsMarkdown source={s.description} anchors={model.anchors} onNavigate={scrollTo} />}
            </section>
          ) : (
            <EndpointDoc
              key={s.id} ep={s} anchors={model.anchors} lang={currentLang} onLang={setLang} onNavigate={scrollTo}
              description={edit ? <MarkdownField value={s.description} onChange={(description) => updateItem(cid, s.id, { description })} anchors={model.anchors} onNavigate={scrollTo} placeholder="Describe this endpoint…" /> : undefined}
              actions={<button className="btn btn-sm" onClick={() => openRequest(cid, s.id)} title="Open the request to edit params, schemas and examples"><Icon name="edit" size={11} /> Open request</button>}
            />
          ))}
          <div className="docs-footer muted">{hiddenCount > 0 ? `${hiddenCount} hidden · ` : ""}Generated locally by Localpost</div>
        </div>
      </div>
    </div>
  );
}

function countHidden(items: Item[]): number {
  let n = 0;
  for (const it of items) {
    if (it.docs?.hidden) n++;
    else if (it.type === "folder") n += countHidden(it.items);
  }
  return n;
}
