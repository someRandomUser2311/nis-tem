import { useEffect, useRef, useState } from "react";
import type { ConsoleEntry } from "../types";
import { clearConsole, toggleConsole, useStore } from "../store";
import { Icon, IconButton, Splitter } from "./ui";

function Entry({ e }: { e: ConsoleEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = e.detail !== undefined;
  return (
    <div className={`console-entry lvl-${e.level}`}>
      <div className="console-line" onClick={() => hasDetail && setOpen(!open)}>
        <span className="console-caret">{hasDetail ? <Icon name={open ? "chevronDown" : "chevronRight"} size={10} /> : null}</span>
        <span className="console-msg">{e.message}</span>
        <span className="console-time">{new Date(e.time).toLocaleTimeString()}</span>
      </div>
      {open && hasDetail && <pre className="console-detail">{JSON.stringify(e.detail, null, 2)}</pre>}
    </div>
  );
}

export function ConsolePanel() {
  const entries = useStore((s) => s.console);
  const [height, setHeight] = useState(() => Number(localStorage.getItem("lp.consoleH") ?? 220));
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<"all" | ConsoleEntry["level"]>("all");
  const start = useRef(height);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = entries.filter((e) => (level === "all" || e.level === level) && (!filter || e.message.toLowerCase().includes(filter.toLowerCase())));

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className="console" style={{ height }}>
      <Splitter direction="vertical" onDrag={(d) => setHeight(Math.max(100, Math.min(window.innerHeight - 200, start.current - d)))}
        onEnd={() => { start.current = height; localStorage.setItem("lp.consoleH", String(height)); }} />
      <div className="console-toolbar">
        <span className="console-title">Console</span>
        <div className="search-box inline">
          <Icon name="search" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search messages" />
        </div>
        <select className="select select-sm" value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
          <option value="all">All logs</option>
          <option value="request">Network</option>
          <option value="log">Log</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
        </select>
        <div className="flex-1" />
        <button className="btn btn-sm" onClick={clearConsole}>Clear</button>
        <IconButton icon="close" title="Close console" onClick={() => toggleConsole(false)} />
      </div>
      <div className="console-list" ref={listRef}>
        {shown.length === 0 ? <div className="muted pad">No logs yet. Requests and console.log() output from scripts appear here.</div> : shown.map((e) => <Entry key={e.id} e={e} />)}
      </div>
    </div>
  );
}
