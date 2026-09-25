import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { baseTheme, syntax, variableCompletion, variableHighlighting } from "../lib/cm";
import { useVarLookup, useVarRepaint } from "./VarContext";

export type CodeLang = "json" | "javascript" | "xml" | "html" | "text" | "graphql";

interface Props {
  value: string;
  onChange?: (v: string) => void;
  language?: CodeLang;
  readOnly?: boolean;
  wrap?: boolean;
  /** Highlight {{variables}} (request bodies). */
  variables?: boolean;
  placeholder?: string;
  height?: string;
  /** Extra CodeMirror extensions (e.g. a GraphQL schema). */
  extra?: import("@codemirror/state").Extension;
}

/**
 * ⌘↵ / Ctrl↵ belongs to the app (send / connect / send message). Claim it before the default
 * keymap's "insert blank line" so the editor doesn't change; the event still reaches the window.
 */
const reserveModEnter = Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => true }]));

function langExt(l?: CodeLang) {
  switch (l) {
    case "json": return [json()];
    case "javascript": return [javascript()];
    case "xml": return [xml()];
    case "html": return [html()];
    default: return [];
  }
}

export const CodeEditor = forwardRef<ReactCodeMirrorRef, Props>(function CodeEditor(
  { value, onChange, language, readOnly, wrap, variables, placeholder, height = "100%", extra }, ref,
) {
  const lookup = useVarLookup();
  const cm = useRef<ReactCodeMirrorRef>(null);
  useImperativeHandle(ref, () => cm.current as ReactCodeMirrorRef, []);
  useVarRepaint(() => (variables ? cm.current?.view : undefined));
  const extensions = useMemo(() => [
    reserveModEnter,
    baseTheme,
    syntax,
    ...langExt(language),
    ...(wrap ? [EditorView.lineWrapping] : []),
    ...(variables ? [variableHighlighting(lookup), variableCompletion(lookup)] : []),
    ...(extra ? [extra] : []),
  ], [language, wrap, variables, lookup, extra]);

  return (
    <CodeMirror
      ref={cm}
      className="code-editor"
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      extensions={extensions}
      height={height}
      theme="none"
      placeholder={placeholder}
      basicSetup={{
        lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly,
        autocompletion: !variables, bracketMatching: true, closeBrackets: !readOnly, searchKeymap: true,
        syntaxHighlighting: false, tabSize: 2,
      }}
    />
  );
});
