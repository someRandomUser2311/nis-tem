import { open } from "@tauri-apps/plugin-dialog";
import type { GraphQLSchema } from "graphql";
import { graphql as graphqlLang } from "cm6-graphql";
import { useId, useMemo, useState } from "react";
import type { Body, BodyMode, RawLanguage } from "../types";
import { tryPrettyJson } from "../lib/utils";
import { CodeEditor } from "./CodeEditor";
import { KeyValueTable } from "./KeyValueTable";
import { Icon } from "./ui";
import { GraphqlDocs } from "./GraphqlDocs";
import { useSchemas } from "../lib/graphql";

/** GraphQL syntax, plus schema-aware completion and linting once a schema is loaded. */
const graphqlExt = (schema?: GraphQLSchema) => graphqlLang(schema);

const MODES: { id: BodyMode; label: string }[] = [
  { id: "none", label: "none" },
  { id: "formdata", label: "form-data" },
  { id: "urlencoded", label: "x-www-form-urlencoded" },
  { id: "raw", label: "raw" },
  { id: "binary", label: "binary" },
  { id: "graphql", label: "GraphQL" },
];

const LANGS: { id: RawLanguage; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "html", label: "HTML" },
  { id: "xml", label: "XML" },
];

export function BodyEditor({ body, onChange, requestId, onFetchSchema }: {
  body: Body;
  onChange: (b: Body) => void;
  /** For GraphQL: whose cached schema to use, and how to fetch it. */
  requestId?: string;
  onFetchSchema?: () => void;
}) {
  const schemaState = useSchemas((s) => (requestId ? s[requestId] : undefined));
  const schema = schemaState?.schema;
  const [docsOpen, setDocsOpen] = useState(false);
  const gqlExt = useMemo(() => graphqlExt(schema), [schema]);
  const group = useId();
  const beautify = () => {
    if (body.rawLanguage === "json") {
      const p = tryPrettyJson(body.raw);
      if (p) onChange({ ...body, raw: p });
    } else if (body.rawLanguage === "xml" || body.rawLanguage === "html") {
      onChange({ ...body, raw: formatXml(body.raw) });
    }
  };

  return (
    <div className="body-editor">
      <div className="body-modes">
        {MODES.map((m) => (
          <label key={m.id} className="radio">
            <input type="radio" name={group} checked={body.mode === m.id} onChange={() => onChange({ ...body, mode: m.id })} />
            {m.label}
          </label>
        ))}
        {body.mode === "raw" && (
          <>
            <select className="select select-sm lang-select" value={body.rawLanguage} onChange={(e) => onChange({ ...body, rawLanguage: e.target.value as RawLanguage })}>
              {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <div className="flex-1" />
            {(body.rawLanguage === "json" || body.rawLanguage === "xml" || body.rawLanguage === "html") && (
              <button className="link-btn" onClick={beautify}>Beautify</button>
            )}
          </>
        )}
      </div>

      <div className="body-content">
        {body.mode === "none" && <div className="muted center-note">This request does not have a body</div>}
        {body.mode === "raw" && (
          <CodeEditor value={body.raw} onChange={(raw) => onChange({ ...body, raw })} language={body.rawLanguage === "text" ? "text" : body.rawLanguage} variables />
        )}
        {body.mode === "urlencoded" && (
          <KeyValueTable rows={body.urlencoded} onChange={(urlencoded) => onChange({ ...body, urlencoded })} />
        )}
        {body.mode === "formdata" && (
          <KeyValueTable rows={body.formdata} onChange={(formdata) => onChange({ ...body, formdata })} variant="formdata" />
        )}
        {body.mode === "binary" && (
          <div className="binary-pick">
            <button
              className="btn"
              onClick={async () => {
                const p = await open({ multiple: false, directory: false });
                if (typeof p === "string") onChange({ ...body, binaryPath: p });
              }}
            >
              <Icon name="file" /> {body.binaryPath ? "Change file" : "Select file"}
            </button>
            {body.binaryPath && <span className="mono">{body.binaryPath}</span>}
          </div>
        )}
        {body.mode === "graphql" && (
          <div className="graphql">
            <div className="graphql-pane">
              <div className="pane-label gql-label">
                QUERY
                <div className="flex-1" />
                {schemaState?.error && <span className="gql-error ellipsis" title={schemaState.error}>{schemaState.error}</span>}
                {schema && <span className="gql-ok">Schema loaded</span>}
                {onFetchSchema && (
                  <button className="link-btn" disabled={schemaState?.loading} onClick={onFetchSchema} title="Send an introspection query to the URL above">
                    {schemaState?.loading ? "Fetching…" : schema ? "Refetch schema" : "Fetch schema"}
                  </button>
                )}
                {schema && <button className={`link-btn ${docsOpen ? "active" : ""}`} onClick={() => setDocsOpen(!docsOpen)}><Icon name="docs" size={11} /> Docs</button>}
              </div>
              <CodeEditor value={body.graphql.query} onChange={(query) => onChange({ ...body, graphql: { ...body.graphql, query } })} language="graphql" variables placeholder={schema ? "query { … }  (Ctrl-Space for suggestions)" : "query { ... }"} extra={gqlExt} />
            </div>
            <div className="graphql-pane">
              <div className="pane-label">GRAPHQL VARIABLES</div>
              <CodeEditor value={body.graphql.variables} onChange={(variables) => onChange({ ...body, graphql: { ...body.graphql, variables } })} language="json" variables placeholder="{ }" />
            </div>
            {docsOpen && schema && <GraphqlDocs schema={schema} onClose={() => setDocsOpen(false)} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function formatXml(xml: string): string {
  const tokens = xml.replace(/>\s+</g, "><").trim().split(/(<[^>]+>)/).filter((t) => t.trim());
  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isClose = tok.startsWith("</");
    const isOpen = tok.startsWith("<") && !isClose && !tok.endsWith("/>") && !tok.startsWith("<?") && !tok.startsWith("<!");
    // <tag>text</tag> stays on one line
    if (isOpen && tokens[i + 1] && !tokens[i + 1].startsWith("<") && tokens[i + 2]?.startsWith("</")) {
      lines.push("  ".repeat(depth) + tok + tokens[i + 1].trim() + tokens[i + 2]);
      i += 2;
      continue;
    }
    if (isClose) depth = Math.max(0, depth - 1);
    lines.push("  ".repeat(depth) + (tok.startsWith("<") ? tok : tok.trim()));
    if (isOpen) depth++;
  }
  return lines.join("\n");
}
