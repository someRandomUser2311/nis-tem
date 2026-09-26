// Static documentation site from the docs model: a folder (index.html + assets) or one
// self-contained HTML file. No network requests; secrets never reach it (see model.ts).
import { escapeHtml as esc, markdownText, renderDocsMarkdown } from "./markdown";
import type { DocsEndpoint, DocsExample, DocsModel, DocsParam } from "./model";
import type { SchemaRow } from "./schema";
import { SITE_CSS, SITE_JS } from "./site-assets";

export interface SiteFile { path: string; content: string }

export interface SiteOptions {
  /** Inline everything into index.html. */
  singleFile?: boolean;
  /** Open the print dialog when the page loads (Save as PDF). */
  autoPrint?: boolean;
  /** mermaid.min.js source; diagrams are rendered only when provided. */
  mermaidJs?: string;
}

const safeColor = (c?: string) => (c && /^#[0-9a-f]{3,8}$|^[a-z]+$|^rgb\([\d\s,.%]+\)$/i.test(c) ? c : undefined);
const safeLogo = (l?: string) => (l && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(l) ? l : undefined);

function fieldRows(rows: SchemaRow[]): string {
  if (!rows.length) return "";
  return `<table class="fields"><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows.map((r) => `<tr${r.deprecated ? ' class="dep"' : ""}>
<td><span style="padding-left:${r.depth * 14}px">${r.variant ? `<span class="variant">${esc(r.variant)}</span>` : ""}<code>${esc(r.name)}</code>${r.required ? '<span class="req" title="Required">*</span>' : ""}</span></td>
<td><span class="type">${esc(r.type)}${r.format ? ` · ${esc(r.format)}` : ""}</span></td>
<td>${esc(r.description ?? "")}${r.enum ? `<div class="sub">One of: ${r.enum.map((v) => `<code>${esc(JSON.stringify(v))}</code>`).join(" ")}</div>` : ""}${r.deprecated ? ' <span class="badge status-deprecated">deprecated</span>' : ""}</td></tr>`).join("")}</tbody></table>`;
}

function paramRows(title: string, params: DocsParam[]): string {
  if (!params.length) return "";
  return `${title ? `<h4>${esc(title)}</h4>` : ""}<table class="fields"><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>${params.map((p) => {
    const sub = [
      p.enum?.length ? `One of: ${p.enum.map((v) => `<code>${esc(v)}</code>`).join(" ")}` : "",
      p.default ? `Default <code>${esc(p.default)}</code>` : "",
      p.example || p.value ? `Example <code>${esc(p.example || p.value)}</code>` : "",
    ].filter(Boolean).join(" · ");
    return `<tr${p.deprecated ? ' class="dep"' : ""}><td><code>${esc(p.name)}</code>${p.required ? '<span class="req" title="Required">*</span>' : ""}</td>
<td><span class="type">${esc(p.type ?? "string")}${p.format ? ` · ${esc(p.format)}` : ""}</span></td>
<td>${esc(p.description)}${sub ? `<div class="sub">${sub}</div>` : ""}${p.deprecated ? ' <span class="badge status-deprecated">deprecated</span>' : ""}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function example(ex: DocsExample, open: boolean, md: (s: string) => string): string {
  return `<details class="example"${open ? " open" : ""}><summary><b class="m-${ex.status < 300 ? "get" : ex.status < 400 ? "put" : ex.status < 500 ? "post" : "delete"}">${ex.status}</b>${esc(ex.name)}</summary>
${ex.description ? `<div class="md">${md(ex.description)}</div>` : ""}
${ex.body ? `<pre class="code">${esc(ex.body)}</pre>` : '<p class="sub">No body</p>'}${fieldRows(ex.schemaRows)}</details>`;
}

function endpoint(ep: DocsEndpoint, md: (s: string) => string, lang: string): string {
  const b = ep.body;
  const bodyHtml = b ? `<h4>Request body${b.mode === "formdata" ? " (multipart/form-data)" : b.mode === "urlencoded" ? " (x-www-form-urlencoded)" : b.mode === "binary" ? " (binary)" : ""}</h4>
${b.fields ? paramRows("", b.fields) : ""}${fieldRows(b.schemaRows)}${b.example ? `<pre class="code">${esc(b.example)}</pre>` : ""}` : "";
  const responses = ep.responseSchemaRows.length || ep.examples.length
    ? `<h4>Responses</h4>${fieldRows(ep.responseSchemaRows)}${ep.examples.map((e, i) => example(e, i === 0, md)).join("")}` : "";
  const samples = ep.samples.length
    ? ep.samples.map((s) => `<div class="sample${s.lang === lang ? " on" : ""}" data-lang="${esc(s.lang)}"><div class="sample-head"><span>${esc(s.label)}</span><button class="copy" type="button">Copy</button></div><pre class="code">${esc(s.code)}</pre></div>`).join("")
    : `<p class="sub">${ep.protocol === "ws" ? "Connect with a WebSocket client to the URL." : ep.protocol === "sse" ? "Open an event stream (Server-Sent Events) to the URL." : ""}</p>`;
  return `<section class="ep${ep.status === "deprecated" ? " deprecated" : ""}" id="${esc(ep.anchor)}">
<div class="ep-main"><div class="ep-head"><span class="pill m-${esc(ep.method.toLowerCase())}">${esc(ep.method)}</span><h3>${esc(ep.name)}</h3>
${ep.status && ep.status !== "stable" ? `<span class="badge status-${ep.status}">${ep.status}</span>` : ""}${ep.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
<div class="url">${esc(ep.url)}</div>
${ep.description ? `<div class="md">${md(ep.description)}</div>` : ""}
${ep.auth ? `<div class="auth">🔒 ${md(ep.auth).replace(/^<p>|<\/p>\s*$/g, "")}</div>` : ""}
${paramRows("Path variables", ep.pathVariables)}${paramRows("Query parameters", ep.query)}${paramRows("Headers", ep.headers)}${bodyHtml}${responses}
</div><aside class="ep-side"><div class="samples">${samples}</div></aside></section>`;
}

/** The search index embedded in the page: title, anchor, method, URL and some text. */
export function searchIndex(m: DocsModel) {
  const cut = (s: string) => markdownText(s).slice(0, 300);
  return [
    { t: "Overview", a: "overview", x: cut(m.description) },
    ...m.pages.map((p) => ({ t: p.title, a: p.anchor, x: cut(p.body) })),
    ...m.sections.map((s) => s.kind === "folder"
      ? { t: s.name, a: s.anchor, x: cut(s.description) }
      : { t: s.name, a: s.anchor, m: s.method, u: s.url, x: cut(s.description) }),
  ];
}

export function renderSiteHtml(m: DocsModel, opts: SiteOptions & { css?: string; js?: string } = {}): string {
  const md = (s: string) => renderDocsMarkdown(s, { resolveRequest: (id) => m.anchors[id] });
  const lang = m.languages[0] ?? "";
  const accent = safeColor(m.accent);
  const logo = safeLogo(m.logo);
  const hasMermaid = !!opts.mermaidJs && [m.description, ...m.pages.map((p) => p.body), ...m.sections.map((s) => s.description)].some((s) => /```\s*mermaid/i.test(s));
  const toc = [
    `<li><a href="#overview">Overview</a></li>`,
    ...(m.pages.length ? [`<li class="group">Guides</li>`, ...m.pages.map((p) => `<li><a href="#${esc(p.anchor)}">${esc(p.title)}</a></li>`)] : []),
    ...(m.sections.length ? [`<li class="group">API reference</li>`] : []),
    ...m.sections.map((s) => s.kind === "folder"
      ? `<li><a class="folder" href="#${esc(s.anchor)}" style="padding-left:${10 + s.depth * 12}px">${esc(s.name)}</a></li>`
      : `<li><a href="#${esc(s.anchor)}" style="padding-left:${10 + s.depth * 12}px"><span class="m m-${esc(s.method.toLowerCase())}">${esc(s.method)}</span><span>${esc(s.name)}</span></a></li>`),
  ].join("\n");
  const content = [
    `<section class="doc" id="overview"><h1>${esc(m.title)}${m.version ? ` <span class="badge">v${esc(m.version)}</span>` : ""}</h1>
${m.description ? `<div class="md">${md(m.description)}</div>` : ""}${m.auth ? `<div class="auth">🔒 Authentication: ${md(m.auth).replace(/^<p>|<\/p>\s*$/g, "")}</div>` : ""}</section>`,
    ...m.pages.map((p) => `<section class="doc" id="${esc(p.anchor)}"><h2>${esc(p.title)}</h2><div class="md">${md(p.body)}</div></section>`),
    ...m.sections.map((s) => s.kind === "folder"
      ? `<section class="folder-doc" id="${esc(s.anchor)}"><h2>${s.trail.length ? `<span class="crumbs">${esc(s.trail.join(" / "))} / </span>` : ""}${esc(s.name)}</h2>${s.description ? `<div class="md">${md(s.description)}</div>` : ""}</section>`
      : endpoint(s, md, lang)),
  ].join("\n");
  const css = opts.singleFile ? `<style>${opts.css ?? SITE_CSS}</style>` : `<link rel="stylesheet" href="assets/docs.css">`;
  const accentCss = accent ? `<style>:root{--accent:${accent}}</style>` : "";
  const scripts = opts.singleFile
    ? `${hasMermaid ? `<script>${opts.mermaidJs!.replace(/<\/script/gi, "<\\/script")}</script>` : ""}<script>${opts.js ?? SITE_JS}</script>`
    : `${hasMermaid ? `<script src="assets/mermaid.min.js"></script>` : ""}<script src="assets/docs.js"></script>`;
  const langs = m.languages.length > 1 ? `<select id="lang" aria-label="Code sample language">${m.languages.map((l) => `<option value="${esc(l)}">${esc(LANG_LABEL[l] ?? l)}</option>`).join("")}</select>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="Localpost">
<title>${esc(m.title)}${m.version ? ` v${esc(m.version)}` : ""} — API documentation</title>
${css}${accentCss}
</head>
<body data-lang="${esc(lang)}"${opts.autoPrint ? " data-autoprint" : ""}>
<header class="top"><button id="menu" type="button" aria-label="Menu">☰</button>${logo ? `<img src="${logo}" alt="">` : ""}<span class="title">${esc(m.title)}</span>${m.version ? `<span class="badge">v${esc(m.version)}</span>` : ""}<span class="spacer"></span>${langs}<button id="theme" type="button" title="Toggle dark mode" aria-label="Toggle dark mode">◐</button></header>
<div class="layout">
<nav class="side"><input id="q" type="search" placeholder="Search" aria-label="Search the docs"><ul class="results" id="results"></ul><ul class="toc">
${toc}
</ul></nav>
<main>
${content}
<footer>Generated by Localpost</footer>
</main>
</div>
<script type="application/json" id="search-index">${JSON.stringify(searchIndex(m)).replace(/</g, "\\u003c")}</script>
${scripts}
</body>
</html>
`;
}

const LANG_LABEL: Record<string, string> = {
  curl: "cURL", http: "HTTP", fetch: "JavaScript (fetch)", axios: "Node.js (axios)", python: "Python", go: "Go", powershell: "PowerShell",
  httpie: "HTTPie", wget: "wget", java: "Java", csharp: "C#", php: "PHP", ruby: "Ruby", rust: "Rust", swift: "Swift",
};

/** The files of the site. With `singleFile`, just index.html. */
export function buildSite(m: DocsModel, opts: SiteOptions = {}): SiteFile[] {
  const html = renderSiteHtml(m, opts);
  if (opts.singleFile) return [{ path: "index.html", content: html }];
  const files: SiteFile[] = [
    { path: "index.html", content: html },
    { path: "assets/docs.css", content: SITE_CSS.trimStart() },
    { path: "assets/docs.js", content: SITE_JS.trimStart() },
  ];
  if (html.includes('src="assets/mermaid.min.js"')) files.push({ path: "assets/mermaid.min.js", content: opts.mermaidJs! });
  return files;
}
