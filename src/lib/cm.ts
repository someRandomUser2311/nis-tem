// Shared CodeMirror extensions: theme, syntax colours, {{variable}} highlighting,
// hover tooltips and autocomplete.
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { DYNAMIC } from "./vars";

export interface VarInfo { value: string; scope: string }
export interface VarLookup {
  get: (name: string) => VarInfo | undefined;
  names: () => { name: string; value: string; scope: string }[];
}

export const baseTheme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "transparent", fontSize: "var(--code-font-size)" },
  ".cm-content": { fontFamily: "var(--mono)", caretColor: "var(--text)" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { backgroundColor: "var(--bg-2)", color: "var(--text-3)", border: "none", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-3)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-matchingBracket": { backgroundColor: "var(--selection-match)", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
  ".cm-panels": { backgroundColor: "var(--bg-2)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { color: "var(--text)" },
  ".cm-textfield": { backgroundColor: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "3px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: "3px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-3)", border: "none", color: "var(--text-2)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-popover)", border: "1px solid var(--border-strong)", color: "var(--text)", borderRadius: "4px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-bg)", color: "var(--text)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)" },
  ".cm-completionDetail": { color: "var(--text-3)", fontStyle: "normal", marginLeft: "12px" },
  ".cm-placeholder": { color: "var(--text-3)" },
  ".cm-var-ok": { color: "var(--var-ok)", backgroundColor: "var(--var-ok-bg)", borderRadius: "2px" },
  ".cm-var-missing": { color: "var(--var-missing)", backgroundColor: "var(--var-missing-bg)", borderRadius: "2px" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.tagName, t.typeName, t.className], color: "var(--syn-tag)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--syn-variable)" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--syn-punct)" },
  { tag: t.invalid, color: "var(--err)" },
]);

export const syntax = syntaxHighlighting(highlight);

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Highlights {{vars}} green if they resolve, red if they don't. */
export function variableHighlighting(lookup: { current: VarLookup }): Extension {
  const decorator = new MatchDecorator({
    regexp: VAR_RE,
    decoration: (m) => {
      const name = m[1];
      const ok = name.startsWith("$") ? !!DYNAMIC[name] : !!lookup.current.get(name);
      return Decoration.mark({ class: ok ? "cm-var-ok" : "cm-var-missing" });
    },
  });
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = decorator.createDeco(view); }
      update(u: ViewUpdate) {
        // Re-evaluate on every update so newly defined variables turn green.
        this.decorations = u.docChanged || u.viewportChanged ? decorator.updateDeco(u, this.decorations) : decorator.createDeco(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const tooltip = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    for (const m of line.text.matchAll(VAR_RE)) {
      const from = line.from + (m.index ?? 0);
      const to = from + m[0].length;
      if (pos < from || pos > to) continue;
      const name = m[1];
      return {
        pos: from, end: to, above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "var-tooltip";
          const info = name.startsWith("$") ? (DYNAMIC[name] ? { value: "Generated on send", scope: "Dynamic" } : undefined) : lookup.current.get(name);
          dom.innerHTML = "";
          const title = document.createElement("div");
          title.className = "var-tooltip-scope";
          title.textContent = info ? info.scope : "Unresolved variable";
          const val = document.createElement("div");
          val.className = "var-tooltip-value";
          val.textContent = info ? info.value || "(empty)" : `"${name}" is not defined in the active environment, collection or globals.`;
          dom.append(title, val);
          return { dom };
        },
      };
    }
    return null;
  }, { hoverTime: 250 });

  return [plugin, tooltip];
}

/**
 * `{{` triggers completion of variable names. Registered as language data (not an override) so
 * a language's own completions — e.g. GraphQL fields from a fetched schema — keep working too.
 */
export function variableCompletion(lookup: { current: VarLookup }): Extension {
  const source = (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\{\{[\w$.-]*/);
    if (!m) return null;
    const vars = lookup.current.names().map((v) => ({ label: v.name, detail: v.scope, info: v.value, apply: `${v.name}}}` }));
    const dyn = Object.keys(DYNAMIC).map((k) => ({ label: k, detail: "dynamic", apply: `${k}}}` }));
    return { from: m.from + 2, options: [...vars, ...dyn], validFor: /^[\w$.-]*$/ };
  };
  return [autocompletion({ activateOnTyping: true }), EditorState.languageData.of(() => [{ autocomplete: source }])];
}

/** Collapse any newline typed or pasted into a single-line field. */
export const singleLine: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
  const text = tr.newDoc.toString().replace(/\r?\n/g, "");
  return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: text }, sequential: true }];
});
