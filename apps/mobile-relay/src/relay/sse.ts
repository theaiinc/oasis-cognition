/** One Server-Sent Event as it came off the wire. */
export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Incremental SSE parser: feed it chunks as they arrive, get whole events back.
 * Handles events split across chunks, CRLF line ends, multi-line data and the
 * `id:` field (the gateway's Redis stream id, which is what a reconnect resumes from).
 */
export class SseParser {
  private buffer = '';
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      // A lone \r at the very end may be half of a \r\n still in flight.
      if (sepLen === 1 && this.buffer[nl] === '\r' && nl === this.buffer.length - 1) break;
      this.buffer = this.buffer.slice(nl + sepLen);
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === '') {
      if (this.data.length) out.push({ id: this.id, event: this.event, data: this.data.join('\n') });
      this.id = undefined;
      this.event = undefined;
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    else if (field === 'event') this.event = value;
  }
}
