import { useMemo } from "react";
import { diffJson } from "../../lib/tools";
import { Icon } from "../ui";
import { openDiff } from "../WorkspaceModals";
import { Editor, ErrorLine, Section, useToolField } from "./shared";

const show = (v: unknown) => (v === undefined ? "" : JSON.stringify(v));

export function JsonDiffTool() {
  const [left, setLeft] = useToolField("diff.left", "");
  const [right, setRight] = useToolField("diff.right", "");
  const result = useMemo(() => {
    if (!left.trim() || !right.trim()) return {};
    let a: unknown, b: unknown;
    try { a = JSON.parse(left); } catch (e: any) { return { error: `Left: ${e.message}` }; }
    try { b = JSON.parse(right); } catch (e: any) { return { error: `Right: ${e.message}` }; }
    return { changes: diffJson(a, b) };
  }, [left, right]);
  return (
    <>
      <div className="tool-grid-2">
        <Section title="Left (before)"><Editor value={left} onChange={setLeft} language="json" height={220} placeholder='{ "id": 1, "name": "Ada" }' /></Section>
        <Section title="Right (after)"><Editor value={right} onChange={setRight} language="json" height={220} placeholder='{ "id": 1, "name": "Grace" }' /></Section>
      </div>
      <ErrorLine error={result.error} />
      {result.changes && (
        <Section
          title={result.changes.length ? `${result.changes.length} difference${result.changes.length > 1 ? "s" : ""}` : "No differences — the documents are equal"}
          right={<button className="btn btn-sm" onClick={() => openDiff("JSON diff", { label: "Left", text: left }, { label: "Right", text: right })}><Icon name="diff" size={12} /> Side-by-side</button>}
        >
          {result.changes.length > 0 && (
            <table className="tool-table">
              <thead><tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
              <tbody>
                {result.changes.slice(0, 500).map((c, i) => (
                  <tr key={i}>
                    <td className="mono">{c.path}</td>
                    <td><span className={`tool-badge ${c.kind === "added" ? "ok" : c.kind === "removed" ? "bad" : "warn"}`}>{c.kind}</span></td>
                    <td className="mono ellipsis" title={show(c.before)}>{show(c.before)}</td>
                    <td className="mono ellipsis" title={show(c.after)}>{show(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
    </>
  );
}
