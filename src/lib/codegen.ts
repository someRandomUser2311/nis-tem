// Code snippet generation from a prepared (resolved) request.
import type { PreparedRequest } from "./engine";

export const LANGUAGES = [
  { id: "curl", label: "cURL", cm: "text" },
  { id: "http", label: "HTTP", cm: "text" },
  { id: "fetch", label: "JavaScript - Fetch", cm: "javascript" },
  { id: "axios", label: "NodeJS - Axios", cm: "javascript" },
  { id: "python", label: "Python - Requests", cm: "text" },
  { id: "go", label: "Go - net/http", cm: "text" },
  { id: "powershell", label: "PowerShell - Invoke-RestMethod", cm: "text" },
  { id: "httpie", label: "HTTPie", cm: "text" },
  { id: "wget", label: "wget", cm: "text" },
  { id: "java", label: "Java - HttpClient", cm: "text" },
  { id: "csharp", label: "C# - HttpClient", cm: "text" },
  { id: "php", label: "PHP - cURL", cm: "text" },
  { id: "ruby", label: "Ruby - Net::HTTP", cm: "text" },
  { id: "rust", label: "Rust - reqwest", cm: "text" },
  { id: "swift", label: "Swift - URLSession", cm: "text" },
] as const;

export type LanguageId = (typeof LANGUAGES)[number]["id"];

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const dq = (s: string) => JSON.stringify(s);

function bodyText(r: PreparedRequest): string | undefined {
  if (r.body.type === "text") return r.body.content;
  if (r.body.type === "urlEncoded") return r.body.fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join("&");
  return undefined;
}

export function generate(lang: LanguageId, prepared: PreparedRequest): string {
  const r = { ...prepared, url: prepared.url.replace(/ /g, "%20") };
  switch (lang) {
    case "curl": return curl(r);
    case "http": return http(r);
    case "fetch": return fetchJs(r);
    case "axios": return axios(r);
    case "python": return python(r);
    case "go": return go(r);
    case "powershell": return powershell(r);
    case "httpie": return httpie(r);
    case "wget": return wget(r);
    case "java": return java(r);
    case "csharp": return csharp(r);
    case "php": return php(r);
    case "ruby": return ruby(r);
    case "rust": return rust(r);
    case "swift": return swift(r);
  }
}

function curl(r: PreparedRequest) {
  const lines = [`curl --location --request ${r.method} ${sq(r.url)}`];
  for (const h of r.headers) lines.push(`--header ${sq(`${h.key}: ${h.value}`)}`);
  if (r.body.type === "text") lines.push(`--data-raw ${sq(r.body.content)}`);
  if (r.body.type === "urlEncoded") for (const f of r.body.fields) lines.push(`--data-urlencode ${sq(`${f.key}=${f.value}`)}`);
  if (r.body.type === "formData") for (const f of r.body.fields) lines.push(`--form ${sq(`${f.key}=${f.kind === "file" ? "@" : ""}${f.value}`)}`);
  if (r.body.type === "binary") lines.push(`--data-binary ${sq("@" + r.body.path)}`);
  return lines.join(" \\\n");
}

function http(r: PreparedRequest) {
  let u: URL | null = null;
  try { u = new URL(r.url); } catch { /* ignore */ }
  const lines = [`${r.method} ${u ? u.pathname + u.search : r.url} HTTP/1.1`];
  if (u) lines.push(`Host: ${u.host}`);
  for (const h of r.headers) lines.push(`${h.key}: ${h.value}`);
  if (r.body.type === "urlEncoded" && !r.headers.some((h) => h.key.toLowerCase() === "content-type")) lines.push("Content-Type: application/x-www-form-urlencoded");
  const b = bodyText(r);
  if (r.body.type === "formData") {
    lines.push("Content-Type: multipart/form-data; boundary=----LocalpostBoundary", "");
    for (const f of r.body.fields) {
      lines.push("------LocalpostBoundary", `Content-Disposition: form-data; name="${f.key}"${f.kind === "file" ? `; filename="${f.value.split(/[\\/]/).pop()}"` : ""}`, "", f.kind === "file" ? `<${f.value}>` : f.value);
    }
    lines.push("------LocalpostBoundary--");
  } else if (b !== undefined) lines.push("", b);
  return lines.join("\n");
}

function fetchJs(r: PreparedRequest) {
  const out: string[] = [];
  out.push(`const myHeaders = new Headers();`);
  for (const h of r.headers) out.push(`myHeaders.append(${dq(h.key)}, ${dq(h.value)});`);
  let bodyVar = "";
  if (r.body.type === "text") { out.push("", `const raw = ${dq(r.body.content)};`); bodyVar = "raw"; }
  if (r.body.type === "urlEncoded") {
    out.push("", "const urlencoded = new URLSearchParams();");
    for (const f of r.body.fields) out.push(`urlencoded.append(${dq(f.key)}, ${dq(f.value)});`);
    bodyVar = "urlencoded";
  }
  if (r.body.type === "formData") {
    out.push("", "const formdata = new FormData();");
    for (const f of r.body.fields) out.push(f.kind === "file" ? `formdata.append(${dq(f.key)}, fileInput.files[0], ${dq(f.value)});` : `formdata.append(${dq(f.key)}, ${dq(f.value)});`);
    bodyVar = "formdata";
  }
  out.push("", "const requestOptions = {", `  method: ${dq(r.method)},`, "  headers: myHeaders,");
  if (bodyVar) out.push(`  body: ${bodyVar},`);
  out.push(`  redirect: "follow"`, "};", "", `fetch(${dq(r.url)}, requestOptions)`, "  .then((response) => response.text())", "  .then((result) => console.log(result))", "  .catch((error) => console.error(error));");
  return out.join("\n");
}

function axios(r: PreparedRequest) {
  const out = [`const axios = require("axios");`];
  let data = "";
  if (r.body.type === "text") { out.push(`let data = ${dq(r.body.content)};`); data = "data"; }
  if (r.body.type === "urlEncoded") {
    out.push(`const qs = require("qs");`, `let data = qs.stringify({`, ...r.body.fields.map((f) => `  ${dq(f.key)}: ${dq(f.value)},`), `});`);
    data = "data";
  }
  if (r.body.type === "formData") {
    out.push(`const FormData = require("form-data");`, `const fs = require("fs");`, `let data = new FormData();`,
      ...r.body.fields.map((f) => f.kind === "file" ? `data.append(${dq(f.key)}, fs.createReadStream(${dq(f.value)}));` : `data.append(${dq(f.key)}, ${dq(f.value)});`));
    data = "data";
  }
  out.push("", "let config = {", `  method: ${dq(r.method.toLowerCase())},`, "  maxBodyLength: Infinity,", `  url: ${dq(r.url)},`, "  headers: {",
    ...r.headers.map((h) => `    ${dq(h.key)}: ${dq(h.value)},`), "  },");
  if (data) out.push("  data: data,");
  out.push("};", "", "axios.request(config)", "  .then((response) => console.log(JSON.stringify(response.data)))", "  .catch((error) => console.log(error));");
  return out.join("\n");
}

function python(r: PreparedRequest) {
  const out = ["import requests", "", `url = ${dq(r.url)}`, ""];
  let extra = "";
  if (r.body.type === "text") { out.push(`payload = ${dq(r.body.content)}`); extra = ", data=payload"; }
  else if (r.body.type === "urlEncoded") { out.push(`payload = {`, ...r.body.fields.map((f) => `    ${dq(f.key)}: ${dq(f.value)},`), `}`); extra = ", data=payload"; }
  else if (r.body.type === "formData") {
    const text = r.body.fields.filter((f) => f.kind === "text");
    const files = r.body.fields.filter((f) => f.kind === "file");
    out.push(`payload = {`, ...text.map((f) => `    ${dq(f.key)}: ${dq(f.value)},`), `}`);
    out.push(`files = [`, ...files.map((f) => `    (${dq(f.key)}, open(${dq(f.value)}, "rb")),`), `]`);
    extra = ", data=payload, files=files";
  } else if (r.body.type === "binary") { out.push(`payload = open(${dq(r.body.path)}, "rb")`); extra = ", data=payload"; }
  out.push(`headers = {`, ...r.headers.map((h) => `    ${dq(h.key)}: ${dq(h.value)},`), `}`, "",
    `response = requests.request(${dq(r.method)}, url, headers=headers${extra})`, "", "print(response.text)");
  return out.join("\n");
}

function go(r: PreparedRequest) {
  const b = bodyText(r);
  const out = ["package main", "", "import (", `  "fmt"`, `  "io"`, `  "net/http"`, ...(b !== undefined ? [`  "strings"`] : []), ")", "", "func main() {",
    `  url := ${dq(r.url)}`, `  method := ${dq(r.method)}`, ""];
  if (b !== undefined) out.push(`  payload := strings.NewReader(${dq(b)})`, "", "  client := &http.Client{}", "  req, err := http.NewRequest(method, url, payload)");
  else out.push("  client := &http.Client{}", "  req, err := http.NewRequest(method, url, nil)");
  out.push("  if err != nil {", "    fmt.Println(err)", "    return", "  }");
  for (const h of r.headers) out.push(`  req.Header.Add(${dq(h.key)}, ${dq(h.value)})`);
  if (r.body.type === "urlEncoded" && !r.headers.some((h) => h.key.toLowerCase() === "content-type")) out.push(`  req.Header.Add("Content-Type", "application/x-www-form-urlencoded")`);
  out.push("", "  res, err := client.Do(req)", "  if err != nil {", "    fmt.Println(err)", "    return", "  }", "  defer res.Body.Close()", "",
    "  body, err := io.ReadAll(res.Body)", "  if err != nil {", "    fmt.Println(err)", "    return", "  }", "  fmt.Println(string(body))", "}");
  return out.join("\n");
}

function powershell(r: PreparedRequest) {
  const ps = (s: string) => `"${s.replace(/[`"$]/g, (c) => "`" + c)}"`;
  const out = [`$headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"`];
  for (const h of r.headers) out.push(`$headers.Add(${ps(h.key)}, ${ps(h.value)})`);
  const b = bodyText(r);
  if (b !== undefined) out.push("", `$body = ${ps(b)}`);
  out.push("", `$response = Invoke-RestMethod ${ps(r.url)} -Method '${r.method}' -Headers $headers${b !== undefined ? " -Body $body" : ""}`, "$response | ConvertTo-Json");
  return out.join("\n");
}

/** Content-Type implied by a url-encoded body when the user didn't set one. */
function implicitHeaders(r: PreparedRequest) {
  const hs = [...r.headers];
  if (r.body.type === "urlEncoded" && !hs.some((h) => h.key.toLowerCase() === "content-type")) {
    hs.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
  }
  return hs;
}

function httpie(r: PreparedRequest) {
  const parts = [`http`, r.body.type === "formData" ? "--form" : r.body.type === "urlEncoded" ? "--form" : "", r.method, sq(r.url)].filter(Boolean);
  for (const h of r.headers) parts.push(sq(`${h.key}:${h.value}`));
  if (r.body.type === "urlEncoded") for (const f of r.body.fields) parts.push(sq(`${f.key}=${f.value}`));
  if (r.body.type === "formData") for (const f of r.body.fields) parts.push(sq(f.kind === "file" ? `${f.key}@${f.value}` : `${f.key}=${f.value}`));
  const lines = [parts.join(" ")];
  if (r.body.type === "text") return `printf %s ${sq(r.body.content)} | ${lines[0]}`;
  if (r.body.type === "binary") return `${lines[0]} < ${sq(r.body.path)}`;
  return lines.join("");
}

function wget(r: PreparedRequest) {
  const lines = [`wget --no-check-certificate --quiet`, `  --method ${r.method}`, `  --timeout=0`];
  for (const h of implicitHeaders(r)) lines.push(`  --header ${sq(`${h.key}: ${h.value}`)}`);
  const b = bodyText(r);
  if (b !== undefined) lines.push(`  --body-data ${sq(b)}`);
  if (r.body.type === "binary") lines.push(`  --body-file ${sq(r.body.path)}`);
  lines.push(`  --output-document -`, `  ${sq(r.url)}`);
  return lines.join(" \\\n");
}

function java(r: PreparedRequest) {
  const b = bodyText(r);
  const publisher = b !== undefined ? `HttpRequest.BodyPublishers.ofString(${dq(b)})`
    : r.body.type === "binary" ? `HttpRequest.BodyPublishers.ofFile(java.nio.file.Path.of(${dq(r.body.path)}))`
    : "HttpRequest.BodyPublishers.noBody()";
  const out = [
    "import java.net.URI;", "import java.net.http.HttpClient;", "import java.net.http.HttpRequest;", "import java.net.http.HttpResponse;", "",
    "public class Main {", "  public static void main(String[] args) throws Exception {",
    "    HttpClient client = HttpClient.newHttpClient();",
    "    HttpRequest request = HttpRequest.newBuilder()", `      .uri(URI.create(${dq(r.url)}))`,
    ...implicitHeaders(r).map((h) => `      .header(${dq(h.key)}, ${dq(h.value)})`),
    `      .method(${dq(r.method)}, ${publisher})`, "      .build();",
    "    HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());",
    "    System.out.println(response.body());", "  }", "}",
  ];
  if (r.body.type === "formData") out.splice(0, 0, "// multipart/form-data isn't built into java.net.http; use a library such as Apache HttpClient.");
  return out.join("\n");
}

function csharp(r: PreparedRequest) {
  const out = ["var client = new HttpClient();", `var request = new HttpRequestMessage(new HttpMethod(${dq(r.method)}), ${dq(r.url)});`];
  const contentType = r.headers.find((h) => h.key.toLowerCase() === "content-type")?.value;
  for (const h of r.headers) if (h.key.toLowerCase() !== "content-type") out.push(`request.Headers.TryAddWithoutValidation(${dq(h.key)}, ${dq(h.value)});`);
  if (r.body.type === "text") out.push(`request.Content = new StringContent(${dq(r.body.content)}, null, ${dq(contentType ?? "text/plain")});`);
  if (r.body.type === "urlEncoded") {
    out.push("var collection = new List<KeyValuePair<string, string>>();", ...r.body.fields.map((f) => `collection.Add(new(${dq(f.key)}, ${dq(f.value)}));`), "request.Content = new FormUrlEncodedContent(collection);");
  }
  if (r.body.type === "formData") {
    out.push("var content = new MultipartFormDataContent();", ...r.body.fields.map((f) => f.kind === "file"
      ? `content.Add(new StreamContent(File.OpenRead(${dq(f.value)})), ${dq(f.key)}, ${dq(f.value.split(/[\\/]/).pop() ?? f.value)});`
      : `content.Add(new StringContent(${dq(f.value)}), ${dq(f.key)});`), "request.Content = content;");
  }
  if (r.body.type === "binary") out.push(`request.Content = new StreamContent(File.OpenRead(${dq(r.body.path)}));`);
  out.push("var response = await client.SendAsync(request);", "response.EnsureSuccessStatusCode();", "Console.WriteLine(await response.Content.ReadAsStringAsync());");
  return out.join("\n");
}

function php(r: PreparedRequest) {
  const ps = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const out = ["<?php", "", "$curl = curl_init();", "", "curl_setopt_array($curl, array(", `  CURLOPT_URL => ${ps(r.url)},`,
    "  CURLOPT_RETURNTRANSFER => true,", "  CURLOPT_FOLLOWLOCATION => true,", `  CURLOPT_CUSTOMREQUEST => ${ps(r.method)},`];
  const b = bodyText(r);
  if (b !== undefined) out.push(`  CURLOPT_POSTFIELDS => ${ps(b)},`);
  if (r.body.type === "formData") {
    out.push("  CURLOPT_POSTFIELDS => array(", ...r.body.fields.map((f) => `    ${ps(f.key)} => ${f.kind === "file" ? `new CURLFile(${ps(f.value)})` : ps(f.value)},`), "  ),");
  }
  const hs = implicitHeaders(r);
  if (hs.length) out.push("  CURLOPT_HTTPHEADER => array(", ...hs.map((h) => `    ${ps(`${h.key}: ${h.value}`)},`), "  ),");
  out.push("));", "", "$response = curl_exec($curl);", "curl_close($curl);", "echo $response;");
  return out.join("\n");
}

function ruby(r: PreparedRequest) {
  const cls = r.method.charAt(0) + r.method.slice(1).toLowerCase();
  const known = ["Get", "Post", "Put", "Patch", "Delete", "Head", "Options"].includes(cls);
  const out = [`require "uri"`, `require "net/http"`, "", `url = URI(${dq(r.url)})`, "", "http = Net::HTTP.new(url.host, url.port)",
    `http.use_ssl = url.scheme == "https"`, "",
    known ? `request = Net::HTTP::${cls}.new(url)` : `request = Net::HTTPGenericRequest.new(${dq(r.method)}, true, true, url)`];
  for (const h of implicitHeaders(r)) out.push(`request[${dq(h.key)}] = ${dq(h.value)}`);
  const b = bodyText(r);
  if (b !== undefined) out.push(`request.body = ${dq(b)}`);
  if (r.body.type === "formData") {
    out.push(`form_data = [${r.body.fields.map((f) => f.kind === "file" ? `[${dq(f.key)}, File.open(${dq(f.value)})]` : `[${dq(f.key)}, ${dq(f.value)}]`).join(", ")}]`,
      `request.set_form form_data, "multipart/form-data"`);
  }
  if (r.body.type === "binary") out.push(`request.body = File.binread(${dq(r.body.path)})`);
  out.push("", "response = http.request(request)", "puts response.read_body");
  return out.join("\n");
}

function rust(r: PreparedRequest) {
  const out = ["#[tokio::main]", "async fn main() -> Result<(), Box<dyn std::error::Error>> {", "    let client = reqwest::Client::builder().build()?;", "",
    `    let request = client.request(reqwest::Method::from_bytes(b${dq(r.method)})?, ${dq(r.url)})`];
  for (const h of implicitHeaders(r)) out.push(`        .header(${dq(h.key)}, ${dq(h.value)})`);
  const b = bodyText(r);
  if (b !== undefined) out.push(`        .body(${dq(b)})`);
  if (r.body.type === "formData") {
    out.splice(3, 0, "    let form = reqwest::multipart::Form::new()", ...r.body.fields.map((f) => f.kind === "file"
      ? `        .file(${dq(f.key)}, ${dq(f.value)}).await?`
      : `        .text(${dq(f.key)}, ${dq(f.value)})`), "        ;");
    out.push("        .multipart(form)");
  }
  if (r.body.type === "binary") out.push(`        .body(std::fs::read(${dq(r.body.path)})?)`);
  out[out.length - 1] += ";";
  out.push("", "    let response = request.send().await?;", "    println!(\"{}\", response.text().await?);", "    Ok(())", "}");
  return out.join("\n");
}

function swift(r: PreparedRequest) {
  const out = ["import Foundation", "", `var request = URLRequest(url: URL(string: ${dq(r.url)})!, timeoutInterval: Double.infinity)`, `request.httpMethod = ${dq(r.method)}`];
  for (const h of implicitHeaders(r)) out.push(`request.addValue(${dq(h.value)}, forHTTPHeaderField: ${dq(h.key)})`);
  const b = bodyText(r);
  if (b !== undefined) out.push(`request.httpBody = ${dq(b)}.data(using: .utf8)`);
  if (r.body.type === "binary") out.push(`request.httpBody = try? Data(contentsOf: URL(fileURLWithPath: ${dq(r.body.path)}))`);
  if (r.body.type === "formData") out.push("// Build a multipart/form-data body here (e.g. with a boundary string) and set request.httpBody.");
  out.push("", "let task = URLSession.shared.dataTask(with: request) { data, response, error in", "  guard let data = data else {",
    "    print(String(describing: error))", "    return", "  }", "  print(String(data: data, encoding: .utf8)!)", "}", "", "task.resume()");
  return out.join("\n");
}
