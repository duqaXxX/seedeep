import { HEARTBEAT_EVENT } from '../core/wire.ts';
import { sseFrame } from './sse.ts';

// A minimal structural view of ReadableStreamDefaultController — enqueue, plus the close
// that ends the HTTP response. `close` is optional so a test double may omit it.
export interface SseSink {
  enqueue(chunk: Uint8Array): void;
  close?(): void;
}

// Bytes on an otherwise idle wire, so a connection that has already died fails on the next
// write instead of staying silently half-open forever.
//
// A named event rather than an SSE comment, because the comment only ever solved the SERVER's
// half. The browser cannot hear a comment — the EventSource API surfaces no hook for one — so a
// page on a silently cut path had nothing to measure and sat at readyState OPEN for as long as
// it was left there (measured: 90s, six of these missed, zero `error` events). This is the only
// thing that arrives on a quiet stream, so it is what the client's watchdog counts on (see
// `staleMs` in client/stream.ts).
//
// It carries no `id:` line on purpose: an SSE id is a POSITION in the stream that a client may
// resume from, and a heartbeat is not one — which is also why it is built here rather than by
// `sseFrame`, whose contract is to number what it writes.
const HEARTBEAT = `event: ${HEARTBEAT_EVENT}\ndata: {}\n\n`;

export class ClientRegistry {
  private readonly sinks = new Set<SseSink>();
  private readonly encoder = new TextEncoder();
  private nextId = 1;

  add(sink: SseSink): void {
    this.sinks.add(sink);
  }

  remove(sink: SseSink): void {
    this.sinks.delete(sink);
  }

  /** Frame `data` as an `event` and write it to every client, evicting the ones that fail. */
  broadcast(event: string, data: unknown): void {
    this.write(this.encoder.encode(sseFrame(this.nextId++, event, data)));
  }

  /**
   * Write a `heartbeat` event to every client. Consumes no id, so it never shifts the numbering
   * of the real events. Both ends need it: it makes a dead sink fail on this side, and it is the
   * only proof of life the page gets while a session is quiet.
   */
  ping(): void {
    this.write(this.encoder.encode(HEARTBEAT));
  }

  size(): number {
    return this.sinks.size;
  }

  private write(bytes: Uint8Array): void {
    for (const sink of this.sinks) {
      try {
        sink.enqueue(bytes);
      } catch {
        this.drop(sink); // client gone — evict, keep broadcasting
      }
    }
  }

  // Evicting alone left the browser holding a connection nobody writes to any more: its
  // EventSource stays OPEN, fires no error, and never reconnects — the page freezes with a
  // healthy-looking stream until it is reloaded by hand. Closing the controller
  // ends the response, which is the only thing the browser can actually notice.
  private drop(sink: SseSink): void {
    this.sinks.delete(sink);
    try {
      sink.close?.();
    } catch {
      /* already closed or errored — it is gone either way */
    }
  }
}
