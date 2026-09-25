// Export to file, with the secret-leak guard: if credentials are found, ask whether to strip them.
import { save } from "@tauri-apps/plugin-dialog";
import type { Collection, Environment } from "../types";
import { api } from "../lib/api";
import { exportPostmanCollection, exportPostmanEnvironment, type WorkspaceBackup } from "../lib/importexport";
import { scanCollection, scanEnvironment, summarize, type Finding } from "../lib/leaks";
import { choiceDialog, useStore } from "../store";
import { exportHtmlDocs, exportOpenApi } from "../lib/exporters";
import { exportHar } from "../lib/importers";
import { stringify as toYaml } from "yaml";
import { renderMarkdown } from "./Markdown";
import type { HistoryEntry } from "../types";

const fileName = (s: string) => s.replace(/[^\w.-]+/g, "_");

/** Returns "strip" | "keep", or null when the user cancelled. */
async function askAboutSecrets(findings: Finding[]): Promise<"strip" | "keep" | null> {
  if (!findings.length) return "keep";
  const choice = await choiceDialog(
    "This export contains secrets",
    `Found ${findings.length} credential${findings.length === 1 ? "" : "s"} that would be written to the file:\n\n${summarize(findings)}\n\nRemove them from the exported copy? (Your workspace isn't changed.)`,
    [
      { label: "Export with secrets", value: "keep", variant: "danger" },
      { label: "Cancel", value: "cancel" },
      { label: "Remove secrets", value: "strip", variant: "primary" },
    ],
  );
  return choice === "strip" || choice === "keep" ? choice : null;
}

async function write(defaultPath: string, data: unknown) {
  const path = await save({ defaultPath, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (path) await api.writeTextFile(path, JSON.stringify(data, null, 2));
}

async function writeText(defaultPath: string, text: string, filter: { name: string; extensions: string[] }) {
  const path = await save({ defaultPath, filters: [filter] });
  if (path) await api.writeTextFile(path, text);
}

/** Collection after the leak prompt (null = cancelled). */
async function guardedCollection(c: Collection): Promise<Collection | null> {
  const choice = await askAboutSecrets(scanCollection(c).findings);
  if (!choice) return null;
  return choice === "strip" ? scanCollection(c, true).cleaned : c;
}

export async function exportOpenApiFile(c: Collection, format: "yaml" | "json") {
  const data = await guardedCollection(c);
  if (!data) return;
  const doc = exportOpenApi(data);
  if (format === "yaml") await writeText(`${fileName(c.name)}.openapi.yaml`, toYaml(doc, { lineWidth: 0 }), { name: "YAML", extensions: ["yaml", "yml"] });
  else await write(`${fileName(c.name)}.openapi.json`, doc);
}

export async function exportDocsFile(c: Collection) {
  const data = await guardedCollection(c);
  if (!data) return;
  await writeText(`${fileName(c.name)}-docs.html`, exportHtmlDocs(data, renderMarkdown), { name: "HTML", extensions: ["html"] });
}

export async function exportHistoryHar(entries: HistoryEntry[]) {
  await writeText(`localpost-history-${new Date().toISOString().slice(0, 10)}.har`, JSON.stringify(exportHar(entries), null, 2), { name: "HAR", extensions: ["har", "json"] });
}

export async function exportCollectionFile(c: Collection) {
  const choice = await askAboutSecrets(scanCollection(c).findings);
  if (!choice) return;
  const data = choice === "strip" ? scanCollection(c, true).cleaned : c;
  await write(`${fileName(c.name)}.postman_collection.json`, exportPostmanCollection(data));
}

export async function exportEnvironmentFile(e: Environment, scope: "environment" | "globals" = "environment") {
  const choice = await askAboutSecrets(scanEnvironment(e).findings);
  if (!choice) return;
  const data = choice === "strip" ? scanEnvironment(e, true).cleaned : e;
  await write(scope === "globals" ? "globals.postman_globals.json" : `${fileName(e.name)}.postman_environment.json`, exportPostmanEnvironment(data, scope));
}

export async function exportBackupFile() {
  const s = useStore.getState();
  const globals: Environment = { id: "globals", name: "Globals", variables: s.globals };
  const findings = [
    ...s.collections.flatMap((c) => scanCollection(c).findings),
    ...s.environments.flatMap((e) => scanEnvironment(e).findings),
    ...scanEnvironment(globals).findings,
  ];
  const choice = await askAboutSecrets(findings);
  if (!choice) return;
  const strip = choice === "strip";
  const data: WorkspaceBackup = {
    localpost: 1,
    exportedAt: new Date().toISOString(),
    collections: s.collections.map((c) => (strip ? scanCollection(c, true).cleaned : c)),
    environments: s.environments.map((e) => (strip ? scanEnvironment(e, true).cleaned : e)),
    globals: strip ? scanEnvironment(globals, true).cleaned.variables : s.globals,
  };
  await write(`localpost-backup-${new Date().toISOString().slice(0, 10)}.json`, data);
}

// ---------------------------------------------------------------- linked folders

/** "Link to folder…": choose a folder and mirror the collection there (one file per request). */
export async function linkToFolder(c: Collection) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: `Choose a folder for “${c.name}” (e.g. inside a git repository)` });
  if (typeof dir !== "string") return;
  const files = await api.readDirFiles(dir, ["json"]).catch(() => []);
  const existing = files.find((f) => f.path === "collection.json");
  let mode: "load" | "overwrite" = "overwrite";
  if (existing) {
    let name = "a collection";
    try { name = `“${JSON.parse(existing.content).name}”`; } catch { /* ignore */ }
    const choice = await choiceDialog("Folder already has a collection",
      `${dir} already contains ${name}.\n\nLoad it into “${c.name}” (replacing its requests), or overwrite the folder with “${c.name}”?`,
      [{ label: "Overwrite folder", value: "overwrite", variant: "danger" }, { label: "Cancel", value: "cancel" }, { label: "Load from folder", value: "load", variant: "primary" }]);
    if (choice !== "load" && choice !== "overwrite") return;
    mode = choice;
  }
  const { linkCollection } = await import("../store");
  await linkCollection(c.id, dir, mode);
}
