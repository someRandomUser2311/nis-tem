// Docs checks: what's missing or wrong, with one click to the place to fix it.
import { useMemo, useState } from "react";
import type { Collection } from "../../types";
import type { DocsModel } from "../../lib/docs/model";
import { issueCounts, lintDocs, type DocsIssue, type Severity } from "../../lib/docs/lint";
import { openRequest, openSpecialTab } from "../../store";
import { Icon, IconButton } from "../ui";

const ICON: Record<Severity, string> = { error: "close", warning: "bolt", info: "docs" };
const LABEL: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Suggestions" };

export function useDocsIssues(c: Collection | undefined, model: DocsModel | null) {
  return useMemo(() => (c && model ? lintDocs(c, model) : []), [c, model]);
}

export function ChecksPanel({ collection, issues, onJump, onClose }: {
  collection: Collection; issues: DocsIssue[]; onJump: (id: string) => void; onClose: () => void;
}) {
  const [show, setShow] = useState<Severity | "all">("all");
  const counts = issueCounts(issues);
  const shown = issues.filter((i) => show === "all" || i.severity === show);
  const open = (i: DocsIssue) => {
    if (i.target.kind === "request") openRequest(collection.id, i.target.id);
    else if (i.target.kind === "folder") openSpecialTab("folder", { collectionId: collection.id, folderId: i.target.id });
    else onJump(i.target.id);
  };
  return (
    <div className="docs-checks">
      <div className="docs-settings-head">
        <span className="setting-title">Checks</span>
        <div className="seg">
          {(["all", "error", "warning", "info"] as const).map((s) => (
            <button key={s} className={`seg-btn ${show === s ? "active" : ""}`} onClick={() => setShow(s)}>
              {s === "all" ? `All ${issues.length}` : `${LABEL[s]} ${counts[s]}`}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <IconButton icon="close" size={12} title="Close" onClick={onClose} />
      </div>
      {issues.length === 0 ? <div className="docs-checks-ok"><Icon name="check" size={12} /> The docs look complete.</div> : (
        <ul className="docs-issues">
          {shown.map((i, n) => (
            <li key={n} className={`docs-issue ${i.severity}`}>
              <Icon name={ICON[i.severity]} size={11} />
              <span className="docs-issue-text"><b>{i.target.name}</b> — {i.message}</span>
              <span className="muted docs-issue-rule">{i.rule}</span>
              <div className="docs-issue-actions">
                {i.target.kind === "request" && <button className="link-btn" onClick={() => onJump(i.target.id)}>Show</button>}
                <button className="link-btn" onClick={() => open(i)}>{i.target.kind === "request" ? "Open request" : i.target.kind === "folder" ? "Open folder" : "Show"}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
