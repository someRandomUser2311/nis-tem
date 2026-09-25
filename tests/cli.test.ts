// End-to-end test of the CLI runner against a throwaway local server (no network access needed).
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli/localpost";

let fails = 0;
const ok = (c: unknown, m: string) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok  ", m); };

const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/login") {
    res.writeHead(302, { Location: "/home", "Set-Cookie": "sid=abc123; Path=/; HttpOnly" });
    return res.end();
  }
  if (u.pathname === "/home") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(u.pathname === "/fail" ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ method: req.method, query: Object.fromEntries(u.searchParams), body, ua: req.headers["user-agent"] }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const dir = await mkdtemp(join(tmpdir(), "localpost-cli-"));
const collection = {
  info: { name: "CLI e2e", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  variable: [{ key: "base", value: `http://127.0.0.1:${port}` }],
  item: [
    { name: "Login (redirect + cookie)", request: { method: "GET", url: "{{base}}/login" },
      event: [{ listen: "test", script: { exec: ["pm.test('followed redirect with cookie', () => pm.expect(pm.response.json().cookie).to.eql('sid=abc123'));"] } }] },
    { name: "Post data row", request: { method: "POST", url: "{{base}}/echo?n={{n}}", body: { mode: "raw", raw: "{\"name\":\"{{name}}\"}" } },
      event: [{ listen: "test", script: { exec: [
        "pm.test('data row used', () => pm.expect(JSON.parse(pm.response.json().body).name).to.eql(pm.iterationData.get('name')));",
        "pm.test('cli user agent', () => pm.expect(pm.response.json().ua).to.match(/Localpost-CLI/));",
      ] } }] },
    { name: "Broken", request: { method: "GET", url: "{{base}}/fail" },
      event: [{ listen: "test", script: { exec: ["pm.test('is 200', () => pm.response.to.have.status(200));"] } }] },
  ],
};
const colPath = join(dir, "c.json");
await writeFile(colPath, JSON.stringify(collection));
await writeFile(join(dir, "data.json"), JSON.stringify([{ n: 1, name: "Ada" }, { n: 2, name: "Grace" }]));

const lines: string[] = [];
const out = (s: string) => lines.push(s);
const junit = join(dir, "r.xml"), html = join(dir, "r.html"), json = join(dir, "r.json");
const code = await main(["run", colPath, "-d", join(dir, "data.json"), "-r", "cli,junit,html,json",
  "--reporter-junit-export", junit, "--reporter-html-export", html, "--reporter-json-export", json], out);
const text = lines.join("\n");
ok(code === 1, "exit code 1 when a test fails");
ok(text.includes("Iteration 2/2") && text.includes("✓ followed redirect with cookie") && text.includes("✗ is 200"), "cli output: iterations, passes, failures");
const report = JSON.parse(await readFile(json, "utf8"));
ok(report.totals.requests === 6 && report.totals.passed === 6 && report.totals.failed === 2, `json report totals (${JSON.stringify(report.totals)})`);
const xml = await readFile(junit, "utf8");
ok(xml.startsWith("<?xml") && (xml.match(/<testsuite /g) ?? []).length === 6 && xml.includes('failures="2"'), "junit report");
ok((await readFile(html, "utf8")).includes("<title>CLI e2e — run report</title>"), "html report");

lines.length = 0;
const bail = await main(["run", colPath, "-n", "1", "--bail", "--silent"], out);
ok(bail === 1 && lines.length === 0, "--bail + --silent");
lines.length = 0;
const onlyGood = await main(["run", colPath, "-n", "1", "--folder", "nope"], out);
ok(onlyGood === 2 && lines.join().includes("No folder"), "unknown folder is a usage error");
ok((await main(["frobnicate"], () => {})) === 2 && (await main(["--help"], () => {})) === 0, "usage errors and --help");

server.close();
if (fails) { console.log(`\n${fails} CLI test(s) FAILED`); process.exit(1); }
console.log("\nCLI: ALL PASSED");
