// Postman-compatible scripting sandbox (`pm.*`). Scripts are authored by the
// user, run locally, and have no network access except through pm.sendRequest.
import * as chai from "chai";
import { validateSchema } from "./schema";

// expect(value).to.be.jsonSchema(schema) / to.have.jsonSchema(schema)
chai.use((c) => {
  c.Assertion.addMethod("jsonSchema", function (this: Chai.AssertionStatic, schema: unknown) {
    const r = validateSchema(this._obj, schema);
    this.assert(r.valid, `expected data to match the JSON schema: ${r.errors.join("; ")}`, "expected data not to match the JSON schema", schema);
  });
});
import type { HttpResponse, TestResult } from "../types";
import { lookup, type Scopes, type VarScope, resolve } from "./vars";

export interface HeaderEntry { key: string; value: string; disabled?: boolean }

export class HeaderList {
  constructor(public list: HeaderEntry[]) {}
  private idx(key: string) {
    return this.list.findIndex((h) => h.key.toLowerCase() === key.toLowerCase());
  }
  get(key: string) { const i = this.idx(key); return i < 0 ? undefined : this.list[i].value; }
  has(key: string, value?: string) {
    const v = this.get(key);
    return v !== undefined && (value === undefined || v === value);
  }
  add(h: HeaderEntry | string) {
    this.list.push(typeof h === "string" ? parseHeaderLine(h) : { key: h.key, value: String(h.value) });
  }
  upsert(h: HeaderEntry) {
    const i = this.idx(h.key);
    if (i < 0) this.add(h); else this.list[i] = { key: h.key, value: String(h.value) };
  }
  remove(key: string) { this.list = this.list.filter((h) => h.key.toLowerCase() !== key.toLowerCase()); }
  toObject() { return Object.fromEntries(this.list.filter((h) => !h.disabled).map((h) => [h.key, h.value])); }
  each(fn: (h: HeaderEntry) => void) { this.list.forEach(fn); }
  all() { return this.list; }
  count() { return this.list.length; }
  toJSON() { return this.list; }
}

function parseHeaderLine(line: string): HeaderEntry {
  const i = line.indexOf(":");
  return i < 0 ? { key: line.trim(), value: "" } : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
}

/** Mutable request exposed as `pm.request`. */
export class ScriptRequest {
  private _url: string;
  headers: HeaderList;
  constructor(
    url: string,
    public method: string,
    headers: HeaderEntry[],
    public body: { mode: string; raw?: string; [k: string]: unknown },
    public name: string,
    public id: string,
  ) {
    this._url = url;
    this.headers = new HeaderList(headers);
  }
  get url(): any {
    const self = this;
    return {
      toString: () => self._url,
      update: (u: string) => { self._url = String(u); },
      getHost: () => { try { return new URL(self._url).hostname; } catch { return ""; } },
      getPath: () => { try { return new URL(self._url).pathname; } catch { return ""; } },
      getQueryString: () => self._url.split("?")[1] ?? "",
      addQueryParams: (params: string | { key: string; value: string }[]) => {
        const qs = typeof params === "string" ? params : params.map((p) => `${p.key}=${p.value}`).join("&");
        self._url += (self._url.includes("?") ? "&" : "?") + qs;
      },
    };
  }
  set url(v: unknown) { this._url = String(v); }
  get rawUrl() { return this._url; }
  addHeader(h: HeaderEntry) { this.headers.add(h); }
  removeHeader(k: string) { this.headers.remove(k); }
  upsertHeader(h: HeaderEntry) { this.headers.upsert(h); }
}

export function makeScriptResponse(res: HttpResponse) {
  const headers = new HeaderList(res.headers.map((h) => ({ ...h })));
  const text = () => res.bodyText;
  const json = () => JSON.parse(res.bodyText);
  const { expect } = chai;
  const response: any = {
    code: res.status,
    status: res.statusText,
    responseTime: Math.round(res.timeMs),
    responseSize: res.size,
    headers,
    text,
    json,
    reason: () => res.statusText,
    cookies: {
      get: (name: string) => {
        for (const h of res.headers) {
          if (h.key.toLowerCase() !== "set-cookie") continue;
          const [pair] = h.value.split(";");
          const eq = pair.indexOf("=");
          if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
        }
      },
      has: (name: string) => response.cookies.get(name) !== undefined,
    },
  };
  const statusCheck = (pred: (c: number) => boolean, label: string) => () => {
    expect(pred(res.status), `expected response to be ${label} but got ${res.status}`).to.equal(true);
    return true;
  };
  response.to = {
    have: {
      status: (s: number | string) => {
        if (typeof s === "number") expect(res.status, `expected response to have status code ${s} but got ${res.status}`).to.equal(s);
        else expect(res.statusText, `expected response to have status reason '${s}' but got '${res.statusText}'`).to.equal(s);
      },
      header: (name: string, value?: string) => {
        expect(headers.has(name), `expected response to have header ${name}`).to.equal(true);
        if (value !== undefined) expect(headers.get(name)).to.equal(value);
      },
      body: (v?: string | RegExp) => {
        if (v === undefined) expect(res.bodyText.length, "expected response to have a body").to.be.greaterThan(0);
        else if (v instanceof RegExp) expect(res.bodyText).to.match(v);
        else expect(res.bodyText).to.equal(v);
      },
      jsonSchema: (schema: unknown) => {
        const r = validateSchema(json(), schema);
        expect(r.valid, `expected response body to match the JSON schema: ${r.errors.join("; ")}`).to.equal(true);
      },
      jsonBody: (path?: string, value?: unknown) => {
        const body = json();
        if (path === undefined) return;
        const got = path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), body);
        if (value === undefined) expect(got, `expected response json to have path ${path}`).to.not.equal(undefined);
        else expect(got).to.deep.equal(value);
      },
    },
    be: {} as Record<string, unknown>,
  };
  const be: [string, (c: number) => boolean][] = [
    ["ok", (c) => c === 200], ["success", (c) => c >= 200 && c < 300], ["info", (c) => c >= 100 && c < 200],
    ["redirection", (c) => c >= 300 && c < 400], ["clientError", (c) => c >= 400 && c < 500],
    ["serverError", (c) => c >= 500], ["error", (c) => c >= 400], ["accepted", (c) => c === 202],
    ["badRequest", (c) => c === 400], ["unauthorized", (c) => c === 401], ["forbidden", (c) => c === 403],
    ["notFound", (c) => c === 404], ["rateLimited", (c) => c === 429],
  ];
  for (const [name, pred] of be) Object.defineProperty(response.to.be, name, { get: statusCheck(pred, name) });
  Object.defineProperty(response.to.be, "json", {
    get: () => { expect(() => json(), "expected response body to be valid JSON").to.not.throw(); return true; },
  });
  response.to.not = { have: { status: (s: number) => expect(res.status).to.not.equal(s) } };
  return response;
}

export interface ScriptContext {
  scopes: Scopes;
  request: ScriptRequest;
  response?: HttpResponse;
  info: { eventName: "prerequest" | "test"; requestName: string; requestId: string; iteration: number; iterationCount: number };
  log: (level: "log" | "info" | "warn" | "error", args: unknown[]) => void;
  sendRequest: (req: unknown) => Promise<HttpResponse>;
}

export interface ScriptOutcome {
  tests: TestResult[];
  error?: string;
  /** undefined = not called; null = stop the run. */
  nextRequest?: string | null;
  skipRequest?: boolean;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function scopeApi(scope: VarScope, scopes: Scopes) {
  return {
    get: (k: string) => scope.get(k),
    set: (k: string, v: unknown) => scope.set(k, v),
    unset: (k: string) => scope.unset(k),
    has: (k: string) => scope.has(k),
    clear: () => scope.clear(),
    toObject: () => scope.toObject(),
    replaceIn: (s: string) => resolve(s, scopes),
  };
}

export async function runScript(code: string, ctx: ScriptContext): Promise<ScriptOutcome> {
  const outcome: ScriptOutcome = { tests: [] };
  if (!code.trim()) return outcome;

  const pending: Promise<unknown>[] = [];
  const { scopes } = ctx;

  const record = (name: string, r: Promise<unknown> | unknown) => {
    if (r && typeof (r as Promise<unknown>).then === "function") {
      pending.push(
        (r as Promise<unknown>).then(
          () => outcome.tests.push({ name, passed: true }),
          (e) => outcome.tests.push({ name, passed: false, error: errMsg(e) }),
        ),
      );
    } else outcome.tests.push({ name, passed: true });
  };

  const test: any = (name: string, fn: () => unknown) => {
    try { record(name, fn()); } catch (e) { outcome.tests.push({ name, passed: false, error: errMsg(e) }); }
  };
  test.skip = (name: string) => outcome.tests.push({ name, passed: true, skipped: true });

  const response = ctx.response ? makeScriptResponse(ctx.response) : undefined;
  const setNext = (name: string | null) => { outcome.nextRequest = name; };

  const pm = {
    test,
    expect: chai.expect,
    request: ctx.request,
    response,
    info: ctx.info,
    environment: { ...scopeApi(scopes.environment, scopes) },
    globals: scopeApi(scopes.globals, scopes),
    collectionVariables: scopeApi(scopes.collection, scopes),
    iterationData: { get: (k: string) => scopes.data.get(k), has: (k: string) => scopes.data.has(k), toObject: () => scopes.data.toObject() },
    variables: {
      get: (k: string) => lookup(scopes, k),
      set: (k: string, v: unknown) => scopes.local.set(k, v),
      has: (k: string) => lookup(scopes, k) !== undefined,
      unset: (k: string) => scopes.local.unset(k),
      replaceIn: (s: string) => resolve(s, scopes),
      toObject: () => ({ ...scopes.globals.toObject(), ...scopes.collection.toObject(), ...scopes.environment.toObject(), ...scopes.data.toObject(), ...scopes.local.toObject() }),
    },
    sendRequest: (req: unknown, cb?: (err: unknown, res: unknown) => void) => {
      const p = ctx.sendRequest(req).then(
        (r) => { const sr = makeScriptResponse(r); cb?.(null, sr); return sr; },
        (e) => { cb?.(e, null); if (!cb) throw e; },
      );
      pending.push(p.catch(() => {}));
      return p;
    },
    execution: {
      setNextRequest: setNext,
      skipRequest: () => { outcome.skipRequest = true; },
    },
  };

  const legacyTests: Record<string, unknown> = {};
  const postman = {
    setNextRequest: setNext,
    setEnvironmentVariable: (k: string, v: unknown) => scopes.environment.set(k, v),
    getEnvironmentVariable: (k: string) => scopes.environment.get(k),
    clearEnvironmentVariable: (k: string) => scopes.environment.unset(k),
    setGlobalVariable: (k: string, v: unknown) => scopes.globals.set(k, v),
    getGlobalVariable: (k: string) => scopes.globals.get(k),
    clearGlobalVariable: (k: string) => scopes.globals.unset(k),
  };

  // Legacy Postman scripts use tv4 for schema checks.
  const tv4 = {
    error: null as null | { message: string },
    validate(data: unknown, schema: unknown) {
      const r = validateSchema(data, schema);
      tv4.error = r.valid ? null : { message: r.errors.join("; ") };
      return r.valid;
    },
  };

  const fmt = (level: "log" | "info" | "warn" | "error") => (...args: unknown[]) => ctx.log(level, args);
  const sandboxConsole = { log: fmt("log"), info: fmt("info"), warn: fmt("warn"), error: fmt("error"), debug: fmt("log") };

  try {
    const fn = new AsyncFunction(
      "pm", "postman", "console", "tests", "tv4", "responseBody", "responseCode", "responseHeaders", "responseTime",
      code,
    );
    await fn(
      pm, postman, sandboxConsole, legacyTests, tv4,
      ctx.response?.bodyText,
      ctx.response ? { code: ctx.response.status, name: ctx.response.statusText } : undefined,
      ctx.response ? Object.fromEntries(ctx.response.headers.map((h) => [h.key, h.value])) : undefined,
      ctx.response ? Math.round(ctx.response.timeMs) : undefined,
    );
    // Settle async tests and sendRequest callbacks (which may add more work).
    let settled = 0;
    while (settled < pending.length) {
      const batch = pending.slice(settled);
      settled = pending.length;
      await Promise.all(batch);
    }
  } catch (e) {
    outcome.error = errMsg(e);
  }
  for (const [name, passed] of Object.entries(legacyTests)) outcome.tests.push({ name, passed: !!passed });
  return outcome;
}
