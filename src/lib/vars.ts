import type { KV } from "../types";
import { uid } from "./utils";

/** A mutable variable scope, used for environments/globals/collection vars during a run. */
export class VarScope {
  private vars: KV[];
  changed = false;

  constructor(vars: KV[] = []) {
    this.vars = vars.map((v) => ({ ...v }));
  }

  private find(key: string) {
    return this.vars.find((v) => v.enabled && v.key === key);
  }
  has(key: string) {
    return !!this.find(key);
  }
  get(key: string): string | undefined {
    return this.find(key)?.value;
  }
  set(key: string, value: unknown) {
    const str = typeof value === "string" ? value : value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const existing = this.vars.find((v) => v.key === key);
    if (existing) {
      existing.value = str;
      existing.enabled = true;
    } else {
      this.vars.push({ id: uid(), key, value: str, enabled: true });
    }
    this.changed = true;
  }
  unset(key: string) {
    const before = this.vars.length;
    this.vars = this.vars.filter((v) => v.key !== key);
    if (this.vars.length !== before) this.changed = true;
  }
  clear() {
    this.vars = [];
    this.changed = true;
  }
  toObject(): Record<string, string> {
    const o: Record<string, string> = {};
    for (const v of this.vars) if (v.enabled && v.key) o[v.key] = v.value;
    return o;
  }
  toList(): KV[] {
    return this.vars;
  }
}

export interface Scopes {
  globals: VarScope;
  collection: VarScope;
  environment: VarScope;
  data: VarScope;
  local: VarScope;
}

export const emptyScopes = (): Scopes => ({
  globals: new VarScope(), collection: new VarScope(), environment: new VarScope(),
  data: new VarScope(), local: new VarScope(),
});

/** Postman precedence: local > data > environment > collection > global. */
export function lookup(scopes: Scopes, key: string): string | undefined {
  for (const s of [scopes.local, scopes.data, scopes.environment, scopes.collection, scopes.globals]) {
    const v = s.get(key);
    if (v !== undefined) return v;
  }
}

/** Where a variable resolves from — used for hover tooltips / highlighting. */
export function lookupSource(scopes: Scopes, key: string): { value: string; scope: string } | undefined {
  if (key.startsWith("$") && DYNAMIC[key]) return { value: "(dynamic)", scope: "Dynamic" };
  const order: [keyof Scopes, string][] = [
    ["local", "Local"], ["data", "Data"], ["environment", "Environment"], ["collection", "Collection"], ["globals", "Global"],
  ];
  for (const [k, label] of order) {
    const v = scopes[k].get(key);
    if (v !== undefined) return { value: v, scope: label };
  }
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function resolve(input: string, scopes: Scopes, depth = 0): string {
  if (!input || depth > 8 || !input.includes("{{")) return input;
  const out = input.replace(VAR_RE, (match, name: string) => {
    if (name.startsWith("$")) {
      const gen = DYNAMIC[name];
      return gen ? gen() : match;
    }
    const v = lookup(scopes, name);
    return v === undefined ? match : v;
  });
  return out !== input ? resolve(out, scopes, depth + 1) : out;
}

export function findVariables(input: string): string[] {
  return [...input.matchAll(VAR_RE)].map((m) => m[1]);
}

// ---------- dynamic variables ({{$guid}}, {{$timestamp}} ...) ----------

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const FIRST = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "Aarav", "Priya", "Wei", "Yuki", "Sofia", "Lucas", "Amara", "Omar"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Sharma", "Chen", "Tanaka", "Silva", "Okafor", "Haddad"];
const WORDS = ["alpha", "bravo", "cloud", "delta", "ember", "forest", "galaxy", "harbor", "island", "jungle", "kernel", "lemon", "matrix", "nebula", "orbit", "pixel", "quartz", "river", "signal", "tiger", "ultra", "vector", "willow", "xenon", "yonder", "zephyr"];
const CITIES = ["London", "Paris", "Tokyo", "New York", "Mumbai", "Berlin", "Sydney", "Toronto", "Lagos", "São Paulo", "Seoul", "Madrid"];
const COUNTRIES = ["India", "Japan", "Brazil", "Canada", "Germany", "France", "Kenya", "Australia", "Mexico", "Spain", "Norway", "Egypt"];
const COLORS = ["red", "green", "blue", "yellow", "purple", "orange", "black", "white", "teal", "pink", "gold", "silver"];
const DOMAINS = ["example.com", "example.org", "example.net", "test.dev"];
const alnum = (n: number) => Array.from({ length: n }, () => pick([..."abcdefghijklmnopqrstuvwxyz0123456789"])).join("");
const days = (n: number) => new Date(Date.now() + n * 86400000);

export const DYNAMIC: Record<string, () => string> = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randInt(0, 1000)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => alnum(1),
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  $randomUserName: () => `${pick(FIRST).toLowerCase()}${randInt(1, 999)}`,
  $randomEmail: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}@${pick(DOMAINS)}`,
  $randomPassword: () => alnum(15),
  $randomPhoneNumber: () => `${randInt(200, 999)}-${randInt(200, 999)}-${randInt(1000, 9999)}`,
  $randomCity: () => pick(CITIES),
  $randomCountry: () => pick(COUNTRIES),
  $randomWord: () => pick(WORDS),
  $randomWords: () => Array.from({ length: randInt(2, 5) }, () => pick(WORDS)).join(" "),
  $randomLoremSentence: () => { const s = Array.from({ length: randInt(5, 10) }, () => pick(WORDS)).join(" "); return s[0].toUpperCase() + s.slice(1) + "."; },
  $randomColor: () => pick(COLORS),
  $randomHexColor: () => "#" + randInt(0, 0xffffff).toString(16).padStart(6, "0"),
  $randomIP: () => `${randInt(1, 254)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
  $randomUrl: () => `https://${pick(WORDS)}.${pick(DOMAINS)}`,
  $randomDomainName: () => `${pick(WORDS)}.${pick(DOMAINS)}`,
  $randomPrice: () => (Math.random() * 1000).toFixed(2),
  $randomDateFuture: () => days(randInt(1, 365)).toISOString(),
  $randomDatePast: () => days(-randInt(1, 365)).toISOString(),
  $randomDateRecent: () => days(-Math.random() * 2).toISOString(),
  $randomCompanyName: () => `${pick(WORDS)[0].toUpperCase()}${pick(WORDS).slice(1)} ${pick(["Inc", "LLC", "Ltd", "Group"])}`,
  $randomJobTitle: () => pick(["Engineer", "Designer", "Manager", "Analyst", "Architect", "Consultant"]),
};
