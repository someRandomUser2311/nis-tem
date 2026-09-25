// Incremental parser for text/event-stream (https://html.spec.whatwg.org/multipage/server-sent-events.html).

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private retry: number | undefined;
  private first = true;

  /** Feed a chunk of text; returns the events it completed. */
  feed(chunk: string): SseEvent[] {
    if (this.first) {
      this.first = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    this.buf += chunk;
    const out: SseEvent[] = [];
    // Lines end with \r\n, \n or \r. Keep a trailing \r until we know whether \n follows.
    const re = /\r\n|\n|\r(?!$)/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const ev = this.line(this.buf.slice(start, m.index));
      if (ev) out.push(ev);
      start = m.index + m[0].length;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Flush at end of stream (a final event without a blank line is dropped, per spec). */
  end(): SseEvent[] {
    this.buf = "";
    this.data = [];
    this.event = "";
    return [];
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (!this.data.length) { this.event = ""; return null; }
      const ev: SseEvent = { event: this.event || "message", data: this.data.join("\n"), id: this.id, retry: this.retry };
      this.data = [];
      this.event = "";
      this.retry = undefined;
      return ev;
    }
    if (line.startsWith(":")) return null; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data": this.data.push(value); break;
      case "event": this.event = value; break;
      case "id": if (!value.includes("\0")) this.id = value; break;
      case "retry": if (/^\d+$/.test(value)) this.retry = Number(value); break;
    }
    return null;
  }
}
