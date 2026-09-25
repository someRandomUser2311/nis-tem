import { useMemo } from "react";
import { regexSegments, runRegex } from "../../lib/tools";
import { CopyButton, Editor, ErrorLine, Section, useToolField } from "./shared";

const FLAGS = [
  { f: "i", label: "ignore case" }, { f: "m", label: "multiline" }, { f: "s", label: "dot matches newline" }, { f: "u", label: "unicode" },
];

export function RegexTool() {
  const [pattern, setPattern] = useToolField("re.pattern", "");
  const [flags, setFlags] = useToolField("re.flags", "");
  const [text, setText] = useToolField("re.text", "");
  const [replace, setReplace] = useToolField("re.replace", "");
  const result = useMemo(() => {
    if (!pattern) return {};
    try {
      const matches = runRegex(pattern, flags, text);
      const replaced = replace ? text.replace(new RegExp(pattern, flags + "g"), replace) : "";
      return { matches, replaced };
    } catch (e: any) { return { error: e.message as string }; }
  }, [pattern, flags, text, replace]);
  const segments = result.matches ? regexSegments(text, result.matches) : [{ text }];
  return (
    <>
      <Section title="Pattern">
        <div className="tool-controls">
          <div className="input-box mono tool-regex">
            <span className="muted">/</span>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="(?<year>\d{4})-(\d{2})" spellCheck={false} autoFocus />
            <span className="muted">/g{flags}</span>
          </div>
          {FLAGS.map(({ f, label }) => (
            <label key={f} className="tool-flag" title={label}>
              <input type="checkbox" checked={flags.includes(f)} onChange={(e) => setFlags(e.target.checked ? flags + f : flags.replace(f, ""))} /> {f}
            </label>
          ))}
        </div>
        <ErrorLine error={result.error} />
      </Section>
      <Section title="Test text">
        <Editor value={text} onChange={setText} height={120} placeholder="Text to match against" />
      </Section>
      <Section title={result.matches ? `${result.matches.length} match${result.matches.length === 1 ? "" : "es"}` : "Matches"}>
        <pre className="tool-highlight">
          {segments.map((s, i) => s.match === undefined ? <span key={i}>{s.text}</span> : <mark key={i} className={s.match % 2 ? "alt" : ""} title={`Match ${s.match + 1}`}>{s.text}</mark>)}
        </pre>
        {!!result.matches?.length && (
          <table className="tool-table">
            <thead><tr><th style={{ width: 44 }}>#</th><th>Match</th><th style={{ width: 70 }}>Index</th><th>Groups</th></tr></thead>
            <tbody>
              {result.matches.slice(0, 200).map((m, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="mono">{JSON.stringify(m.text)}</td>
                  <td className="mono">{m.index}</td>
                  <td className="mono">
                    {[...m.groups.map((g, j) => `$${j + 1}=${JSON.stringify(g ?? null)}`), ...Object.entries(m.named ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v ?? null)}`)].join("  ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title="Replace (optional)" right={result.replaced ? <CopyButton text={result.replaced} /> : null}>
        <input className="input mono" value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="Replacement — use $1, $<name>, $&" />
        {replace && result.matches && <Editor value={result.replaced ?? ""} height={100} />}
      </Section>
    </>
  );
}
