// Dev toolbox: the tool registry, the sidebar list and the tab that hosts a tool.
// Add a tool by writing a component here and adding an entry to TOOLS.
import { useMemo, useState, type ComponentType } from "react";
import type { Tab } from "../../types";
import { openSpecialTab } from "../../store";
import { rank } from "../../lib/search";
import { Empty, Icon } from "../ui";
import { ConvertTool } from "./ConvertTool";
import { CronTool } from "./CronTool";
import { EncodeTool } from "./EncodeTool";
import { HashTool } from "./HashTool";
import { IdTool } from "./IdTool";
import { JsonDiffTool } from "./JsonDiffTool";
import { JwtTool } from "./JwtTool";
import { RegexTool } from "./RegexTool";
import { TimeTool } from "./TimeTool";

export interface ToolDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  component: ComponentType;
}

export const TOOLS: ToolDef[] = [
  { id: "jwt", name: "JWT decoder", icon: "key", description: "Decode tokens, check expiry, verify HS/RS/PS/ES signatures, sign test tokens", component: JwtTool },
  { id: "encode", name: "Encode / decode", icon: "code", description: "Base64, Base64URL, URL, HTML entities, hex, Unicode escapes", component: EncodeTool },
  { id: "hash", name: "Hash & HMAC", icon: "hash", description: "MD5, SHA-1, SHA-256, SHA-384, SHA-512 as hex or Base64", component: HashTool },
  { id: "ids", name: "UUID & ULID", icon: "id", description: "Generate UUID v4/v7 and ULIDs; read the timestamp inside one", component: IdTool },
  { id: "time", name: "Timestamp converter", icon: "clock", description: "Unix seconds/ms ⇄ ISO 8601, HTTP date, local time", component: TimeTool },
  { id: "convert", name: "JSON ⇄ YAML ⇄ CSV", icon: "convert", description: "Convert data between formats", component: ConvertTool },
  { id: "jsondiff", name: "JSON diff", icon: "diff", description: "Structural differences between two JSON documents", component: JsonDiffTool },
  { id: "regex", name: "Regex tester", icon: "regex", description: "Live match highlighting, groups and replace", component: RegexTool },
  { id: "cron", name: "Cron explainer", icon: "calendar", description: "Describe a cron expression and list its next runs", component: CronTool },
];

export const toolById = (id?: string) => TOOLS.find((t) => t.id === id);
export const openTool = (id: string) => openSpecialTab("tool", { toolId: id });

export function ToolsPanel() {
  const [q, setQ] = useState("");
  const shown = useMemo(() => rank(q, TOOLS.map((t) => ({ ...t, title: t.name, subtitle: t.description }))), [q]);
  return (
    <>
      <div className="panel-header">
        <div className="search-box">
          <Icon name="search" size={12} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools" />
        </div>
      </div>
      <div className="tree tool-list">
        {shown.map((t) => (
          <button key={t.id} className="tool-list-row" onClick={() => openTool(t.id)} title={t.description}>
            <Icon name={t.icon} size={16} />
            <span className="tool-list-text"><span className="tool-list-name">{t.name}</span><span className="tool-list-desc">{t.description}</span></span>
          </button>
        ))}
        {!shown.length && <Empty icon="search" title="No tools match" />}
      </div>
      <p className="help pad">Everything runs on this machine — nothing you paste here is sent anywhere or saved to disk.</p>
    </>
  );
}

export function ToolView({ tab }: { tab: Tab }) {
  const tool = toolById(tab.toolId);
  if (!tool) return <Empty icon="tools" title="Unknown tool" />;
  const C = tool.component;
  return (
    <div className="container-editor">
      <div className="container-header">
        <Icon name={tool.icon} size={18} />
        <span className="container-title">{tool.name}</span>
        <span className="muted ellipsis">{tool.description}</span>
      </div>
      <div className="container-content">
        <div className="tool-body"><C /></div>
      </div>
    </div>
  );
}
