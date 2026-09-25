import { useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { Tabs } from "./ui";

const PRE_SNIPPETS: { label: string; code: string }[] = [
  { label: "Get an environment variable", code: `pm.environment.get("variable_key");` },
  { label: "Set an environment variable", code: `pm.environment.set("variable_key", "variable_value");` },
  { label: "Get a global variable", code: `pm.globals.get("variable_key");` },
  { label: "Set a global variable", code: `pm.globals.set("variable_key", "variable_value");` },
  { label: "Get a collection variable", code: `pm.collectionVariables.get("variable_key");` },
  { label: "Set a collection variable", code: `pm.collectionVariables.set("variable_key", "variable_value");` },
  { label: "Get a variable", code: `pm.variables.get("variable_key");` },
  { label: "Add a header", code: `pm.request.headers.add({ key: "X-Header", value: "value" });` },
  { label: "Set a timestamp variable", code: `pm.environment.set("timestamp", Date.now());` },
  { label: "Send a request", code: `pm.sendRequest("https://postman-echo.com/get", (err, res) => {\n  console.log(err ? err : res.json());\n});` },
  { label: "Log to console", code: `console.log("message");` },
];

const TEST_SNIPPETS: { label: string; code: string }[] = [
  { label: "Status code: Code is 200", code: `pm.test("Status code is 200", function () {\n  pm.response.to.have.status(200);\n});` },
  { label: "Response body: Contains string", code: `pm.test("Body matches string", function () {\n  pm.expect(pm.response.text()).to.include("string_you_want_to_search");\n});` },
  { label: "Response body: JSON value check", code: `pm.test("Your test name", function () {\n  var jsonData = pm.response.json();\n  pm.expect(jsonData.value).to.eql(100);\n});` },
  { label: "Response body: Is equal to a string", code: `pm.test("Body is correct", function () {\n  pm.response.to.have.body("response_body_string");\n});` },
  { label: "Response headers: Content-Type header check", code: `pm.test("Content-Type is present", function () {\n  pm.response.to.have.header("Content-Type");\n});` },
  { label: "Response time is less than 200ms", code: `pm.test("Response time is less than 200ms", function () {\n  pm.expect(pm.response.responseTime).to.be.below(200);\n});` },
  { label: "Status code: Successful POST request", code: `pm.test("Successful POST request", function () {\n  pm.expect(pm.response.code).to.be.oneOf([201, 202]);\n});` },
  { label: "Status code: Code name has string", code: `pm.test("Status code name has string", function () {\n  pm.response.to.have.status("Created");\n});` },
  { label: "Save response value to environment", code: `const json = pm.response.json();\npm.environment.set("token", json.token);` },
  { label: "Response body: Matches JSON schema", code: `const schema = {\n  type: "object",\n  required: ["id"],\n  properties: { id: { type: "integer" } },\n};\n\npm.test("Schema is valid", function () {\n  pm.response.to.have.jsonSchema(schema);\n});` },
  { label: "Set next request (runner)", code: `pm.execution.setNextRequest("request_name");` },
  { label: "Stop the collection run", code: `pm.execution.setNextRequest(null);` },
  { label: "Get an environment variable", code: `pm.environment.get("variable_key");` },
  { label: "Set an environment variable", code: `pm.environment.set("variable_key", "variable_value");` },
  { label: "Clear an environment variable", code: `pm.environment.unset("variable_key");` },
];

export function ScriptEditor({ pre, test, onChange }: {
  pre: string;
  test: string;
  onChange: (patch: { preRequestScript?: string; testScript?: string }) => void;
}) {
  const [which, setWhich] = useState<"pre" | "test">(pre && !test ? "pre" : test ? "test" : "pre");
  const value = which === "pre" ? pre : test;
  const snippets = which === "pre" ? PRE_SNIPPETS : TEST_SNIPPETS;
  const set = (v: string) => onChange(which === "pre" ? { preRequestScript: v } : { testScript: v });

  return (
    <div className="scripts">
      <div className="scripts-nav">
        <Tabs
          className="vertical-tabs"
          value={which}
          onChange={setWhich}
          tabs={[
            { id: "pre", label: <>Pre-request{pre.trim() && <span className="dot-indicator" />}</> },
            { id: "test", label: <>Post-response{test.trim() && <span className="dot-indicator" />}</> },
          ]}
        />
      </div>
      <div className="scripts-editor">
        <CodeEditor
          key={which}
          value={value}
          onChange={set}
          language="javascript"
          placeholder={which === "pre" ? "// Runs before the request is sent" : "// Runs after the response is received — write tests with pm.test()"}
        />
      </div>
      <div className="snippets">
        <div className="snippets-title">Snippets</div>
        {snippets.map((s) => (
          <button key={s.label} className="snippet" onClick={() => set((value.trim() ? value.replace(/\s*$/, "\n\n") : "") + s.code + "\n")}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
