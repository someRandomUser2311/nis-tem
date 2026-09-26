#!/usr/bin/env node
// Localpost CLI: run a collection headlessly (for CI), like Newman.
//
//   localpost run <collection> [options]
//
// <collection> is a Postman v2.x export, a Localpost backup, an OpenAPI/HAR/Insomnia/… file,
// or a linked-collection folder (with collection.json).
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { setInvoke } from "../src/lib/api";
import { detectImport, importPostmanEnvironment } from "../src/lib/importexport";
import { filesToCollection, LINKED_FILE } from "../src/lib/linked";
import { parseDataFile, startRun, type RunEntry } from "../src/lib/runner";
import { reportFailed, summarize, toHtmlReport, toJsonReport, toJUnit, type RunReport } from "../src/lib/reports";
import { flattenRequests, kv } from "../src/lib/utils";
import { DEFAULT_SETTINGS, type Collection, type Environment, type FolderItem, type KV } from "../src/types";
import { useStore } from "../src/store";
import { nodeInvoke } from "./transport";
import { docsCommand } from "./docs";

const HELP = `Localpost CLI — run a collection from the command line (no account, no network except your API).

Usage:
  localpost run <collection> [options]
  localpost docs <collection> [options]    (see: localpost docs --help)

<collection>  Postman collection (v2.0/v2.1), Localpost backup, OpenAPI / HAR / Insomnia /
              Hoppscotch file, or a linked-collection folder containing collection.json

Options:
  -e, --environment <file>     Postman environment file
  -g, --globals <file>         Postman globals file
      --env-var <key=value>    Set an environment variable (repeatable)
  -d, --iteration-data <file>  CSV or JSON data file (one iteration per row)
  -n, --iteration-count <n>    Number of iterations (default: data rows, or 1)
      --folder <name>          Only run the requests in this folder
      --collection <name>      Pick a collection when the file holds several
      --delay-request <ms>     Delay between requests
      --timeout-request <ms>   Per-request timeout (default 30000)
      --bail                   Stop at the first failed test or request error
      --docs-drift             Also check responses against the documented schemas / examples
  -k, --insecure               Don't verify SSL certificates
      --no-cookies             Don't keep cookies between requests
  -r, --reporters <list>       cli,json,junit,html (default: cli)
      --reporter-json-export <path>   (default: localpost-report.json)
      --reporter-junit-export <path>  (default: localpost-report.xml)
      --reporter-html-export <path>   (default: localpost-report.html)
      --silent                 No output (exit code only)
  -h, --help

Exit code: 0 when every test passed, 1 when a test failed or a request errored, 2 on usage errors.`;

interface Options {
  collection: string;
  environment?: string;
  globals?: string;
  envVars: [string, string][];
  data?: string;
  iterations?: number;
  folder?: string;
  collectionName?: string;
  delay: number;
  timeout: number;
  bail: boolean;
  docsDrift: boolean;
  insecure: boolean;
  cookies: boolean;
  reporters: string[];
  exports: Record<string, string>;
  silent: boolean;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): Options | "help" {
  const args = [...argv];
  if (!args.length || args[0] === "-h" || args[0] === "--help") return "help";
  if (args.shift() !== "run") throw new UsageError(`Unknown command. Try: localpost run <collection> or localpost docs <collection>`);
  const o: Options = { collection: "", envVars: [], delay: 0, timeout: 30000, bail: false, docsDrift: false, insecure: false, cookies: true, reporters: ["cli"], exports: {}, silent: false };
  const val = (flag: string) => { const v = args.shift(); if (v === undefined) throw new UsageError(`${flag} needs a value`); return v; };
  const num = (flag: string) => { const n = Number(val(flag)); if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} needs a number`); return n; };
  while (args.length) {
    const a = args.shift()!;
    switch (a) {
      case "-e": case "--environment": o.environment = val(a); break;
      case "-g": case "--globals": o.globals = val(a); break;
      case "--env-var": { const v = val(a); const i = v.indexOf("="); if (i < 1) throw new UsageError("--env-var expects key=value"); o.envVars.push([v.slice(0, i), v.slice(i + 1)]); break; }
      case "-d": case "--iteration-data": o.data = val(a); break;
      case "-n": case "--iteration-count": o.iterations = Math.max(1, Math.floor(num(a))); break;
      case "--folder": o.folder = val(a); break;
      case "--collection": o.collectionName = val(a); break;
      case "--delay-request": o.delay = num(a); break;
      case "--timeout-request": o.timeout = num(a); break;
      case "--bail": o.bail = true; break;
      case "--docs-drift": o.docsDrift = true; break;
      case "-k": case "--insecure": o.insecure = true; break;
      case "--no-cookies": o.cookies = false; break;
      case "-r": case "--reporters": o.reporters = val(a).split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--reporter-json-export": o.exports.json = val(a); break;
      case "--reporter-junit-export": o.exports.junit = val(a); break;
      case "--reporter-html-export": o.exports.html = val(a); break;
      case "--silent": o.silent = true; break;
      case "-h": case "--help": return "help";
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`);
        if (o.collection) throw new UsageError(`Unexpected argument ${a}`);
        o.collection = a;
    }
  }
  if (!o.collection) throw new UsageError("Missing <collection>");
  for (const r of o.reporters) if (!["cli", "json", "junit", "html"].includes(r)) throw new UsageError(`Unknown reporter ${r}`);
  return o;
}

async function walk(dir: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const visit = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await visit(p);
      else {
        const rel = relative(dir, p).replace(/\\/g, "/");
        if (LINKED_FILE.test(rel)) out.push({ path: rel, content: await readFile(p, "utf8") });
      }
    }
  };
  await visit(dir);
  return out;
}

export async function loadCollection(path: string, name?: string): Promise<{ collection: Collection; environments: Environment[] }> {
  if ((await stat(path)).isDirectory()) return { collection: filesToCollection(await walk(path)), environments: [] };
  const d = detectImport(await readFile(path, "utf8"), basename(path));
  const pick = (list: Collection[]) => {
    const c = name ? list.find((x) => x.name === name) : list[0];
    if (!c) throw new UsageError(name ? `No collection named "${name}" (have: ${list.map((x) => x.name).join(", ")})` : "The file has no collections");
    return c;
  };
  switch (d.kind) {
    case "collection": return { collection: d.collection, environments: [] };
    case "bundle": return { collection: pick(d.collections), environments: d.environments };
    case "workspace": return { collection: pick(d.data.collections), environments: d.data.environments };
    default: throw new UsageError(`${path} is not a collection`);
  }
}

const color = (code: number) => (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32), red = color(31), dim = color(2), bold = color(1), yellow = color(33);

export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  if (argv[0] === "docs") return docsCommand(argv.slice(1), out, loadCollection);
  let o: Options | "help";
  try {
    o = parseArgs(argv);
  } catch (e) {
    out(`${red("error")} ${e instanceof Error ? e.message : e}\n\n${HELP}`);
    return 2;
  }
  if (o === "help") { out(HELP); return 0; }
  const say = o.silent ? () => {} : out;

  setInvoke(nodeInvoke());
  let loaded;
  try {
    loaded = await loadCollection(o.collection, o.collectionName);
  } catch (e) {
    out(`${red("error")} Could not load ${o.collection}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const { collection } = loaded;

  let env: Environment | undefined;
  if (o.environment) env = importPostmanEnvironment(JSON.parse(await readFile(o.environment, "utf8")));
  else if (loaded.environments.length === 1) env = loaded.environments[0];
  if (o.envVars.length) {
    env ??= { id: "cli-env", name: "CLI", variables: [] };
    for (const [k, v] of o.envVars) {
      const existing = env.variables.find((x) => x.key === k);
      if (existing) { existing.value = v; existing.enabled = true; } else env.variables.push(kv(k, v));
    }
  }
  const globals: KV[] = o.globals ? importPostmanEnvironment(JSON.parse(await readFile(o.globals, "utf8"))).variables : [];
  const data = o.data ? parseDataFile(o.data, await readFile(o.data, "utf8")) : [];

  let items = collection.items;
  if (o.folder) {
    const find = (list: typeof items): FolderItem | undefined => {
      for (const it of list) {
        if (it.type !== "folder") continue;
        if (it.name === o.folder || it.id === o.folder) return it;
        const f = find(it.items);
        if (f) return f;
      }
    };
    const f = find(items);
    if (!f) { out(`${red("error")} No folder named "${o.folder}"`); return 2; }
    items = f.items;
  }
  // WebSocket / SSE requests are interactive; the runner skips them.
  const requests = flattenRequests(items).filter((r) => !r.protocol || r.protocol === "http");

  useStore.setState({
    collections: [collection],
    environments: env ? [env] : [],
    activeEnvironmentId: env?.id ?? null,
    globals,
    settings: { ...DEFAULT_SETTINGS, verifySsl: !o.insecure, timeoutMs: o.timeout, useCookies: o.cookies, useSystemProxy: true },
  });

  // Script console output is printed as it happens.
  let seen = 0;
  const unsub = useStore.subscribe((s) => {
    for (const c of s.console.slice(seen)) {
      if (c.level === "log" || c.level === "info" || c.level === "warn" || c.level === "error") {
        if (c.level === "info" && /^Run (started|finished|stopped)/.test(c.message)) continue;
        say(`    ${dim("┊")} ${c.level === "error" ? red(c.message) : c.level === "warn" ? yellow(c.message) : dim(c.message)}`);
      }
    }
    seen = s.console.length;
  });

  say(`\n${bold(collection.name)}${o.folder ? dim(` › ${o.folder}`) : ""}${env ? dim(` · environment “${env.name}”`) : ""}\n`);
  const entries: RunEntry[] = [];
  let lastIteration = -1;
  const iterations = o.iterations ?? (data.length || 1);
  const startedAt = Date.now();
  const handle = startRun(
    { collection, requests, iterations, delayMs: o.delay, data, persistVariables: false, stopOnError: o.bail, checkDocs: o.docsDrift },
    (e) => {
      entries.push(e);
      const status = e.error ? red(e.error) : `${e.status} ${e.statusText ?? ""}`.trim();
      say(`  ${e.method} ${e.url} ${dim("[")}${e.error ? status : (e.status ?? 0) < 400 ? green(status) : yellow(status)}${e.timeMs !== undefined ? dim(`, ${Math.round(e.timeMs)} ms`) : ""}${dim("]")}`);
      for (const t of e.tests) say(`  ${t.skipped ? dim("○ " + t.name + " (skipped)") : t.passed ? green("✓") + " " + t.name : red("✗ " + t.name) + (t.error ? dim(` — ${t.error}`) : "")}`);
    },
    (iteration, index) => {
      if (iterations > 1 && iteration !== lastIteration) { lastIteration = iteration; say(dim(`\nIteration ${iteration + 1}/${iterations}`)); }
      say(`→ ${bold(requests[index]?.name ?? "")}`);
    },
  );
  await handle.done;
  unsub();

  const report: RunReport = { collection: collection.name, startedAt, finishedAt: Date.now(), entries };
  const s = summarize(report);
  say(`\n${dim("─".repeat(52))}`);
  say(`  requests   ${s.requests}${s.failedRequests ? red(`  (${s.failedRequests} failed)`) : ""}`);
  say(`  tests      ${s.passed} passed${s.failed ? red(`, ${s.failed} failed`) : ""}${s.skipped ? dim(`, ${s.skipped} skipped`) : ""}`);
  say(`  avg time   ${s.avgResponseTimeMs} ms   total ${(s.durationMs / 1000).toFixed(1)} s`);
  say(dim("─".repeat(52)));

  const writers: Record<string, [string, () => string]> = {
    json: [o.exports.json ?? "localpost-report.json", () => toJsonReport(report)],
    junit: [o.exports.junit ?? "localpost-report.xml", () => toJUnit(report)],
    html: [o.exports.html ?? "localpost-report.html", () => toHtmlReport(report)],
  };
  for (const r of o.reporters) {
    if (r === "cli") continue;
    const [path, render] = writers[r];
    await writeFile(path, render());
    say(dim(`  ${r} report → ${path}`));
  }
  const failed = reportFailed(report);
  say(failed ? red("\n✗ Run failed\n") : green("\n✓ All tests passed\n"));
  return failed ? 1 : 0;
}

// Run when executed directly (not when imported by the tests).
const self = process.argv[1] ?? "";
if (/localpost(\.m?[jt]s)?$/.test(self)) main(process.argv.slice(2)).then((code) => process.exit(code));
