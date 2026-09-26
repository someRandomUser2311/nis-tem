// Markdown for API docs, safe without a DOM (the CLI renders docs under Node): raw HTML is
// escaped rather than sanitised, and link/image URLs are restricted to safe schemes. Adds
// GitHub-style callouts (> [!NOTE]), links between requests (#req:<id>) and Mermaid blocks.
import { Marked, type Tokens } from "marked";

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SAFE_LINK = /^(https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;
const SAFE_IMAGE = /^(https?:|data:image\/(png|jpe?g|gif|webp|svg\+xml);|\.{0,2}\/|[^:]*$)/i;
const CALLOUTS: Record<string, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

export interface DocsMarkdownOptions {
  /** Map a request id (from `#req:<id>`) to the anchor it's rendered at. */
  resolveRequest?: (id: string) => string | undefined;
}

export function renderDocsMarkdown(src: string, opts: DocsMarkdownOptions = {}): string {
  if (!src.trim()) return "";
  const md = new Marked({ gfm: true, breaks: true, async: false });
  md.use({
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
      link(token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        const href = token.href.trim();
        const req = href.match(/^#req:([\w-]+)$/);
        if (req) {
          if (!opts.resolveRequest) return `<span class="req-link" data-request="${escapeHtml(req[1])}">${text}</span>`;
          const anchor = opts.resolveRequest(req[1]);
          return anchor
            ? `<a class="req-link" href="#${escapeHtml(anchor)}" data-request="${escapeHtml(req[1])}">${text}</a>`
            : `<span class="req-link broken" title="Linked request not found">${text}</span>`;
        }
        if (!SAFE_LINK.test(href)) return text;
        const external = /^(https?:|mailto:)/i.test(href);
        return `<a href="${escapeHtml(href)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
      },
      image(token: Tokens.Image) {
        if (!SAFE_IMAGE.test(token.href.trim())) return escapeHtml(token.text);
        return `<img src="${escapeHtml(token.href.trim())}" alt="${escapeHtml(token.text)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ""} loading="lazy">`;
      },
      code(token: Tokens.Code) {
        const lang = (token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
        if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
        return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(token.text)}</code></pre>\n`;
      },
      blockquote(token: Tokens.Blockquote) {
        const inner = this.parser.parse(token.tokens);
        const m = token.text.match(/^\s*\[!(\w+)\]/);
        const kind = m?.[1].toLowerCase();
        if (!kind || !CALLOUTS[kind]) return `<blockquote>\n${inner}</blockquote>\n`;
        const body = inner.replace(/\[!\w+\]\s*(<br>\s*)?/, "").replace(/<p>\s*<\/p>/, "");
        return `<div class="callout callout-${kind}"><div class="callout-title">${CALLOUTS[kind]}</div>\n${body}</div>\n`;
      },
    },
  });
  return md.parse(src) as string;
}

/** Plain text from Markdown, for search indexes and summaries. */
export function markdownText(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^>\s*\[!\w+\]/gm, "")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The `#req:<id>` targets used in a Markdown text. */
export const requestLinks = (src: string) => [...src.matchAll(/\]\(#req:([\w-]+)\)/g)].map((m) => m[1]);
