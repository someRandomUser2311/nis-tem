import type { Collection, RequestItem, TestResult } from "../types";
import { buildScopes, commitScopes, log, refreshTokenIfExpired, useStore } from "../store";
import { executeRequest } from "./engine";
import { findPath, uid } from "./utils";
import { docsDrift } from "./docs/drift";
import { api } from "./api";

export interface RunConfig {
  collection: Collection;
  requests: RequestItem[];
  iterations: number;
  delayMs: number;
  data: Record<string, unknown>[];
  persistVariables: boolean;
  stopOnError: boolean;
  /** Add "Docs: …" checks comparing each response with its documented schema / examples. */
  checkDocs?: boolean;
  /** Keep each response (body capped at 1 MB) on its entry, for "Update examples from this run". */
  keepResponses?: boolean;
}

/** A response kept on a run entry. */
export interface RunResponse {
  status: number;
  statusText: string;
  headers: { key: string; value: string }[];
  body: string;
}

const MAX_KEPT_BODY = 1024 * 1024;

export interface RunEntry {
  id: string;
  iteration: number;
  requestId: string;
  name: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  timeMs?: number;
  size?: number;
  error?: string;
  tests: TestResult[];
  response?: RunResponse;
}

export interface RunHandle {
  cancel: () => void;
  done: Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startRun(cfg: RunConfig, onEntry: (e: RunEntry) => void, onProgress: (iteration: number, index: number) => void): RunHandle {
  // WebSocket and SSE requests are interactive / long-lived; runs only send HTTP requests.
  const live = cfg.requests.filter((r) => r.protocol && r.protocol !== "http");
  if (live.length) {
    log("info", `Runner: skipping ${live.length} WebSocket/SSE request${live.length === 1 ? "" : "s"} (${live.map((r) => r.name).join(", ")})`);
    cfg = { ...cfg, requests: cfg.requests.filter((r) => !r.protocol || r.protocol === "http") };
  }
  let cancelled = false;
  let currentNativeId: string | null = null;

  const done = (async () => {
    const iterations = Math.max(1, cfg.data.length && cfg.iterations <= 1 ? cfg.data.length : cfg.iterations);
    // Scopes persist across the whole run so variables set by one request are seen by the next.
    const scopes = buildScopes(cfg.collection.id);
    log("info", `Run started: ${cfg.collection.name} (${cfg.requests.length} requests × ${iterations} iterations)`);

    outer: for (let it = 0; it < iterations; it++) {
      const row = cfg.data.length ? cfg.data[it % cfg.data.length] : {};
      const dataScopes = buildScopes(cfg.collection.id, row);
      scopes.data = dataScopes.data;
      scopes.local = dataScopes.local;

      let i = 0;
      let guard = 0;
      while (i < cfg.requests.length) {
        if (cancelled) break outer;
        if (++guard > cfg.requests.length * 50) { log("warn", "setNextRequest loop limit reached; stopping iteration"); break; }
        const req = cfg.requests[i];
        onProgress(it, i);
        await refreshTokenIfExpired(req, cfg.collection.id);
        const col = useStore.getState().collections.find((c) => c.id === cfg.collection.id) ?? cfg.collection;
        const folders = findPath(col.items, req.id) ?? [];
        currentNativeId = uid();
        const { result, nextRequest } = await executeRequest({
          request: req, collection: col, folders, scopes, settings: useStore.getState().settings, log,
          requestId: currentNativeId, iteration: it, iterationCount: iterations,
        });
        currentNativeId = null;
        if (cancelled) break outer;
        if (cfg.checkDocs && result.response) result.tests.push(...docsDrift(req, result.response));
        const res = result.response;

        onEntry({
          id: uid(), iteration: it, requestId: req.id, name: req.name, method: result.resolvedMethod, url: result.resolvedUrl,
          status: result.response?.status, statusText: result.response?.statusText, timeMs: result.response?.timeMs,
          size: result.response?.size, error: result.error, tests: result.tests,
          ...(cfg.keepResponses && res && !res.isBinary && res.bodyText.length <= MAX_KEPT_BODY
            ? { response: { status: res.status, statusText: res.statusText, headers: res.headers, body: res.bodyText } } : {}),
        });

        if (cfg.stopOnError && (result.error || result.tests.some((t) => !t.passed))) { log("warn", "Run stopped: error or failed test"); break outer; }
        if (nextRequest === null) { log("info", "Run stopped by setNextRequest(null)"); break outer; }
        if (typeof nextRequest === "string") {
          const idx = cfg.requests.findIndex((r) => r.name === nextRequest || r.id === nextRequest);
          i = idx >= 0 ? idx : i + 1;
        } else i++;

        if (cfg.delayMs > 0 && i < cfg.requests.length) await sleep(cfg.delayMs);
      }
    }
    if (cfg.persistVariables) commitScopes(scopes, cfg.collection.id);
    log("info", `Run ${cancelled ? "stopped" : "finished"}: ${cfg.collection.name}`);
  })();

  return {
    cancel: () => {
      cancelled = true;
      if (currentNativeId) api.cancel(currentNativeId);
    },
    done,
  };
}

// ---------------------------------------------------------------- data files

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export function parseDataFile(name: string, text: string): Record<string, unknown>[] {
  if (name.toLowerCase().endsWith(".json")) {
    const j = JSON.parse(text);
    if (!Array.isArray(j)) throw new Error("JSON data file must contain an array of objects");
    return j;
  }
  return parseCsv(text);
}
