// Headless tests for the core logic (no UI, no network). Run with `npm test`.
import { importCurl, importPostmanCollection, exportPostmanCollection, detectImport } from "../src/lib/importexport";
import { resolve, VarScope, emptyScopes } from "../src/lib/vars";
import { runScript, ScriptRequest } from "../src/lib/scripting";
import { prepareRequest, effectiveAuth } from "../src/lib/engine";
import { generate } from "../src/lib/codegen";
import { paramsFromUrl, buildUrl, parseQuery, syncPathVariables, applyPathVariables, newRequest, kv, defaultAuth } from "../src/lib/utils";
import { parseCsv } from "../src/lib/runner";
import { migrateSettings } from "../src/types";
import { buildPaletteIndex, rank, fuzzyScore, searchContents, replaceInItems, toTable, tableToCsv, diffEnvironments } from "../src/lib/search";
import { newCollection, newFolder } from "../src/lib/utils";
import { mockPathOf, compileRoutes } from "../src/lib/mock";
import { SseParser } from "../src/lib/sse";
import { md5 } from "../src/lib/crypto";
import { awsV4Headers, digestAuthorization, parseDigestChallenge, hawkHeader } from "../src/lib/authsign";
import { buildAuthorizeUrl, parseTokenResponse, defaultOAuth2, tokenExpired, decodeJwt } from "../src/lib/oauth";
import { certificateFor } from "../src/lib/engine";
import { scanCollection, scanEnvironment } from "../src/lib/leaks";
import { DEFAULT_SETTINGS } from "../src/types";
import { importBrunoFolder, exampleFromSchema, importOpenApi, exportHar } from "../src/lib/importers";
import { exportOpenApi, splitServer } from "../src/lib/exporters";
import { buildSite } from "../src/lib/docs/site";
import { buildMarkdownDocs } from "../src/lib/docs/markdown-export";
import { scanDocsText } from "../src/lib/leaks";
import { docsDrift } from "../src/lib/docs/drift";
import { lintDocs } from "../src/lib/docs/lint";
import { changelogMarkdown, diffCollections } from "../src/lib/docs/changelog";
import { useStore as docsStore, planExampleCapture, applyExampleCapture } from "../src/store";
import { collectionToFiles, filesToCollection, slugify } from "../src/lib/linked";
import * as tools from "../src/lib/tools";
import { inferSchema, schemaRows } from "../src/lib/docs/schema";
import { renderDocsMarkdown, requestLinks } from "../src/lib/docs/markdown";
import { buildDocsModel, endpoints } from "../src/lib/docs/model";
import { cloneWithNewIds } from "../src/lib/utils";

let fails = 0;
const ok = (c: any, m: string) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };

// curl
const r = importCurl(`curl -X POST 'https://api.x.com/users?a=1' -H 'Content-Type: application/json' -H "Authorization: Bearer t" --data-raw '{"name":"Ada"}' -u bob:pw`);
ok(r.method === "POST" && r.url === "https://api.x.com/users?a=1", "curl method/url");
ok(r.headers.length === 2 && r.body.mode === "raw" && r.body.rawLanguage === "json" && r.body.raw.includes('"name": "Ada"'), "curl headers/body");
ok(r.auth.type === "basic" && r.auth.basic.username === "bob", "curl basic auth");
ok(r.params[0].key === "a", "curl params");
const r2 = importCurl(`curl https://x.com/up -F 'file=@/tmp/a.png' -F name=bob`);
ok(r2.method === "POST" && r2.body.mode === "formdata" && r2.body.formdata[0].type === "file", "curl form");
const r3 = importCurl(`curl 'https://x.com' \\\n  --data-urlencode 'q=a b' -d x=1`);
ok(r3.body.mode === "urlencoded" && r3.body.urlencoded.some(f => f.key === "q" && f.value === "a b"), "curl urlencode");
const r4 = importCurl(`curl https://x.com/api -H 'Accept: */*' --compressed`);
ok(r4.method === "GET" && r4.body.mode === "none", "curl GET compressed");

// settings migration (theme used to hold the colour mode)
const m1 = migrateSettings({ theme: "light" } as any);
ok(m1.mode === "light" && m1.theme === "spotify", "settings: old theme=light becomes mode=light + default theme");
const m2 = migrateSettings({ theme: "postman", mode: "dark" });
ok(m2.theme === "postman" && m2.mode === "dark", "settings: new format kept as is");
ok(migrateSettings(null).theme === "spotify" && migrateSettings(null).mode === "dark", "settings: defaults");

// search: fuzzy ranking, full-text search, find & replace, tables, env diff
{
  ok(fuzzyScore("usr", "Get users") > 0 && fuzzyScore("xyz", "Get users") < 0, "fuzzy: subsequence match / no match");
  ok(fuzzyScore("get", "Get users") > fuzzyScore("gus", "Get users"), "fuzzy: contiguous beats scattered");
  const col = newCollection("Shop");
  const f = newFolder("Orders");
  const r1 = newRequest({ name: "List orders", url: "https://staging.shop.io/orders", headers: [kv("X-Env", "staging")] });
  const r2 = newRequest({ name: "Get user", url: "https://staging.shop.io/users/1" });
  r2.body = { ...r2.body, mode: "raw", raw: '{"email":"a@staging.shop.io"}' };
  f.items.push(r1); col.items.push(f, r2);
  const idx = buildPaletteIndex([col], [{ id: "e1", name: "Staging", variables: [] }]);
  ok(idx.length === 5, "palette index: collection, folder, 2 requests, env");
  ok(rank("list ord", idx)[0].title === "List orders", "palette rank: best match first");
  ok(rank("staging", idx)[0].title === "Staging", "palette rank: title match beats url match");
  const hits = searchContents("staging", [col]);
  ok(hits.some((h) => h.field === "headers" && h.name === "List orders") && hits.some((h) => h.field === "body" && h.name === "Get user"), "content search: headers and body");
  const h0 = hits[0];
  ok(h0.snippet.slice(h0.start, h0.end).toLowerCase() === "staging", "content search: snippet marks the match");
  const items = structuredClone(col.items);
  const changes = replaceInItems(items, "https://staging.shop.io", "{{baseUrl}}", { fields: ["url", "body"] });
  const flat = [(items[0] as any).items[0], items[1] as any];
  ok(changes.length === 2 && flat[0].url === "{{baseUrl}}/orders" && flat[1].url === "{{baseUrl}}/users/1", "replace: urls");
  ok(flat[0].headers[0].value === "staging" && flat[1].body.raw.includes("a@staging"), "replace: untouched fields/partial matches stay");
  const items2 = structuredClone(col.items);
  replaceInItems(items2, "users/(\\d+)", "people/$1", { regex: true, fields: ["url"] });
  ok((items2[1] as any).url.endsWith("/people/1"), "replace: regex with group reference");
  const items3 = structuredClone(col.items);
  replaceInItems(items3, "users", "$1", { fields: ["url"] });
  ok((items3[1] as any).url.endsWith("/$1/1"), "replace: literal mode keeps $1 literally");
  ok(replaceInItems(structuredClone(col.items), "ORDERS", "x", { caseSensitive: true, fields: ["url"] }).length === 0, "replace: case sensitive");
  const t = toTable({ data: [{ id: 1, name: "a" }, { id: 2, tags: ["x"] }] })!;
  ok(t.columns.join() === "id,name,tags" && t.rows.length === 2, "table: object array under a single key");
  ok(tableToCsv(t) === 'id,name,tags\n1,a,\n2,,"[""x""]"', "table: csv escaping");
  ok(toTable({ a: 1 }) === null && toTable([1, 2])!.columns[0] === "value", "table: non-tabular / primitives");
  const d = diffEnvironments([kv("a", "1"), kv("b", "2")], [kv("b", "3"), kv("c", "4")]);
  ok(d.map((x) => x.status).join() === "onlyA,different,onlyB", "env diff statuses");
}

// mock routes from examples
{
  const p = (u: string) => { const r = mockPathOf(u); return r.path + (r.query.length ? "?" + r.query.map((q) => `${q.key}=${q.value}`).join("&") : ""); };
  ok(p("{{baseUrl}}/users/:id?x=1") === "/users/:id?x=1", "mock path: strips {{baseUrl}}");
  ok(p("https://api.example.com/v1/users") === "/v1/users", "mock path: strips origin");
  ok(p("localhost:3000/a") === "/a" && p("api.example.com") === "/", "mock path: bare host");
  ok(p("https://{{host}}/x//y") === "/x/y" && p("{{path}}") === "/{{path}}", "mock path: variable host, double slash, lone var");
  const col = newCollection("M");
  const r = newRequest({ name: "Get user", method: "get", url: "{{baseUrl}}/users/:id" });
  r.examples = [
    { id: "e1", name: "found", status: 200, headers: [{ key: "Content-Type", value: "application/json" }, { key: "X-Off", value: "1", enabled: false }], body: "{}" },
    { id: "e2", name: "missing", status: 404, headers: [], body: "", request: { method: "GET", url: "{{baseUrl}}/users/999" } },
  ];
  const f = newFolder("F"); f.items.push(r); col.items.push(f);
  const routes = compileRoutes(col);
  ok(routes.length === 2 && routes[0].method === "GET" && routes[0].path === "/users/:id" && routes[1].path === "/users/999", "compileRoutes: nested, per-example url");
  ok(routes[0].headers.length === 1 && routes[0].requestName === "Get user", "compileRoutes: disabled headers dropped");
  const exported = exportPostmanCollection(col);
  const back = importPostmanCollection(exported);
  const br = (back.items[0] as any).items[0];
  ok(br.examples.length === 2 && br.examples[1].status === 404 && br.examples[1].request.url === "{{baseUrl}}/users/999", "postman round-trip keeps examples");
  ok(br.examples[0].headers.length === 1 && br.examples[0].headers[0].key === "Content-Type", "postman export drops disabled example headers");
}

// server-sent events parser
{
  const p = new SseParser();
  const got = [
    ...p.feed("\uFEFF: comment\n\ndata: hel"),
    ...p.feed("lo\ndata: world\n\nevent: tick\r\nid: 7\r\nretry: 3000\r\ndata: {\"n\":1}\r"),
    ...p.feed("\n\r\ndata:no-space\n\ndata\n\n"),
  ];
  ok(got.length === 4, "sse: four events across split chunks");
  ok(got[0].event === "message" && got[0].data === "hello\nworld", "sse: multi-line data joined");
  ok(got[1].event === "tick" && got[1].id === "7" && got[1].retry === 3000 && got[1].data === '{"n":1}', "sse: event/id/retry with CRLF split across chunks");
  ok(got[2].data === "no-space" && got[2].id === "7", "sse: no space after colon; last id persists");
  ok(got[3].data === "", "sse: field without value");
  ok(new SseParser().feed("data: x\n").length === 0, "sse: event not dispatched before blank line");
}

// auth signing: known test vectors
{
  ok(md5("") === "d41d8cd98f00b204e9800998ecf8427e" && md5("The quick brown fox jumps over the lazy dog") === "9e107d9d372bb6826bd81d3542a419d6", "md5 vectors");
  const ch = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
  const dh = await digestAuthorization(ch, { username: "Mufasa", password: "Circle Of Life" }, "GET", "/dir/index.html", { cnonce: "0a4f113b", nc: 1 });
  ok(dh.includes('response="6629fae49393a05397450978507c4ef1"') && dh.includes('opaque="5ccc069c403ebaf9f0171e9517f40e41"') && dh.includes("qop=auth,"), "digest: RFC 2617 example");
  ok(parseDigestChallenge("Basic realm=x") === null, "digest: ignores non-digest challenges");
  const aws = { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service" };
  const now = new Date("2015-08-30T12:36:00Z");
  const sig = async (url: string) => (await awsV4Headers("GET", url, [], "", aws, now)).find((h) => h.key === "Authorization")!.value;
  ok((await sig("https://example.amazonaws.com/")).endsWith("Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"), "aws sigv4: get-vanilla");
  ok((await sig("https://example.amazonaws.com/?Param2=value2&Param1=value1")).endsWith("Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"), "aws sigv4: query order");
  const s3 = await awsV4Headers("PUT", "https://b.s3.amazonaws.com/k", [], "x", { ...aws, service: "s3", sessionToken: "T" }, now);
  ok(s3.some((h) => h.key === "X-Amz-Content-Sha256") && s3.find((h) => h.key === "Authorization")!.value.includes("x-amz-security-token"), "aws sigv4: s3 payload hash + session token signed");
  const hk = await hawkHeader("GET", "http://example.com:8000/resource/1?b=1&a=2", { id: "dh37fgj492je", key: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn", algorithm: "sha256", ext: "some-app-ext-data" }, { ts: 1353832234, nonce: "j4h3g2" });
  ok(hk.includes('mac="6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE="'), "hawk: reference MAC");
}

// oauth helpers, client certificates, leak guard
{
  const c = { ...defaultOAuth2(), authUrl: "https://id.example.com/authorize?prompt=login", clientId: "app", scope: "read write" };
  const u = new URL(buildAuthorizeUrl(c, "st8", "chal"));
  ok(u.searchParams.get("prompt") === "login" && u.searchParams.get("redirect_uri") === "http://127.0.0.1:7890/callback" && u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("scope") === "read write", "oauth: authorize url");
  const t = parseTokenResponse(200, JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600, token_type: "bearer" }));
  ok(t.accessToken === "a1" && t.refreshToken === "r1" && !tokenExpired(t) && tokenExpired({ ...t, expiresAt: Date.now() - 1 }), "oauth: token json + expiry");
  ok(parseTokenResponse(200, "access_token=gh1&scope=repo&token_type=bearer").accessToken === "gh1", "oauth: form-encoded token response");
  let msg = ""; try { parseTokenResponse(400, '{"error":"invalid_grant","error_description":"bad code"}'); } catch (e: any) { msg = e.message; }
  ok(msg === "invalid_grant: bad code", "oauth: error response");
  ok((decodeJwt("x.eyJzdWIiOiIxMjMiLCJuYW1lIjoiQWRhIn0.y") as any)?.name === "Ada", "oauth: jwt claims");
  const settings = { ...DEFAULT_SETTINGS, certificates: [
    { id: "1", host: "*.corp.io", certPath: "/c.pem", keyPath: "", enabled: true },
    { id: "2", host: "api.x.io:8443", certPath: "/x.pem", keyPath: "/x.key", enabled: true },
    { id: "3", host: "off.io", certPath: "/o.pem", keyPath: "", enabled: false },
  ] };
  ok(certificateFor(settings, "https://a.b.corp.io/x")?.certPath === "/c.pem" && certificateFor(settings, "https://corp.io")?.certPath === "/c.pem", "certs: wildcard host");
  ok(certificateFor(settings, "https://api.x.io:8443/")?.keyPath === "/x.key" && certificateFor(settings, "https://api.x.io/") === null, "certs: port must match");
  ok(certificateFor(settings, "https://off.io") === null && certificateFor(settings, "not a url") === null, "certs: disabled / invalid");
  const col = newCollection("Leaky");
  col.variables = [kv("apiKey", "sekret", { secret: true }), kv("base", "http://x")];
  const req = newRequest({ name: "R", headers: [kv("Authorization", "Bearer abc"), kv("X-Token", "{{tok}}"), kv("Accept", "*/*")] });
  req.auth = { ...defaultAuth("bearer"), bearer: { token: "literal-token", prefix: "Bearer" } };
  const safe = newRequest({ name: "S" });
  safe.auth = { ...defaultAuth("bearer"), bearer: { token: "{{token}}", prefix: "Bearer" } };
  col.items.push(req, safe);
  const scan = scanCollection(col);
  ok(scan.findings.length === 3 && scan.findings.some((f) => f.what === "header Authorization") && scan.findings.some((f) => f.what === "Bearer token"), "leaks: secret var, auth token, auth header (not {{vars}})");
  const cleaned = scanCollection(col, true).cleaned;
  ok(cleaned.variables[0].value === "" && (cleaned.items[0] as any).auth.bearer.token === "" && (cleaned.items[0] as any).headers[0].value === "" && col.variables[0].value === "sekret", "leaks: strip cleans a copy only");
  ok(scanEnvironment({ id: "e", name: "E", variables: [kv("p", "x", { secret: true }), kv("q", "y")] }).findings.length === 1, "leaks: environment secrets");
}

// importers: OpenAPI, Swagger, HAR, Insomnia, Hoppscotch, Bruno
{
  const yaml = `openapi: 3.0.3
info: { title: Pets, version: "1.2", description: The pet store }
servers: [{ url: "https://{env}.pets.io/v1", variables: { env: { default: api } } }]
security: [{ bearer: [] }]
tags: [{ name: pets, description: Everything about pets }]
components:
  securitySchemes: { bearer: { type: http, scheme: bearer } }
  schemas:
    Pet: { type: object, properties: { id: { type: integer, example: 7 }, name: { type: string }, tag: { $ref: "#/components/schemas/Tag" } } }
    Tag: { type: string, enum: [dog, cat] }
paths:
  /pets/{petId}:
    parameters: [{ name: petId, in: path, required: true, schema: { type: integer, example: 42 } }]
    get:
      tags: [pets]
      summary: Get a pet
      parameters: [{ name: fields, in: query, schema: { type: string } }, { name: X-Trace, in: header, schema: { type: string, default: abc } }]
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Pet" } } } }
        "404": { description: Not found }
  /pets:
    post:
      tags: [pets]
      operationId: createPet
      security: []
      requestBody: { content: { application/json: { schema: { $ref: "#/components/schemas/Pet" } } } }
      responses: { "201": { description: Created } }
  /health: { get: { summary: Health, responses: { "200": { description: ok } } } }
`;
  const d = detectImport(yaml, "pets.yaml");
  ok(d.kind === "collection", "openapi yaml detected");
  if (d.kind === "collection") {
    const c = d.collection;
    ok(c.name === "Pets" && c.variables[0].value === "https://api.pets.io/v1" && c.auth.type === "bearer" && c.variables.some((v) => v.key === "bearerToken"), "openapi: base url with server variable, bearer auth + var");
    const folder = c.items.find((x) => x.type === "folder") as any;
    ok(folder?.name === "pets" && folder.description === "Everything about pets" && folder.items.length === 2, "openapi: tag folders");
    const get = folder.items[0];
    ok(get.url === "{{baseUrl}}/pets/:petId" && get.pathVariables[0].value === "42" && get.params[0].enabled === false && get.headers[0].value === "abc", "openapi: path vars, optional query, header default");
    ok(get.examples.length === 2 && JSON.parse(get.examples[0].body).tag === "dog" && get.examples[1].status === 404, "openapi: response examples from schema refs");
    const post = folder.items[1];
    ok(post.name === "createPet" && post.auth.type === "none" && JSON.parse(post.body.raw).id === 7, "openapi: operationId name, security [] = no auth, body example");
    ok(c.items.some((x) => x.name === "Health"), "openapi: untagged at root");
  }
  const swagger = { swagger: "2.0", info: { title: "Old" }, host: "old.io", basePath: "/api", schemes: ["http"],
    securityDefinitions: { key: { type: "apiKey", name: "X-Key", in: "header" } }, security: [{ key: [] }],
    paths: { "/login": { post: { consumes: ["application/x-www-form-urlencoded"], parameters: [{ name: "user", in: "formData", type: "string", default: "ada" }], responses: { "200": { description: "ok", schema: { type: "object", properties: { token: { type: "string" } } } } } } } } };
  const sw = detectImport(JSON.stringify(swagger));
  ok(sw.kind === "collection" && sw.collection.variables[0].value === "http://old.io/api" && sw.collection.auth.type === "apikey" && sw.collection.auth.apikey.key === "X-Key", "swagger 2: base url + api key");
  if (sw.kind === "collection") { const r = sw.collection.items[0] as any; ok(r.body.mode === "urlencoded" && r.body.urlencoded[0].value === "ada" && JSON.parse(r.examples[0].body).token === "string", "swagger 2: form params + response schema"); }
  ok(JSON.stringify(exampleFromSchema({}, { allOf: [{ properties: { a: { type: "boolean" } } }, { properties: { b: { type: "string", format: "email" } } }] })) === '{"a":true,"b":"user@example.com"}', "schema example: allOf + formats");

  const har = { log: { version: "1.2", entries: [
    { request: { method: "POST", url: "https://api.x.io/items?limit=2", headers: [{ name: ":authority", value: "x" }, { name: "Content-Type", value: "application/json" }], postData: { mimeType: "application/json", text: '{"a":1}' } },
      response: { status: 201, statusText: "Created", headers: [{ name: "content-type", value: "application/json" }], content: { text: '{"id":9}' } } },
    { request: { method: "GET", url: "https://cdn.y.io/a.js", headers: [] }, response: { status: 200, headers: [], content: {} } },
  ] } };
  const h = detectImport(JSON.stringify(har), "x.har");
  ok(h.kind === "collection" && h.collection.items.length === 2 && h.collection.items[0].name === "api.x.io", "har: folder per host");
  if (h.kind === "collection") { const r = (h.collection.items[0] as any).items[0]; ok(r.method === "POST" && r.headers.length === 1 && r.body.raw === '{"a":1}' && r.params[0].key === "limit" && r.examples[0].status === 201, "har: request + response example"); }

  const ins = { _type: "export", __export_format: 4, resources: [
    { _id: "wrk_1", _type: "workspace", name: "Shop" },
    { _id: "env_base", _type: "environment", parentId: "wrk_1", name: "Base", data: { host: "https://shop.io" } },
    { _id: "env_dev", _type: "environment", parentId: "env_base", name: "Dev", data: { host: "http://localhost" } },
    { _id: "fld_1", _type: "request_group", parentId: "wrk_1", name: "Orders" },
    { _id: "req_1", _type: "request", parentId: "fld_1", name: "List", method: "GET", url: "{{ _.host }}/orders", parameters: [{ name: "page", value: "1" }], headers: [{ name: "X-A", value: "b", disabled: true }], authentication: { type: "bearer", token: "{{ _.tok }}" }, body: {} },
  ] };
  const ib = detectImport(JSON.stringify(ins));
  ok(ib.kind === "bundle" && ib.collections[0].name === "Shop" && ib.collections[0].variables[0].key === "host" && ib.environments[0].name === "Dev", "insomnia: workspace, base env vars, sub env");
  if (ib.kind === "bundle") { const r = (ib.collections[0].items[0] as any).items[0]; ok(r.url === "{{host}}/orders?page=1" && r.auth.bearer.token === "{{tok}}" && r.headers[0].enabled === false, "insomnia: vars converted, params, disabled header, auth"); }

  const hopp = [{ v: 2, name: "Hopp", folders: [{ name: "F", folders: [], requests: [{ name: "In folder", method: "GET", endpoint: "<<url>>/a", params: [], headers: [], auth: { authType: "inherit", authActive: true } }] }],
    requests: [{ name: "Post", method: "POST", endpoint: "https://h.io/x", params: [{ key: "q", value: "1", active: true }], headers: [{ key: "K", value: "<<k>>", active: true }], body: { contentType: "application/json", body: '{"x":1}' }, auth: { authType: "bearer", token: "t", authActive: true } }] }];
  const hb = detectImport(JSON.stringify(hopp));
  ok(hb.kind === "bundle" && hb.collections[0].items.length === 2, "hoppscotch detected");
  if (hb.kind === "bundle") { const [f, r] = hb.collections[0].items as any[]; ok(f.items[0].url === "{{url}}/a" && r.url === "https://h.io/x?q=1" && r.headers[0].value === "{{k}}" && r.body.raw === '{"x":1}' && r.auth.type === "bearer", "hoppscotch: folders, vars, params, body, auth"); }

  const bru = (name: string, seq: number, extra = "") => `meta {\n  name: ${name}\n  type: http\n  seq: ${seq}\n}\n\npost {\n  url: {{baseUrl}}/users\n  body: json\n  auth: bearer\n}\n\nparams:query {\n  a: 1\n  ~b: 2\n}\n\nheaders {\n  Accept: application/json\n}\n\nauth:bearer {\n  token: {{token}}\n}\n\nbody:json {\n  {\n    "name": "Ada"\n  }\n}\n${extra}`;
  const one = detectImport(bru("Create", 1), "create.bru");
  ok(one.kind === "request" && one.request.method === "POST" && one.request.body.raw === '{\n  "name": "Ada"\n}' && one.request.params[1].enabled === false && one.request.auth.bearer.token === "{{token}}", "bruno: single .bru file");
  const bf = importBrunoFolder([
    { path: "bruno.json", content: '{"name":"Bru API","version":"1"}' },
    { path: "users/folder.bru", content: "meta {\n  name: Users & Co\n}\n" },
    { path: "users/b.bru", content: bru("Second", 2) },
    { path: "users/a.bru", content: bru("First", 1, "\ntests {\n  test('ok', () => {});\n}\n") },
    { path: "root.bru", content: bru("Root", 1) },
    { path: "environments/Local.bru", content: "vars {\n  baseUrl: http://localhost:3000\n}\nvars:secret [\n  token\n]\n" },
  ]);
  const uf = bf.collection.items.find((x) => x.type === "folder") as any;
  ok(bf.collection.name === "Bru API" && uf.name === "Users & Co" && uf.items.map((x: any) => x.name).join() === "First,Second", "bruno folder: name, folder.bru, seq order");
  ok(uf.items[0].testScript.includes("test('ok'") && bf.environments[0].name === "Local" && bf.environments[0].variables.some((v) => v.key === "token" && v.secret), "bruno folder: tests, environments with secrets");
  let err = ""; try { detectImport("hello: [world"); } catch (e: any) { err = e.message; }
  ok(err.startsWith("Unrecognised format"), "unknown input gives a helpful error");
}

// exporters: OpenAPI round trip, HTML docs, HAR
{
  ok(JSON.stringify(splitServer("{{baseUrl}}/users/:id/{{sub}}?x=1")) === '{"server":"{{baseUrl}}","path":"/users/{id}/{sub}"}' && splitServer("https://a.io").path === "/", "splitServer");
  const col = newCollection("Round <trip>");
  col.variables = [kv("baseUrl", "https://api.rt.io")];
  col.auth = { ...defaultAuth("bearer"), bearer: { token: "{{t}}", prefix: "Bearer" } };
  const f = newFolder("Users");
  const g = newRequest({ name: "Get user", method: "GET", url: "{{baseUrl}}/users/:id?verbose=true", params: [kv("verbose", "true")], pathVariables: [kv("id", "5")], headers: [kv("X-Trace", "1")] });
  g.examples = [{ id: "e", name: "found", status: 200, headers: [{ key: "Content-Type", value: "application/json" }], body: '{"id":5}' }];
  const p = newRequest({ name: "Create user", method: "POST", url: "{{baseUrl}}/users" });
  p.body = { ...p.body, mode: "raw", rawLanguage: "json", raw: '{"name":"<b>Ada</b>"}' };
  p.auth = defaultAuth("none");
  f.items.push(g, p); col.items.push(f);
  const doc = exportOpenApi(col);
  ok(doc.openapi === "3.1.0" && doc.servers[0].url === "https://api.rt.io" && doc.components.securitySchemes.bearerAuth && doc.tags[0].name === "Users", "openapi export: servers, security, tags");
  const op = doc.paths["/users/{id}"].get;
  ok(op.parameters.some((x: any) => x.in === "path" && x.example === "5") && op.parameters.some((x: any) => x.in === "header" && x.name === "X-Trace") && op.responses["200"].content["application/json"].examples.found.value.id === 5, "openapi export: params + examples");
  ok(doc.paths["/users"].post.security.length === 0 && doc.paths["/users"].post.requestBody.content["application/json"].example.name === "<b>Ada</b>", "openapi export: no-auth op, json body");
  const back = importOpenApi(doc);
  const bf = back.items[0] as any;
  ok(back.variables[0].value === "https://api.rt.io" && bf.items[0].url.startsWith("{{baseUrl}}/users/:id") && bf.items[0].examples[0].status === 200 && JSON.parse(bf.items[1].body.raw).name === "<b>Ada</b>", "openapi: export → import round trip");
  const [single] = buildSite(buildDocsModel(col), { singleFile: true });
  ok(single.content.includes("<title>Round &lt;trip&gt; — API documentation</title>") && single.content.includes("&lt;b&gt;Ada&lt;/b&gt;") && !single.content.includes("<b>Ada</b>") && single.content.includes('href="#get-get-user"'), "html docs: escaped, with toc anchors");
  const harDoc = exportHar([{ time: 0, request: p, status: 201, timeMs: 12 }]);
  ok(harDoc.log.entries[0].request.postData.text === '{"name":"<b>Ada</b>"}' && harDoc.log.entries[0].response.status === 201, "har export from history");
}

// linked (git-friendly) collections
{
  const col = newCollection("Git API");
  col.variables = [kv("base", "http://x"), kv("token", "hunter2", { secret: true })];
  col.preRequestScript = "console.log(1);\nconsole.log(2);";
  const f = newFolder("Users & Admins");
  const a = newRequest({ name: "Get user", url: "{{base}}/u/:id", pathVariables: [kv("id", "1")], headers: [kv("A", "1", { enabled: false })] });
  a.body = { ...a.body, mode: "raw", rawLanguage: "json", raw: '{\n  "x": 1\n}' };
  a.examples = [{ id: "ex1", name: "ok", status: 200, headers: [], body: "line1\nline2" }];
  const dup = newRequest({ name: "Get user" });
  const ws = newRequest({ name: "Socket", protocol: "ws", ws: { message: "hi", messageLanguage: "text", protocols: "", saved: [] } });
  f.items.push(a, dup);
  col.items.push(f, ws);
  const files = collectionToFiles(col);
  const paths = files.map((x) => x.path);
  ok(paths.join() === "collection.json,users-admins/get-user.request.json,users-admins/get-user-2.request.json,users-admins/folder.json,socket.request.json", `linked: file layout (${paths.join()})`);
  const root = JSON.parse(files[0].content);
  ok(root.variables[1].value === "" && root.variables[1].secret && Array.isArray(root.preRequestScript) && root.order.join() === "users-admins,socket.request.json", "linked: secrets not written, scripts as lines, order");
  const req = JSON.parse(files[1].content);
  ok(Array.isArray(req.body.raw) && req.headers[0].enabled === false && !("pinned" in req) && req.examples[0].body.length === 2, "linked: request file readable");
  const back = filesToCollection(files, col);
  const bf = back.items[0] as any;
  ok(back.id === col.id && back.variables[1].value === "hunter2" && back.preRequestScript === col.preRequestScript, "linked: round trip keeps ids, restores secrets from previous");
  ok(bf.name === "Users & Admins" && bf.items[0].body.raw === a.body.raw && bf.items[0].pathVariables[0].value === "1" && bf.items[1].name === "Get user" && (back.items[1] as any).protocol === "ws", "linked: round trip content");
  ok(JSON.stringify(collectionToFiles(back)) === JSON.stringify(files), "linked: stable output (no churn on re-save)");
  // A file added by hand (or by git merge) shows up even though it's not in `order`.
  const extra = [...files, { path: "users-admins/new-one.request.json", content: JSON.stringify({ id: "n1", name: "New one", method: "DELETE", url: "/n" }) }];
  const withExtra = filesToCollection(extra);
  ok((withExtra.items[0] as any).items.map((r: any) => r.name).join() === "Get user,Get user,New one", "linked: unlisted files are appended");
  ok(slugify("  Héllo, Wörld!  ") === "hello-world" && slugify("***") === "untitled", "slugify");
}

// params sync
const p = paramsFromUrl("https://x.com/{{path}}?a=1&b={{v}}", [kv("z","9",{enabled:false})]);
ok(p.length === 3 && p[1].value === "{{v}}" && !p[2].enabled, "params from url keep disabled");
const { base } = parseQuery("https://x.com?a=1");
ok(buildUrl(base, [kv("a","2"), kv("flag","")]) === "https://x.com?a=2&flag", "build url");

// path vars
const pv = syncPathVariables("https://x.com:8080/users/:id/posts/:postId?x=:no");
ok(pv.map(v => v.key).join() === "id,postId", "path var names (ignore port & query)");
ok(applyPathVariables("https://x.com:8080/users/:id?x=1", [kv("id","42")]) === "https://x.com:8080/users/42?x=1", "apply path vars");

// vars
const sc = emptyScopes();
sc.globals = new VarScope([kv("host","g.com"), kv("x","global")]);
sc.environment = new VarScope([kv("x","env"), kv("url","https://{{host}}")]);
ok(resolve("{{url}}/{{x}}/{{missing}}", sc) === "https://g.com/env/{{missing}}", "resolve precedence + nested");
ok(/^[0-9a-f-]{36}$/.test(resolve("{{$guid}}", sc)), "dynamic guid");

// scripting
const sreq = new ScriptRequest("https://a.com", "GET", [], { mode: "none" }, "Req", "1");
const out = await runScript(`
  pm.environment.set("token", "abc");
  pm.variables.set("local", 5);
  pm.request.headers.add({ key: "X-A", value: "1" });
  pm.request.url = pm.request.url.toString() + "/extra";
  console.log("hello", {a:1});
`, { scopes: sc, request: sreq, info: {eventName:"prerequest",requestName:"r",requestId:"1",iteration:0,iterationCount:1}, log: (l, a) => console.log("   [log]", l, JSON.stringify(a)), sendRequest: async () => { throw new Error("no"); } });
ok(!out.error && sc.environment.get("token") === "abc" && sc.local.get("local") === "5", "pre-request vars");
ok(sreq.rawUrl === "https://a.com/extra" && sreq.headers.get("x-a") === "1", "pre-request mutates request");

const resp = { status: 201, statusText: "Created", httpVersion: "HTTP/1.1", url: "", remoteAddr: null, headers: [{key:"Content-Type",value:"application/json"},{key:"set-cookie",value:"sid=xyz; Path=/"}], requestHeaders: [], bodyText: '{"id":7,"user":{"name":"Ada"}}', bodyBase64: null, isBinary: false, size: 30, headersSize: 10, timeMs: 12, ttfbMs: 10 };
const t = await runScript(`
  pm.test("status", () => pm.response.to.have.status(201));
  pm.test("created", () => { pm.response.to.be.success; });
  pm.test("json", () => { pm.expect(pm.response.json().user.name).to.eql("Ada"); });
  pm.test("header", () => pm.response.to.have.header("content-type"));
  pm.test("jsonBody", () => pm.response.to.have.jsonBody("user.name", "Ada"));
  pm.test("fails", () => pm.expect(1).to.equal(2));
  pm.test("async", async () => { await new Promise(r => setTimeout(r, 5)); pm.expect(true).to.be.true; });
  pm.test("cookie", () => pm.expect(pm.response.cookies.get("sid")).to.equal("xyz"));
  tests["legacy"] = responseCode.code === 201;
  pm.environment.set("id", pm.response.json().id);
  pm.execution.setNextRequest("Other");
`, { scopes: sc, request: sreq, response: resp, info: {eventName:"test",requestName:"r",requestId:"1",iteration:0,iterationCount:1}, log: () => {}, sendRequest: async () => resp });
const byName = Object.fromEntries(t.tests.map(x => [x.name, x]));
ok(byName.status.passed && byName.created.passed && byName.json.passed && byName.header.passed && byName.jsonBody.passed && byName.async.passed && byName.cookie.passed && byName.legacy.passed, "tests pass");
ok(!byName.fails.passed && /expected 1 to equal 2/.test(byName.fails.error!), "failing test reported: " + byName.fails.error);
ok(sc.environment.get("id") === "7" && t.nextRequest === "Other", "test-script var + setNextRequest");
const e = await runScript(`throw new Error("boom")`, { scopes: sc, request: sreq, info: {} as any, log: () => {}, sendRequest: async () => resp });
ok(e.error === "Error: boom", "script error surfaced");
const sr = await runScript(`pm.sendRequest("https://x", (err, res) => { pm.environment.set("sr", res.code); pm.test("inner", () => pm.expect(res.json().id).to.eql(7)); });`, { scopes: sc, request: sreq, info: {} as any, log: () => {}, sendRequest: async () => resp });
ok(sc.environment.get("sr") === "201" && sr.tests[0]?.passed, "pm.sendRequest callback awaited");

// prepare + auth inheritance
const col: any = { id: "c", name: "C", items: [], auth: { ...defaultAuth("bearer"), bearer: { token: "{{token}}", prefix: "Bearer" } }, variables: [], preRequestScript: "", testScript: "", description: "" };
const folder: any = { id: "f", type: "folder", name: "F", items: [], auth: defaultAuth("inherit") };
const req = newRequest({ method: "POST", url: "{{url}}/users/:id", pathVariables: [kv("id","9")], body: { mode: "raw", raw: '{"t":"{{token}}"}', rawLanguage: "json", urlencoded: [], formdata: [], binaryPath: "", graphql: { query: "", variables: "" } } });
const auth = effectiveAuth(req, [folder], col);
const prep = prepareRequest(req, auth, sc);
ok(prep.url === "https://g.com/users/9", "prepare url: " + prep.url);
ok(prep.headers.some(h => h.key === "Authorization" && h.value === "Bearer abc") && prep.headers.some(h => h.key === "Content-Type" && h.value === "application/json"), "inherited bearer + content-type");
ok(prep.body.type === "text" && (prep.body as any).content === '{"t":"abc"}', "body vars resolved");
const ak = prepareRequest(newRequest({ url: "x.com/a?b=1" }), { ...defaultAuth("apikey"), apikey: { key: "k", value: "v", in: "query" } }, sc);
ok(ak.url === "http://x.com/a?b=1&k=v", "apikey query + scheme default");

// codegen
const curl = generate("curl", prep);
ok(curl.includes("--request POST 'https://g.com/users/9'") && curl.includes("--data-raw"), "codegen curl");
for (const l of ["http","fetch","axios","python","go","powershell"] as const) ok(generate(l, prep).length > 20, "codegen " + l);

// postman roundtrip
const pmCol = { info: { name: "PM", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, auth: { type: "apikey", apikey: [{key:"key",value:"X-K"},{key:"value",value:"1"},{key:"in",value:"header"}] }, variable: [{key:"base",value:"https://a"}],
  event: [{ listen: "test", script: { exec: ["pm.test('x', ()=>{});"] } }],
  item: [{ name: "Folder", item: [{ name: "Get", request: { method: "GET", header: [{key:"A",value:"1",disabled:true}], url: { raw: "{{base}}/u/:id?x=1", query: [{key:"x",value:"1"},{key:"y",value:"2",disabled:true}], variable: [{key:"id",value:"5"}] } } }] },
    { name: "Post", request: { method: "POST", body: { mode: "urlencoded", urlencoded: [{key:"a",value:"b"}] }, url: "https://a/p", auth: { type: "basic", basic: [{key:"username",value:"u"},{key:"password",value:"p"}] } } }] };
const imp = importPostmanCollection(pmCol);
const f0: any = imp.items[0];
ok(imp.auth.type === "apikey" && imp.variables[0].key === "base" && imp.testScript.includes("pm.test"), "import collection meta");
ok(f0.type === "folder" && f0.items[0].params.length === 2 && !f0.items[0].params[1].enabled && f0.items[0].pathVariables[0].value === "5" && !f0.items[0].headers[0].enabled, "import request details");
ok((imp.items[1] as any).body.mode === "urlencoded" && (imp.items[1] as any).auth.type === "basic", "import body + auth");
const exp = exportPostmanCollection(imp);
const re = importPostmanCollection(JSON.parse(JSON.stringify(exp)));
ok(JSON.stringify(re.items.map((i: any) => i.name)) === JSON.stringify(["Folder","Post"]) && (re.items[0] as any).items[0].pathVariables[0].value === "5", "export → import roundtrip");
ok(detectImport(JSON.stringify(exp)).kind === "collection" && detectImport("curl https://x").kind === "request" && detectImport(JSON.stringify({ name: "E", values: [{key:"a",value:"b",enabled:true}] })).kind === "environment", "detectImport");

// csv
const csv = parseCsv('name,age\n"Ada, L",36\nBob,"4""2"\n');
ok(csv.length === 2 && csv[0].name === "Ada, L" && csv[1].age === '4"2', "csv parse");


// ---------------------------------------------------------------- dev toolbox
{
  const t = tools;
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  // encoders
  const s = "héllo wörld <a href=\"x\">&</a> 🎉";
  ok((["base64", "base64url", "url", "urlFull", "html", "hex", "unicode"] as const).every((c) => t.decode(c, t.encode(c, s)) === s), "codecs round-trip unicode text");
  ok(t.encode("base64", "hi?>") === "aGk/Pg==" && t.encode("base64url", "hi?>") === "aGk_Pg" && t.decode("base64", "aGk_Pg") === "hi?>", "base64 vs base64url");
  ok(t.decode("html", "&lt;b&gt; &#65;&#x42; &copy; &bogus;") === "<b> AB © &bogus;" && t.decode("url", "a+b%20c") === "a b c", "html entities + form-style url decode");
  let threw = false; try { t.decode("hex", "abc"); } catch { threw = true; }
  ok(threw, "odd-length hex rejected");
  // hashes (FIPS / RFC 2104 vectors)
  ok(hex(await t.digest("SHA-1", "abc")) === "a9993e364706816aba3e25717850c26c9cd0d89d" && hex(await t.digest("MD5", "abc")) === "900150983cd24fb0d6963f7d28e17f72", "digests");
  ok(hex(await t.hmacDigest("MD5", "Jefe", "what do ya want for nothing?")) === "750c783e6ab0b503eaa86e310a5db738", "HMAC-MD5 (RFC 2104)");
  ok(hex(await t.hmacDigest("SHA-256", "Jefe", "what do ya want for nothing?")) === "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", "HMAC-SHA256 (RFC 4231)");
  // JWT
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const d = t.decodeJwtFull("Bearer " + jwt);
  ok(d.header.alg === "HS256" && (d.payload as any).name === "John Doe" && d.times[0].date.toISOString() === "2018-01-18T01:30:22.000Z", "jwt decode");
  ok((await t.verifyJwt(jwt, "your-256-bit-secret")).valid && !(await t.verifyJwt(jwt, "wrong")).valid, "jwt HS256 verify");
  const made = await t.signJwtHs({ sub: "x", exp: 1 }, "k", "HS512");
  ok((await t.verifyJwt(made, "k")).valid && t.decodeJwtFull(made).expired, "jwt sign HS512 + expired");
  const toPem = (der: ArrayBuffer) => `-----BEGIN PUBLIC KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PUBLIC KEY-----`;
  for (const [alg, gen, sign] of [
    ["RS256", { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }],
    ["PS256", { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, { name: "RSA-PSS", saltLength: 32 }],
    ["ES256", { name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }],
  ] as const) {
    const kp = await crypto.subtle.generateKey(gen as any, true, ["sign", "verify"]) as CryptoKeyPair;
    const input = `${t.encode("base64url", JSON.stringify({ alg, typ: "JWT" }))}.${t.encode("base64url", '{"sub":"a"}')}`;
    const sig = Buffer.from(await crypto.subtle.sign(sign as any, kp.privateKey, new TextEncoder().encode(input))).toString("base64url");
    const pem = toPem(await crypto.subtle.exportKey("spki", kp.publicKey));
    const jwk = JSON.stringify({ keys: [await crypto.subtle.exportKey("jwk", kp.publicKey)] });
    ok((await t.verifyJwt(`${input}.${sig}`, pem)).valid && (await t.verifyJwt(`${input}.${sig}`, jwk)).valid && !(await t.verifyJwt(`${input}.${sig.slice(0, -4)}AAAA`, pem)).valid, `jwt ${alg} verify (PEM + JWKS)`);
  }
  // ids (RFC 9562 examples)
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(t.uuidv4()), "uuid v4 format");
  const v7 = t.uuidv7(1645557742000);
  ok(v7.startsWith("017f22e2-79b0-7") && t.inspectId(v7)?.date?.getTime() === 1645557742000, "uuid v7 timestamp");
  ok(t.inspectId("C232AB00-9414-11EC-B3C8-9F6BDECED846")?.date?.toISOString() === "2022-02-22T19:22:22.000Z" && t.inspectId("1EC9414C-232A-6B00-B3C8-9F6BDECED846")?.date?.toISOString() === "2022-02-22T19:22:22.000Z", "uuid v1/v6 timestamps");
  const u = t.ulid(1469922850259);
  ok(u.length === 26 && u.startsWith("01ARZ3NDEK") && t.inspectId("01ARZ3NDEKTSV4RRFFQ69G5FAV")?.date?.getTime() === 1469922850259, "ulid encode + decode");
  // time
  ok(t.parseTime("1700000000").date.getTime() === 1700000000000 && t.parseTime("1700000000000").unit === "ms" && t.parseTime("1700000000000000").date.getTime() === 1700000000000, "timestamp units by magnitude");
  ok(t.parseTime("2024-02-29T12:00:00Z").date.getTime() === 1709208000000 && t.relativeTime(new Date(0), 3 * 864e5) === "3 days ago" && t.relativeTime(new Date(7200e3), 0) === "in 2 hours", "dates + relative");
  // conversion
  const y = t.convertData('[{"a":1,"b":"x"},{"a":2,"c":true}]', "json", "yaml");
  ok(y.includes("- a: 1") && JSON.stringify(t.parseData(y, "yaml")) === '[{"a":1,"b":"x"},{"a":2,"c":true}]', "json ⇄ yaml");
  ok(t.convertData('[{"a":1,"b":"x, y"},{"a":2}]', "json", "csv") === 'a,b\n1,"x, y"\n2,' && t.convertData('a,b\n1,"x, y"', "csv", "json").includes('"b": "x, y"'), "json ⇄ csv");
  // json diff
  const ch = t.diffJson({ a: 1, b: { c: [1, 2] }, "x-y": 1 }, { a: 2, b: { c: [1] }, n: null });
  ok(JSON.stringify(ch.map((c) => `${c.kind} ${c.path}`)) === JSON.stringify(["changed $.a", "removed $.b.c[1]", 'removed $["x-y"]', "added $.n"]), "json diff paths");
  // regex
  const m = t.runRegex("(?<y>\\d{4})-(\\d{2})", "", "on 2024-05 and 1999-12.");
  ok(m.length === 2 && m[0].named?.y === "2024" && m[1].groups[1] === "12" && t.regexSegments("on 2024-05 and 1999-12.", m).map((x) => x.match ?? "-").join() === "-,0,-,1,-", "regex matches + segments");
  ok(t.runRegex("x*", "", "ab").length === 3, "regex empty matches terminate");
  // cron
  const fri = new Date(2026, 0, 2, 16, 50); // Friday
  const runs = t.nextRuns("*/15 9-17 * * 1-5", 5, fri);
  ok(runs.map((r) => `${r.getDate()} ${r.getHours()}:${r.getMinutes()}`).join() === "2 17:0,2 17:15,2 17:30,2 17:45,5 9:0", "cron next runs skip the weekend");
  ok(t.nextRuns("0 0 13 * FRI", 3, new Date(2026, 0, 1)).map((r) => r.getDate()).join() === "2,9,13", "cron day-of-month OR day-of-week");
  ok(t.nextRuns("0 12 29 2 *", 1, new Date(2025, 0, 1))[0].getFullYear() === 2028, "cron leap day");
  ok(t.describeCron("30 9 * * 1-5") === "At 09:30, Monday through Friday" && t.describeCron("@daily") === "At 00:00" && t.describeCron("*/5 * * * *") === "Every 5 minutes" && t.describeCron("0 0 1 JAN,JUL *") === "At 00:00, on the 1st of the month, in January and July", "cron descriptions");
  let bad = ""; try { t.parseCron("61 * * * *"); } catch (e: any) { bad = e.message; }
  ok(bad.includes("minute"), "cron validation");
}


// ---------------------------------------------------------------- API docs (D1)
{
  // schema rows: required, nesting, $ref (incl. recursion), arrays, oneOf, allOf
  const rows = schemaRows({ type: "object", required: ["id"], properties: {
    id: { type: "integer", description: "The id" },
    owner: { $ref: "#/$defs/User" },
    tags: { type: "array", items: { type: "string" } },
    pets: { type: "array", items: { oneOf: [{ title: "Cat", type: "object", properties: { meow: { type: "boolean" } } }, { title: "Dog", type: "object", properties: { bark: { type: "string" } } }] } },
    both: { allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }] },
  }, $defs: { User: { type: "object", properties: { name: { type: "string", enum: ["a", "b"] }, self: { $ref: "#/$defs/User" } } } } });
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  ok(byPath.id.required && byPath.id.type === "integer" && byPath.id.description === "The id" && !byPath.owner.required, "schema rows: required + description");
  ok(byPath["owner.name"].depth === 1 && JSON.stringify(byPath["owner.name"].enum) === '["a","b"]' && byPath["owner.self"] && !byPath["owner.self.name"], "schema rows: $ref + recursion stops");
  ok(byPath.tags.type === "array<string>" && byPath["pets[].meow"].variant === "Cat" && byPath["pets[].bark"].variant === "Dog", "schema rows: arrays + oneOf variants");
  ok(byPath["both.a"].required && byPath["both.b"] && !byPath["both.b"].required, "schema rows: allOf merged");
  ok(schemaRows("not json").length === 0 && schemaRows("").length === 0, "schema rows: invalid input is empty");
  const inf = inferSchema({ id: 1, at: "2024-01-01T00:00:00Z", list: [{ a: 1, b: null }, { a: 2.5, c: "x@y.io" }], maybe: null });
  ok(inf.required.join() === "id,at,list,maybe" && inf.properties.at.format === "date-time" && inf.properties.list.items.properties.a.type === "number"
    && inf.properties.list.items.required.join() === "a" && inf.properties.list.items.properties.c.format === "email", "infer schema: formats, merged array items, required");

  // markdown: raw HTML escaped, unsafe URLs dropped, callouts, request links, mermaid
  const html = renderDocsMarkdown("<script>x</script>\n\nText [a](javascript:alert(1)) [b](https://ok.io) [c](#req:r1) [d](#req:gone)\n\n> [!WARNING]\n> careful\n\n```mermaid\nA-->B\n```", { resolveRequest: (id) => (id === "r1" ? "get-x" : undefined) });
  ok(html.includes("&lt;script&gt;") && !html.includes("javascript:") && html.includes('href="https://ok.io" target="_blank"'), "docs markdown: escaping + safe links");
  ok(html.includes('href="#get-x"') && html.includes("req-link broken") && html.includes("callout-warning") && html.includes('<pre class="mermaid">A--&gt;B</pre>'), "docs markdown: request links, callouts, mermaid");
  ok(requestLinks("see [x](#req:abc) and [y](#req:d-e)").join() === "abc,d-e", "docs markdown: request link targets");

  // docs model
  const col = newCollection("Shop");
  col.variables = [kv("baseUrl", "https://api.shop.test"), kv("apiKey", "live-secret-123", { secret: true })];
  col.auth = { ...defaultAuth("bearer"), bearer: { token: "{{apiKey}}", prefix: "Bearer" } };
  const folder = newFolder("Orders");
  const list = newRequest({ name: "List orders", url: "{{baseUrl}}/orders?id={{$guid}}", description: "See [create](#req:CREATE)",
    params: [kv("id", "{{$guid}}", { description: "Filter", doc: { type: "string", format: "uuid", required: true } })],
    headers: [kv("X-Api-Key", "hardcoded-secret"), kv("Accept", "application/json")],
    examples: [{ id: "e1", name: "Other", status: 404, headers: [], body: "{}" }, { id: "e2", name: "OK", status: 200, headers: [], body: '{"ok":true}', default: true }] });
  const create = newRequest({ name: "Create order", method: "POST", url: "{{baseUrl}}/orders", body: { ...newRequest().body, mode: "raw", rawLanguage: "json", raw: '{"sku":"A1"}' },
    docs: { status: "beta", tags: ["orders"], bodySchema: '{"type":"object","required":["sku"],"properties":{"sku":{"type":"string"}}}' } });
  create.id = "CREATE";
  const hidden = newRequest({ name: "Internal", docs: { hidden: true } });
  folder.items = [list, create, hidden];
  col.items = [folder];
  col.pages = [{ id: "p1", title: "Intro", body: "Hi" }];
  const m = buildDocsModel(col, { languages: ["curl", "python"] });
  const eps = endpoints(m);
  ok(eps.length === 2 && !eps.some((e) => e.name === "Internal") && m.sections[0].kind === "folder" && m.pages[0].anchor === "page-intro", "docs model: structure, hidden skipped, pages");
  const le = eps[0];
  ok(le.url === "https://api.shop.test/orders?id={{$guid}}" && le.query[0].required && le.query[0].format === "uuid" && le.query[0].description === "Filter", "docs model: vars resolved, dynamic kept, param docs");
  const allText = JSON.stringify(m);
  ok(!allText.includes("live-secret-123") && !allText.includes("hardcoded-secret") && le.headers[0].value === "<value>", "docs model: secrets never appear");
  ok(le.samples.length === 2 && le.samples[0].code.includes("Authorization: Bearer <token>") && le.samples[1].lang === "python", "docs model: code samples with placeholders");
  ok(le.examples[0].name === "OK" && le.examples[0].default && le.examples[0].body.includes('"ok": true'), "docs model: default example first, pretty body");
  ok(eps[1].status === "beta" && eps[1].body?.schemaRows[0].required && m.anchors.CREATE === eps[1].anchor && le.auth?.includes("Bearer"), "docs model: status, body schema, anchors, auth");
  ok(JSON.stringify(buildDocsModel(col, { languages: ["curl"] })) === JSON.stringify(buildDocsModel(col, { languages: ["curl"] })), "docs model: deterministic");

  // persistence: linked folder + Postman round trips keep docs fields
  const files = collectionToFiles(col);
  ok(files.some((f) => f.path === "pages/intro.md" && f.content === "Hi\n"), "linked: pages written as Markdown");
  const back = filesToCollection(files);
  const bl = (back.items[0] as any).items;
  ok(back.pages?.[0].body === "Hi" && bl[0].params[0].doc.format === "uuid" && bl[1].docs.status === "beta" && bl[1].docs.bodySchema.includes("sku") && bl[2].docs.hidden && bl[0].examples[1].default, "linked: docs fields round-trip");
  const pm = importPostmanCollection(JSON.parse(JSON.stringify(exportPostmanCollection(col))));
  const pl = (pm.items[0] as any).items;
  ok(pm.pages?.[0].title === "Intro" && pl[0].params[0].doc.required && pl[0].params[0].description === "Filter" && pl[1].docs.tags[0] === "orders" && pl[0].examples[1].default, "postman: docs fields round-trip");

  // cloning remaps #req links
  const copy = cloneWithNewIds(folder);
  const cl = copy.items[0] as any, cc = copy.items[1];
  ok(cc.id !== "CREATE" && cl.description === `See [create](#req:${cc.id})`, "clone: request links follow new ids");
}


// ---------------------------------------------------------------- API docs (D2: publishing)
{
  const col = newCollection("Pets");
  col.variables = [kv("baseUrl", "https://api.pets.test"), kv("key", "k-123", { secret: true })];
  col.description = "Intro with a diagram\n\n```mermaid\nA-->B\n```";
  col.docsConfig = { version: "2.0", accent: "#8b5cf6", logo: "data:image/png;base64,iVBORw0KGgo=", languages: ["curl", "python"] };
  col.pages = [{ id: "g1", title: "Errors", body: "See [list](#req:L1)." }];
  const folder = newFolder("Pets");
  folder.description = "All about pets";
  const list = newRequest({ name: "List pets", url: "{{baseUrl}}/pets?limit=10", params: [kv("limit", "10", { description: "Page size", doc: { type: "integer", required: true, enum: ["10", "50"] } })],
    responseSchema: '{"type":"array","items":{"type":"object","required":["id"],"properties":{"id":{"type":"integer"}}}}',
    examples: [{ id: "x1", name: "OK", status: 200, headers: [{ key: "Content-Type", value: "application/json" }], body: '[{"id":1}]', description: "The list" }, { id: "x2", name: "Bad", status: 400, headers: [], body: '{"error":"x"}', schema: '{"type":"object","properties":{"error":{"type":"string"}}}' }] });
  list.id = "L1";
  const create = newRequest({ name: "Create pet", method: "POST", url: "{{baseUrl}}/pets", body: { ...newRequest().body, mode: "raw", rawLanguage: "json", raw: '{"name":"Rex","token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}' },
    docs: { status: "deprecated", tags: ["write"], bodySchema: '{"type":"object","required":["name"],"properties":{"name":{"type":"string","description":"Pet name"}}}' } });
  folder.items = [list, create];
  col.items = [folder];
  const model = buildDocsModel(col);

  // static site
  const site = buildSite(model, { mermaidJs: "/*mermaid*/" });
  const html = site.find((f) => f.path === "index.html")!.content;
  ok(site.map((f) => f.path).join() === "index.html,assets/docs.css,assets/docs.js,assets/mermaid.min.js", "site: folder layout (+mermaid only when used)");
  ok(buildSite({ ...model, description: "no diagram" }, { mermaidJs: "x" }).length === 3, "site: no mermaid asset without diagrams");
  const anchors = [...html.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
  ok(anchors.length > 5 && anchors.every((a) => html.includes(`id="${a}"`)), "site: every internal link has a target");
  ok(!/(src|href)="(https?:)?\/\//.test(html) && !html.includes("k-123"), "site: no remote resources, no secrets");
  ok(html.includes(':root{--accent:#8b5cf6}') && html.includes('<img src="data:image/png;base64,') && html.includes('<span class="badge">v2.0</span>'), "site: branding (accent, logo, version)");
  const idx = JSON.parse(html.match(/<script type="application\/json" id="search-index">([\s\S]*?)<\/script>/)![1]);
  ok(idx.some((x: any) => x.t === "List pets" && x.m === "GET" && x.u.includes("/pets")) && idx.some((x: any) => x.t === "Errors"), "site: search index");
  ok(html.includes('class="sample on" data-lang="curl"') && html.includes('data-lang="python"') && html.includes('<option value="python">'), "site: code samples + language switcher");
  ok(html.includes('class="ep deprecated"') && html.includes("status-deprecated") && html.includes("Pet name"), "site: status + body schema");
  const bad = buildSite({ ...model, accent: "red;}</style><script>alert(1)</script>", logo: "javascript:alert(1)" }, { singleFile: true })[0].content;
  ok(!bad.includes("<script>alert(1)") && !bad.includes("javascript:alert"), "site: accent/logo are validated");
  const one = buildSite(model, { singleFile: true, autoPrint: true, mermaidJs: "var m='</script>';" })[0].content;
  ok(one.includes("<style>") && one.includes("data-autoprint") && one.includes("var m='<\\/script>'") && !one.includes('src="assets/'), "site: single file inlines assets safely");

  // markdown export
  const md = buildMarkdownDocs(model);
  ok(md.map((f) => f.path).join() === "README.md,guides/errors.md,pets.md", "markdown: file layout");
  const readme = md[0].content, pets = md[2].content, guide = md[1].content;
  ok(readme.startsWith("<!-- Generated by Localpost.") && readme.includes("# Pets (v2.0)") && readme.includes("[`GET` List pets](pets.md#get-list-pets)") && readme.includes("[Errors](guides/errors.md)"), "markdown: README index");
  ok(guide.includes("[list](../pets.md#get-list-pets)"), "markdown: request links become relative file links");
  ok(pets.includes("# Pets") && pets.includes("## GET List pets") && pets.includes("| `limit` * | integer | Page size — One of: `10`, `50`") && pets.includes("_(deprecated)_") && pets.includes("```bash\ncurl"), "markdown: headings, param table, status, sample");

  // leak scan on published text
  const found = scanDocsText(model);
  ok(found.findings.some((f) => f.what === "JWT" && f.where.includes("Create pet")), "docs leaks: JWT in example body found");
  const red = scanDocsText(model, true).cleaned;
  ok(!JSON.stringify(red).includes("eyJhbGciOiJIUzI1NiJ9.eyJzdWI") && JSON.stringify(red).includes("<redacted>") && red.anchors.L1 === model.anchors.L1, "docs leaks: redaction keeps ids/anchors");
  ok(scanDocsText({ code: "--header 'X-Api-Key: <value>'", py: '"api_key": "<api-key>"' }).findings.length === 0, "docs leaks: placeholders aren't secrets");
  ok(scanDocsText({ body: '{"password":"hunter22"}', url: "https://bob:pa55w0rd@db.test" }).findings.length === 2, "docs leaks: passwords");

  // OpenAPI: docs fields out and back in
  const oa = exportOpenApi(col);
  const lop = oa.paths["/pets"].get, cop = oa.paths["/pets"].post;
  ok(oa.info.version === "2.0" && oa.info.description.includes("## Errors") && lop.parameters[0].required && lop.parameters[0].schema.type === "integer" && JSON.stringify(lop.parameters[0].schema.enum) === '["10","50"]', "openapi: version, pages, param docs");
  ok(lop.responses["200"].content["application/json"].schema.items.required[0] === "id" && lop.responses["400"].content["application/json"].schema.properties.error && (Object.values(lop.responses["200"].content["application/json"].examples)[0] as any).description === "The list", "openapi: response schemas + example descriptions");
  ok(cop.deprecated && cop.tags.join() === "Pets,write" && cop.requestBody.content["application/json"].schema.required[0] === "name", "openapi: deprecated, tags, body schema");
  const rt = importOpenApi(JSON.parse(JSON.stringify(oa)));
  const rl = (rt.items[0] as any).items[0], rc = (rt.items[0] as any).items[1];
  ok(rt.docsConfig?.version === "2.0" && rl.params[0].doc.required && rl.params[0].doc.type === "integer" && rl.params[0].description === "Page size" && JSON.parse(rl.responseSchema).items.required[0] === "id", "openapi import: param docs + response schema");
  ok(rc.docs.status === "deprecated" && rc.docs.tags[0] === "write" && JSON.parse(rc.docs.bodySchema).required[0] === "name" && rl.examples.find((e: any) => e.status === 400).schema.includes("error"), "openapi import: status, tags, body + error schemas");
  // $ref inlining with recursion
  const refDoc = { openapi: "3.0.0", info: { title: "R" }, paths: { "/n": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } } },
    components: { schemas: { Node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/components/schemas/Node" } } } } } };
  const node = JSON.parse(((importOpenApi(refDoc).items[0]) as any).responseSchema);
  ok(node.properties.name.type === "string" && node.properties.child.$ref === "#/components/schemas/Node", "openapi import: $refs inlined, recursion kept as $ref");
}


// ---------------------------------------------------------------- API docs (D3: accuracy)
{
  const res = (status: number, body: string) => ({ status, bodyText: body, headers: [{ key: "Content-Type", value: "application/json" }] });
  const r = newRequest({ name: "Get user", url: "{{base}}/users/:id",
    responseSchema: '{"type":"object","required":["id","name"],"properties":{"id":{"type":"integer"},"name":{"type":"string"}}}',
    examples: [{ id: "a", name: "OK", status: 200, headers: [], body: '{"id":1,"name":"A"}' }, { id: "b", name: "Missing", status: 404, headers: [], body: '{"error":"nope","code":7}' }] });
  const pass = docsDrift(r, res(200, '{"id":2,"name":"B","extra":true}'));
  ok(pass.length === 1 && pass[0].passed && pass[0].name.includes("response schema"), "drift: matching 200 passes against the response schema");
  const fail = docsDrift(r, res(200, '{"id":"2"}'));
  ok(!fail[0].passed && /name|integer/.test(fail[0].error ?? ""), "drift: schema violations fail with details");
  const inferred = docsDrift(r, res(404, '{"error":"gone","code":9,"more":null}'));
  ok(inferred[0].passed && inferred[0].name.includes("(inferred)") && !docsDrift(r, res(404, '{"error":5}'))[0].passed, "drift: other statuses use a relaxed schema inferred from the example");
  ok(!docsDrift(r, res(500, "{}"))[0].passed && docsDrift(r, res(500, "{}"))[0].name.includes("status 500"), "drift: undocumented status fails");
  ok(docsDrift(newRequest({ name: "x" }), res(200, "{}")).length === 0 && !docsDrift(r, res(200, "<html>"))[0].passed, "drift: undocumented requests skipped; non-JSON body fails");

  // lint
  const col = newCollection("L");
  const good = newRequest({ name: "Good", url: "{{b}}/a/:id", description: "Fine", pathVariables: [kv("id", "1", { description: "The id" })],
    params: [kv("q", "x", { description: "Query" })], headers: [kv("Accept", "*/*")],
    examples: [{ id: "g", name: "OK", status: 200, headers: [], body: "{}" }] });
  const bad = newRequest({ name: "Bad", url: "{{b}}/b/:bid", params: [kv("page", "1")], responseSchema: '{"type":"object","required":["id"]}', description: "see [gone](#req:nope) and [hidden](#req:HID)",
    docs: { bodySchema: "{not json" },
    examples: [{ id: "x", name: "One", status: 200, headers: [], body: '{"name":"no id"}' }, { id: "y", name: "Two", status: 201, headers: [], body: '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}' }] });
  const hid = newRequest({ name: "Hidden", docs: { hidden: true } }); hid.id = "HID";
  const bare = newRequest({ name: "Bare" });
  col.items = [good, bad, hid, bare];
  col.pages = [{ id: "p", title: "Empty", body: " " }];
  const issues = lintDocs(col, buildDocsModel(col));
  const rules = (name: string) => issues.filter((i) => i.target.name === name).map((i) => i.rule).sort();
  ok(rules("Good").length === 0, "lint: a fully documented request has no issues");
  ok(JSON.stringify(rules("Bad")) === JSON.stringify(["broken-link", "broken-link", "invalid-schema", "no-default-example", "stale-example", "stale-example", "undocumented-param", "undocumented-path-variable"]), `lint: request rules (${rules("Bad")})`);
  ok(rules("Bare").join() === "endpoint-description,no-example" && rules("Empty").join() === "empty-page" && !issues.some((i) => i.target.name === "Hidden"), "lint: missing docs, empty page, hidden skipped");
  ok(issues.some((i) => i.rule === "collection-description") && issues.some((i) => i.rule === "secret-in-docs") && issues[0].severity === "error", "lint: collection rules, secrets, errors first");

  // changelog
  const v1 = newCollection("API");
  const u1 = newRequest({ name: "Get user", url: "{{b}}/users/:id", params: [kv("fields", "", { doc: { enum: ["a", "b"] } })], responseSchema: '{"type":"object","properties":{"id":{"type":"integer"},"email":{"type":"string"}}}', examples: [{ id: "1", name: "OK", status: 200, headers: [], body: "{}" }] });
  const d1 = newRequest({ name: "Delete user", method: "DELETE", url: "{{b}}/users/:id" });
  v1.items = [u1, d1];
  const v2 = JSON.parse(JSON.stringify(v1));
  const u2 = v2.items[0];
  u2.url = "{{b}}/users/:userId";
  u2.params = [kv("fields", "", { doc: { enum: ["a"] } }), kv("expand", "", { doc: { required: true } })];
  u2.responseSchema = '{"type":"object","properties":{"id":{"type":"string"}}}';
  u2.docs = { status: "deprecated" };
  u2.examples.push({ id: "2", name: "Gone", status: 410, headers: [], body: "{}" });
  v2.items[1] = newRequest({ name: "Create user", method: "POST", url: "{{b}}/users" });
  const diff = diffCollections(v1, v2);
  ok(diff.added.length === 1 && diff.added[0].method === "POST" && diff.removed.length === 1 && diff.removed[0].method === "DELETE", "changelog: added/removed endpoints (variable names ignored)");
  const ch = diff.changed[0];
  ok(ch && ch.breaking && ch.changes.includes("Deprecated") && ch.changes.some((c) => c.includes("New query parameter `expand` (required)")) && ch.changes.some((c) => c.includes("removed `b`")) && ch.changes.some((c) => c.includes("removed `email`") && c.includes("`id.type`")) && ch.changes.some((c) => c.includes("410")), `changelog: changed endpoint details (${ch?.changes.join(" | ")})`);
  const cmd = changelogMarkdown(diff, "v1", "v2");
  ok(cmd.includes("> [!WARNING]") && cmd.includes("### Added") && cmd.includes("### Removed") && cmd.includes("**(breaking)**") && changelogMarkdown(diffCollections(v1, v1), "a", "b").includes("No API changes"), "changelog: markdown page");

  // capture examples from a run
  const cc = newCollection("Cap");
  const cr = newRequest({ name: "R", examples: [{ id: "e1", name: "Nice name", status: 200, headers: [], body: "{}", description: "kept" }] });
  cc.items = [cr];
  docsStore.setState({ collections: [cc] });
  const caps = [
    { requestId: cr.id, status: 200, statusText: "OK", headers: [{ key: "Content-Type", value: "application/json" }, { key: "Set-Cookie", value: "s=1" }], body: '{"v":1}' },
    { requestId: cr.id, status: 200, statusText: "OK", headers: [], body: '{"v":2}' },
    { requestId: cr.id, status: 404, statusText: "Not Found", headers: [], body: '{"e":1}' },
  ];
  const plan = planExampleCapture(cc.id, caps);
  ok(plan.update === 1 && plan.add === 1 && plan.responses.length === 2, "capture: plan (latest per status wins)");
  applyExampleCapture(cc.id, plan.responses);
  const ex = (docsStore.getState().collections[0].items[0] as any).examples;
  ok(ex.length === 2 && ex[0].name === "Nice name" && ex[0].description === "kept" && ex[0].body.includes('"v": 2') && ex[1].status === 404 && ex[1].name === "404 Not Found", "capture: updates keep name/description, new statuses added");
}

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
