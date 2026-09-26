// `localpost docs`: build a collection's documentation (static site, single HTML file, Markdown or
// OpenAPI) from the command line, e.g. in CI on every commit.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { stringify as toYaml } from "yaml";
import { importPostmanEnvironment } from "../src/lib/importexport";
import { exportOpenApi } from "../src/lib/exporters";
import { buildDocsModel } from "../src/lib/docs/model";
import { buildMarkdownDocs } from "../src/lib/docs/markdown-export";
import { buildSite } from "../src/lib/docs/site";
import { scanDocsText, summarize } from "../src/lib/leaks";
import { issueCounts, lintDocs } from "../src/lib/docs/lint";
import { kv } from "../src/lib/utils";
import type { Collection, Environment, KV } from "../src/types";

export const DOCS_HELP = `Usage:
  localpost docs <collection> [options]

Options:
  -o, --output <path>        Folder (site, markdown) or file (html, openapi). Default: ./docs,
                             ./<name>-docs.html or ./openapi.yaml
  -f, --format <format>      site (default) | html | markdown | openapi | openapi-json
  -e, --environment <file>   Postman environment whose (non-secret) values fill {{variables}}
  -g, --globals <file>       Postman globals file
      --env-var <key=value>  Set a variable (repeatable)
      --collection <name>    Pick a collection when the file holds several
      --no-redact            Keep credential-looking text (it is redacted by default)
      --check                Check the docs (missing descriptions, stale examples, broken
                             links…); exit 1 on errors. With no --output, nothing is written
      --strict               With --check, warnings fail too
      --silent               No output (exit code only)

Exit code: 0 on success, 1 when --check finds problems, 2 on usage errors.`;

class UsageError extends Error {}

type Format = "site" | "html" | "markdown" | "openapi" | "openapi-json";

interface DocsOptions {
  collection: string;
  output?: string;
  format: Format;
  environment?: string;
  globals?: string;
  envVars: [string, string][];
  collectionName?: string;
  redact: boolean;
  silent: boolean;
  check: boolean;
  strict: boolean;
}

function parse(argv: string[]): DocsOptions | "help" {
  const args = [...argv];
  const o: DocsOptions = { collection: "", format: "site", envVars: [], redact: true, silent: false, check: false, strict: false };
  const val = (flag: string) => { const v = args.shift(); if (v === undefined) throw new UsageError(`${flag} needs a value`); return v; };
  while (args.length) {
    const a = args.shift()!;
    switch (a) {
      case "-o": case "--output": o.output = val(a); break;
      case "-f": case "--format": {
        const f = val(a);
        if (!["site", "html", "markdown", "openapi", "openapi-json"].includes(f)) throw new UsageError(`Unknown format ${f}`);
        o.format = f as Format;
        break;
      }
      case "-e": case "--environment": o.environment = val(a); break;
      case "-g": case "--globals": o.globals = val(a); break;
      case "--env-var": { const v = val(a); const i = v.indexOf("="); if (i < 1) throw new UsageError("--env-var expects key=value"); o.envVars.push([v.slice(0, i), v.slice(i + 1)]); break; }
      case "--collection": o.collectionName = val(a); break;
      case "--no-redact": o.redact = false; break;
      case "--silent": o.silent = true; break;
      case "--check": o.check = true; break;
      case "--strict": o.strict = true; break;
      case "-h": case "--help": return "help";
      default:
        if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`);
        if (o.collection) throw new UsageError(`Unexpected argument ${a}`);
        o.collection = a;
    }
  }
  if (!o.collection) throw new UsageError("Missing <collection>");
  return o;
}

async function mermaidJs(): Promise<string | undefined> {
  try {
    return await readFile(createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js"), "utf8");
  } catch {
    return undefined; // Diagrams stay as code blocks.
  }
}

const slug = (s: string) => s.replace(/[^\w.-]+/g, "_");

export async function docsCommand(
  argv: string[],
  out: (s: string) => void,
  load: (path: string, name?: string) => Promise<{ collection: Collection; environments: Environment[] }>,
): Promise<number> {
  let o: DocsOptions | "help";
  try { o = parse(argv); } catch (e) { out(`error ${e instanceof Error ? e.message : e}\n\n${DOCS_HELP}`); return 2; }
  if (o === "help") { out(DOCS_HELP); return 0; }
  const say = o.silent ? () => {} : out;

  let loaded;
  try { loaded = await load(o.collection, o.collectionName); } catch (e) { out(`error Could not load ${o.collection}: ${e instanceof Error ? e.message : e}`); return 2; }
  const { collection } = loaded;
  let env: Environment | undefined = o.environment ? importPostmanEnvironment(JSON.parse(await readFile(o.environment, "utf8"))) : loaded.environments.length === 1 ? loaded.environments[0] : undefined;
  if (o.envVars.length) {
    env ??= { id: "cli-env", name: "CLI", variables: [] };
    for (const [k, v] of o.envVars) env.variables.push(kv(k, v));
  }
  const globals: KV[] = o.globals ? importPostmanEnvironment(JSON.parse(await readFile(o.globals, "utf8"))).variables : [];

  let checkFailed = false;
  if (o.check) {
    const issues = lintDocs(collection, buildDocsModel(collection, { environment: env, globals }));
    const n = issueCounts(issues);
    for (const i of issues) say(`${i.severity === "error" ? "✗" : i.severity === "warning" ? "!" : "·"} ${i.severity.padEnd(7)} ${i.target.name}: ${i.message} [${i.rule}]`);
    say(`${issues.length ? "" : "✓ "}Docs check: ${n.error} error${n.error === 1 ? "" : "s"}, ${n.warning} warning${n.warning === 1 ? "" : "s"}, ${n.info} suggestion${n.info === 1 ? "" : "s"}`);
    checkFailed = n.error > 0 || (o.strict && n.warning > 0);
    if (!o.output) return checkFailed ? 1 : 0;
  }

  if (o.format === "openapi" || o.format === "openapi-json") {
    const path = o.output ?? (o.format === "openapi" ? "openapi.yaml" : "openapi.json");
    const doc = exportOpenApi(collection);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, o.format === "openapi" ? toYaml(doc, { lineWidth: 0 }) : `${JSON.stringify(doc, null, 2)}\n`);
    say(`OpenAPI written to ${path}`);
    return checkFailed ? 1 : 0;
  }

  let model = buildDocsModel(collection, { environment: env, globals });
  const { findings } = scanDocsText(model);
  if (findings.length) {
    say(`${o.redact ? "Redacted" : "Warning: kept"} ${findings.length} credential-like value${findings.length === 1 ? "" : "s"}:\n${summarize(findings)}`);
    if (o.redact) model = scanDocsText(model, true).cleaned;
  }
  const files = o.format === "markdown" ? buildMarkdownDocs(model)
    : buildSite(model, { singleFile: o.format === "html", mermaidJs: await mermaidJs() });
  if (o.format === "html") {
    const path = o.output ?? `${slug(collection.name)}-docs.html`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, files[0].content);
    say(`Docs written to ${path}`);
  } else {
    const dir = o.output ?? "docs";
    for (const f of files) {
      const p = join(dir, f.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.content);
    }
    say(`${o.format === "markdown" ? "Markdown docs" : "Docs site"} written to ${dir} (${files.length} file${files.length === 1 ? "" : "s"})`);
  }
  return checkFailed ? 1 : 0;
}
