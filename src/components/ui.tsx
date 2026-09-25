import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

// ---------------------------------------------------------------- icons

const paths: Record<string, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  chevronRight: <path d="M6 3.5 10.5 8 6 12.5" />,
  chevronDown: <path d="M3.5 6 8 10.5 12.5 6" />,
  dots: <><circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" /></>,
  folder: <path d="M1.5 4.5a1 1 0 0 1 1-1h3.3l1.4 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />,
  folderOpen: <path d="M1.5 12.5V4.5a1 1 0 0 1 1-1h3.3l1.4 1.5h5.3a1 1 0 0 1 1 1V7M1.5 12.5l2-5h11l-2 5z" />,
  collection: <><rect x="2" y="5" width="12" height="9" rx="1" /><path d="M4 3h8M5.5 1.5h5" /></>,
  env: <><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M4.5 6.5h7M4.5 9.5h4" /></>,
  history: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
  gear: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
  cookie: <><path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5 2.2 2.2 0 0 1-2.7-2.7A2.2 2.2 0 0 1 9.5 2.6 2 2 0 0 1 8 1.5z" /><circle cx="5.5" cy="7" r=".7" fill="currentColor" /><circle cx="8" cy="10.5" r=".7" fill="currentColor" /><circle cx="10.8" cy="9.3" r=".7" fill="currentColor" /></>,
  import: <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11v2.5h11V11" />,
  export: <path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M2.5 11v2.5h11V11" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></>,
  trash: <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />,
  copy: <><rect x="5" y="5" width="9" height="9" rx="1" /><path d="M11 5V2.5a.5.5 0 0 0-.5-.5h-8a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5H5" /></>,
  play: <path d="M4.5 2.5v11l9-5.5z" />,
  code: <path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4" />,
  save: <><path d="M2.5 2.5h9l2 2v9h-11z" /><path d="M5 2.5v3.5h5V2.5M5 13.5V9h6v4.5" /></>,
  check: <path d="m3 8.5 3 3 7-7" />,
  terminal: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="m4 6 2 2-2 2M7.5 10.5h4" /></>,
  file: <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3" /></>,
  eye: <><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" /><circle cx="8" cy="8" r="2" /></>,
  eyeOff: <><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" /><path d="M2 2l12 12" /></>,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1" /></>,
  moon: <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></>,
  wrap: <path d="M2 4h12M2 8h10a2 2 0 0 1 0 4H8m0 0 1.5-1.5M8 12l1.5 1.5M2 12h3" />,
  docs: <><path d="M3 1.5h10v13H3z" /><path d="M5.5 5h5M5.5 8h5M5.5 11h3" /></>,
  layout: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M1.5 8h13" /></>,
  layoutH: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M8 2.5v11" /></>,
  bolt: <path d="M9 1.5 3 9h4.5L7 14.5 13 7H8.5z" />,
  gauge: <><path d="M2 11.5a6 6 0 1 1 12 0" /><path d="M8 11.5 11 6.5" /><circle cx="8" cy="11.5" r=".9" fill="currentColor" /></>,
  server: <><rect x="2" y="2.5" width="12" height="4.5" rx="1" /><rect x="2" y="9" width="12" height="4.5" rx="1" /><path d="M4.5 4.75h.01M4.5 11.25h.01" strokeWidth="2" /></>,
  inbox: <><path d="M1.5 9.5 3.5 3h9l2 6.5v4h-13z" /><path d="M1.5 9.5h4l1 1.5h3l1-1.5h4" /></>,
  example: <><path d="M2.5 2.5h11v11h-11z" /><path d="M5 6h6M5 8.5h6M5 11h3.5" /></>,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1" />,
  pin: <path d="M6 1.5h4M7 1.5v4L4.5 8.5h7L9 5.5v-4M8 8.5v6" />,
  compare: <><path d="M5.5 2v12M10.5 2v12" /><path d="M2 5h3.5M2 8h3.5M10.5 8H14M10.5 11H14" /></>,
  diff: <><path d="M4 2v7M1 5.5h6" /><path d="M9 10.5h6" /><path d="M1.5 14h13" /></>,
  table: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M1.5 6h13M1.5 9.5h13M6 6v7.5" /></>,
  filter: <path d="M1.5 2.5h13l-5 6v5l-3-1.5v-3.5z" />,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  tools: <path d="M10.2 2.2a3.3 3.3 0 0 0-3.9 4.4L2 10.9a1.4 1.4 0 0 0 2 2l4.4-4.3a3.3 3.3 0 0 0 4.4-3.9l-2 2-1.9-.5-.5-1.9z" />,
  key: <><circle cx="5" cy="11" r="2.8" /><path d="m7 9 6.5-6.5M11 5l1.8 1.8M9.5 6.5l1.3 1.3" /></>,
  hash: <path d="M6 2 4.5 14M11.5 2 10 14M2.5 5.5h11M2 10.5h11" />,
  id: <><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M4.5 6.5v3M7 6.5v3h1.2a1.5 1.5 0 0 0 0-3z" /><path d="M11 6.5h1.8M11 9.5h1.8" /></>,
  clock: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.5V8l2.5 1.5" /></>,
  convert: <path d="M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5" />,
  regex: <><path d="M10.5 2v6M8 3.5l5 3M8 6.5l5-3" /><rect x="2.5" y="10" width="3.5" height="3.5" rx=".5" /></>,
  calendar: <><rect x="1.5" y="3" width="13" height="11" rx="1.5" /><path d="M1.5 6.5h13M5 1.5v3M11 1.5v3M4.5 9.5h1M7.5 9.5h1M10.5 9.5h1M4.5 12h1M7.5 12h1" /></>,
};

export function Icon({ name, size = 14, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

export function IconButton({ icon, title, onClick, className, size, active, disabled }: {
  icon: string; title?: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; className?: string; size?: number; active?: boolean; disabled?: boolean;
}) {
  return (
    <button className={`icon-btn ${active ? "active" : ""} ${className ?? ""}`} title={title} onClick={onClick} disabled={disabled} type="button">
      <Icon name={icon} size={size} />
    </button>
  );
}

// ---------------------------------------------------------------- menus

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  divider?: boolean;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
}

const useMenu = create<{ menu: { x: number; y: number; items: MenuItem[] } | null }>(() => ({ menu: null }));

export function showMenu(x: number, y: number, items: MenuItem[]) {
  useMenu.setState({ menu: { x, y, items } });
}

/** Open a menu below the clicked element. */
export function menuFromEvent(e: React.MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  if (e.type === "contextmenu") showMenu(e.clientX, e.clientY, items);
  else {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, items);
  }
}

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 6),
      y: menu.y + r.height > window.innerHeight - 6 ? Math.max(6, menu.y - r.height) : menu.y,
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      useMenu.setState({ menu: null });
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}>
      {menu.items.map((it, i) =>
        it.divider ? <div key={i} className="menu-divider" /> : (
          <button
            key={i}
            className={`menu-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => { useMenu.setState({ menu: null }); it.onClick?.(); }}
          >
            <span className="menu-check">{it.checked ? <Icon name="check" size={12} /> : null}</span>
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- tabs

export function Tabs<T extends string>({ tabs, value, onChange, right, className }: {
  tabs: { id: T; label: ReactNode; badge?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`subtabs ${className ?? ""}`}>
      {tabs.map((t) => (
        <button key={t.id} className={`subtab ${value === t.id ? "active" : ""}`} onClick={() => onChange(t.id)} type="button">
          {t.label}
          {t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className="subtab-badge">{t.badge}</span>}
        </button>
      ))}
      <div className="flex-1" />
      {right}
    </div>
  );
}

// ---------------------------------------------------------------- splitter

/** Drag handle that reports the pointer delta relative to drag start. */
export function Splitter({ direction, onDrag, onStart, onEnd }: {
  direction: "horizontal" | "vertical";
  onDrag: (delta: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
}) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    onStart?.();
    const origin = direction === "horizontal" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => onDrag((direction === "horizontal" ? ev.clientX : ev.clientY) - origin);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging", "dragging-h", "dragging-v");
      onEnd?.();
    };
    document.body.classList.add("dragging", direction === "horizontal" ? "dragging-h" : "dragging-v");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className={`splitter splitter-${direction}`} onPointerDown={start} />;
}

// ---------------------------------------------------------------- modal

export function ModalFrame({ title, onClose, children, footer, width = 520, className }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; className?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${className ?? ""}`} style={{ width }}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <IconButton icon="close" onClick={onClose} title="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- small inputs

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label && <span>{label}</span>}
    </label>
  );
}

/** Inline editable text (double-click to edit). */
export function EditableText({ value, onChange, className, editing: controlled, onDone }: {
  value: string; onChange: (v: string) => void; className?: string; editing?: boolean; onDone?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const isEditing = controlled ?? editing;
  useEffect(() => { if (isEditing) setDraft(value); }, [isEditing, value]);
  const finish = (commit: boolean) => {
    if (commit && draft.trim() && draft !== value) onChange(draft.trim());
    setEditing(false);
    onDone?.();
  };
  if (!isEditing) {
    return <span className={className} onDoubleClick={() => setEditing(true)} title="Double-click to rename">{value}</span>;
  }
  return (
    <input
      className={`inline-edit ${className ?? ""}`}
      value={draft}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function Empty({ icon, title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={36} />}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
