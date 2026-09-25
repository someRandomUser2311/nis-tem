// Events pushed from Rust (local servers, streams, WebSockets). In the browser preview the
// dev shim stands in for the backend and emits the same events on `window`.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function onEvent<T>(topic: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) {
    // Browser preview: the dev shim (lib/devShim.ts) emits events on window instead.
    const fn = (e: Event) => { const d = (e as CustomEvent).detail; if (d.topic === topic) handler(d.payload as T); };
    window.addEventListener("lp-dev-event", fn);
    return () => window.removeEventListener("lp-dev-event", fn);
  }
  return listen<T>(topic, (e) => handler(e.payload));
}
