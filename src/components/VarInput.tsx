import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { useMemo, useRef } from "react";
import { baseTheme, singleLine, variableCompletion, variableHighlighting } from "../lib/cm";
import { useVarLookup, useVarRepaint } from "./VarContext";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onEnter?: () => void;
  /** Return true to swallow the paste (e.g. a pasted cURL command). */
  onPasteText?: (text: string) => boolean;
  className?: string;
  autoFocus?: boolean;
}

/** Single-line input with {{variable}} highlighting, hover tooltips and completion. */
export function VarInput({ value, onChange, placeholder, onEnter, onPasteText, className, autoFocus }: Props) {
  const lookup = useVarLookup();
  const cm = useRef<ReactCodeMirrorRef>(null);
  useVarRepaint(() => cm.current?.view);
  const handlers = useRef({ onEnter, onPasteText });
  handlers.current = { onEnter, onPasteText };

  const extensions = useMemo(() => [
    singleLine,
    baseTheme,
    EditorView.theme({ ".cm-content": { padding: "0" }, ".cm-line": { padding: "0" }, ".cm-scroller": { overflow: "hidden" } }),
    variableHighlighting(lookup),
    variableCompletion(lookup),
    cmPlaceholder(placeholder ?? ""),
    Prec.high(keymap.of([{
      key: "Enter",
      run: () => { handlers.current.onEnter?.(); return !!handlers.current.onEnter; },
    }])),
    EditorView.domEventHandlers({
      paste: (e) => {
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (handlers.current.onPasteText?.(text)) { e.preventDefault(); return true; }
        return false;
      },
    }),
  ], [lookup, placeholder]);

  return (
    <CodeMirror
      ref={cm}
      className={`var-input ${className ?? ""}`}
      value={value}
      onChange={onChange}
      extensions={extensions}
      basicSetup={false}
      autoFocus={autoFocus}
      theme="none"
    />
  );
}
