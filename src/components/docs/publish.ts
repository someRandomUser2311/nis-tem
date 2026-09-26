// Publishing a collection's docs: a site folder, one HTML file, Markdown, or a print view for
// Save as PDF. Everything is written locally; the leak check runs first.
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Collection } from "../../types";
import { api } from "../../lib/api";
import type { DocsModel } from "../../lib/docs/model";
import { buildMarkdownDocs } from "../../lib/docs/markdown-export";
import { loadMermaidJs, needsMermaid } from "../../lib/docs/mermaid-asset";
import { buildSite } from "../../lib/docs/site";
import { scanDocsText, summarize } from "../../lib/leaks";
import { choiceDialog, confirmDialog, docsModelFor, docsTexts, log } from "../../store";

const fileName = (s: string) => s.replace(/[^\w.-]+/g, "_");

/** The model to publish after the leak check (null = cancelled). */
async function guardedModel(c: Collection): Promise<DocsModel | null> {
  const model = docsModelFor(c);
  const { findings } = scanDocsText(model);
  if (!findings.length) return model;
  const choice = await choiceDialog(
    "The docs contain what look like secrets",
    `Found ${findings.length} credential-like value${findings.length === 1 ? "" : "s"} in descriptions, pages or examples:\n\n${summarize(findings)}\n\nReplace them with <redacted> in the published copy? (Your collection isn't changed.)`,
    [
      { label: "Publish as is", value: "keep", variant: "danger" },
      { label: "Cancel", value: "cancel" },
      { label: "Redact", value: "strip", variant: "primary" },
    ],
  );
  if (choice === "strip") return scanDocsText(model, true).cleaned;
  return choice === "keep" ? model : null;
}

const mermaidFor = async (m: DocsModel) => (needsMermaid(docsTexts(m)) ? loadMermaidJs() : undefined);

async function writeFolder(dir: string, files: { path: string; content: string }[], what: string): Promise<boolean> {
  try {
    const r = await api.docsWrite(dir, files, false);
    log("info", `${what} published to ${dir} (${r.written} written, ${r.unchanged} unchanged${r.removed ? `, ${r.removed} removed` : ""})`);
    return true;
  } catch (e) {
    if (String(e) !== "NOT_EMPTY") throw e;
    const ok = await confirmDialog("Folder isn't empty",
      `${dir} already contains other files.\n\nLocalpost will add its files there (same-named files are replaced; nothing else is deleted). Later publishes to this folder only update Localpost's own files.`,
      { confirmText: "Publish here" });
    if (!ok) return false;
    const r = await api.docsWrite(dir, files, true);
    log("info", `${what} published to ${dir} (${r.written} written)`);
    return true;
  }
}

/** Static site (index.html + assets/) into a folder. Returns the folder, or null. */
export async function publishSite(c: Collection): Promise<string | null> {
  const model = await guardedModel(c);
  if (!model) return null;
  const dir = await open({ directory: true, multiple: false, title: `Choose a folder for the “${c.name}” docs site` });
  if (typeof dir !== "string") return null;
  return (await writeFolder(dir, buildSite(model, { mermaidJs: await mermaidFor(model) }), "Docs site")) ? dir : null;
}

/** One self-contained HTML file. */
export async function publishSingleFile(c: Collection) {
  const model = await guardedModel(c);
  if (!model) return;
  const path = await save({ defaultPath: `${fileName(c.name)}-docs.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
  if (!path) return;
  const [file] = buildSite(model, { singleFile: true, mermaidJs: await mermaidFor(model) });
  await api.writeTextFile(path, file.content);
  log("info", `Docs saved to ${path}`);
}

/** README.md + one Markdown file per folder and guide page. */
export async function publishMarkdown(c: Collection) {
  const model = await guardedModel(c);
  if (!model) return;
  const dir = await open({ directory: true, multiple: false, title: `Choose a folder for the “${c.name}” Markdown docs` });
  if (typeof dir !== "string") return;
  await writeFolder(dir, buildMarkdownDocs(model), "Markdown docs");
}

/** Open a print-ready page in the browser (use its Save as PDF). */
export async function printDocs(c: Collection) {
  const model = await guardedModel(c);
  if (!model) return;
  const [file] = buildSite(model, { singleFile: true, autoPrint: true, mermaidJs: await mermaidFor(model) });
  await api.docsOpenPage(`${fileName(c.name)}-docs-print`, file.content);
}

/** Open the docs in the system browser (a temporary single file). */
export async function previewInBrowser(c: Collection) {
  const model = await guardedModel(c);
  if (!model) return;
  const [file] = buildSite(model, { singleFile: true, mermaidJs: await mermaidFor(model) });
  await api.docsOpenPage(`${fileName(c.name)}-docs`, file.content);
}
