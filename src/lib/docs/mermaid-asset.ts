// mermaid.min.js as text, for published docs sites (desktop app only; the CLI reads the file
// from node_modules). Loaded on demand: it's ~3.5 MB.
let cached: Promise<string | undefined> | undefined;

export function loadMermaidJs(): Promise<string | undefined> {
  cached ??= import("mermaid/dist/mermaid.min.js?raw").then((m) => m.default as string, () => undefined);
  return cached;
}

/** Whether any docs text contains a Mermaid block (so the 3.5 MB script is only added when needed). */
export const needsMermaid = (texts: string[]) => texts.some((t) => /```\s*mermaid/i.test(t));
