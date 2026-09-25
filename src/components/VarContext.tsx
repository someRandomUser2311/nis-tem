import type { EditorView } from "@codemirror/view";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { VarLookup } from "../lib/cm";
import { useStore } from "../store";

const Ctx = createContext<{ current: VarLookup }>({ current: { get: () => undefined, names: () => [] } });
/** Changes whenever the resolvable variables change, so editors can repaint highlights. */
const VersionCtx = createContext<unknown>(null);
const CollectionCtx = createContext<string | undefined>(undefined);
/** The collection whose variables are in scope here (for resolving values on demand). */
export const useVarCollectionId = () => useContext(CollectionCtx);

/** Provides variable lookup (for highlighting / tooltips / completion) for a collection. */
export function VarProvider({ collectionId, children }: { collectionId?: string; children: React.ReactNode }) {
  const globals = useStore((s) => s.globals);
  const env = useStore((s) => s.environments.find((e) => e.id === s.activeEnvironmentId));
  const col = useStore((s) => s.collections.find((c) => c.id === collectionId));

  const lookup = useMemo<VarLookup>(() => {
    const layers = [
      { scope: `Environment · ${env?.name ?? ""}`, vars: env?.variables ?? [] },
      { scope: `Collection · ${col?.name ?? ""}`, vars: col?.variables ?? [] },
      { scope: "Global", vars: globals },
    ];
    return {
      get: (name) => {
        for (const l of layers) {
          const v = l.vars.find((x) => x.enabled && x.key === name);
          if (v) return { value: v.secret ? "••••••" : v.value, scope: l.scope };
        }
      },
      names: () => {
        const seen = new Set<string>();
        const out: { name: string; value: string; scope: string }[] = [];
        for (const l of layers) for (const v of l.vars) {
          if (!v.enabled || !v.key || seen.has(v.key)) continue;
          seen.add(v.key);
          out.push({ name: v.key, value: v.secret ? "••••••" : v.value, scope: l.scope.split(" ·")[0] });
        }
        return out;
      },
    };
  }, [globals, env, col]);

  // Stable ref object so CodeMirror extensions never need to be rebuilt.
  const ref = useRef(lookup);
  ref.current = lookup;
  return (
    <Ctx.Provider value={ref}>
      <VersionCtx.Provider value={lookup}>
        <CollectionCtx.Provider value={collectionId}>{children}</CollectionCtx.Provider>
      </VersionCtx.Provider>
    </Ctx.Provider>
  );
}

export const useVarLookup = () => useContext(Ctx);

/** Re-run {{variable}} decorations in a CodeMirror view when variables change. */
export function useVarRepaint(view: () => EditorView | undefined) {
  const version = useContext(VersionCtx);
  useEffect(() => { view()?.dispatch({}); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
}
