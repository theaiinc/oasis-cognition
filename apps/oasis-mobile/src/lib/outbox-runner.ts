import type { OutboxItem, OutboxStore } from './outbox';

export type DeliveryResult =
  /** Answered (or refused for good): take it out of the outbox. */
  | 'sent'
  | 'dropped'
  /** Couldn't reach the desktop: keep it and try again later. */
  | 'retry';

export interface DeliveryControl {
  signal: AbortSignal;
  markAccepted(): void;
  setCursor(cursor: string): void;
}

export type Deliver = (item: OutboxItem, ctl: DeliveryControl) => Promise<DeliveryResult>;

export interface OutboxRunnerOptions {
  store: OutboxStore;
  deliver: Deliver;
  /** Paired and online. */
  canSend: () => boolean;
  onChange?: (items: OutboxItem[]) => void;
  retryDelayMs?: (attempt: number) => number;
  newId?: () => string;
  now?: () => number;
  /** How often to save the stream cursor while a reply streams in. */
  cursorSaveMs?: number;
}

/**
 * Sends outbox messages to the desktop one at a time, oldest first, and each
 * exactly once from the user's point of view: a message keeps its id through
 * every retry (the gateway ignores a repeat), and only one delivery runs at a
 * time. A later message waits for the earlier one's reply, because a new
 * message in the chat would otherwise cancel the turn still running.
 */
export class OutboxRunner {
  private readonly opts: Required<Omit<OutboxRunnerOptions, 'onChange'>> & Pick<OutboxRunnerOptions, 'onChange'>;
  private running: Promise<void> | null = null;
  private inFlight: { id: string; abort: AbortController; accepted: boolean } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private seq = 0;
  private snapshot: OutboxItem[] = [];
  private loaded: Promise<void>;
  private disposed = false;
  /** A kick that came while a pass was already running: run another pass after it. */
  private rerun = false;

  constructor(options: OutboxRunnerOptions) {
    this.opts = {
      retryDelayMs: (n) => Math.min(2000 * 2 ** n, 30_000),
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      cursorSaveMs: 2000,
      ...options,
    };
    this.loaded = this.refresh().then(() => {
      this.seq = this.snapshot.reduce((m, i) => Math.max(m, i.seq), 0);
    }).catch(() => undefined);
  }

  get items(): OutboxItem[] {
    return this.snapshot;
  }

  /** Resolves once the persisted outbox has been read. */
  ready(): Promise<void> {
    return this.loaded;
  }

  async enqueue(text: string, projectId?: string): Promise<OutboxItem> {
    await this.loaded;
    const item: OutboxItem = {
      id: this.opts.newId(), text, projectId, createdAt: this.opts.now(), seq: ++this.seq, accepted: false, cursor: null,
    };
    await this.opts.store.add(item);
    await this.refresh();
    this.kick();
    return item;
  }

  /**
   * Withdraw a message the desktop doesn't have yet. Returns false when it was
   * already accepted (stop the reply instead) or isn't in the outbox.
   */
  async cancel(id: string): Promise<boolean> {
    await this.loaded;
    const item = this.snapshot.find(i => i.id === id);
    if (!item || item.accepted) return false;
    if (this.inFlight?.id === id) {
      if (this.inFlight.accepted) return false;
      this.inFlight.abort.abort();
    }
    await this.opts.store.remove(id);
    await this.refresh();
    return true;
  }

  /** The user pressed Stop on the reply in progress: abort it and forget the message. */
  async stopCurrent(): Promise<void> {
    const current = this.inFlight;
    if (!current) return;
    current.abort.abort();
    await this.opts.store.remove(current.id);
    await this.refresh();
  }

  /** Try sending now (new message, back online, re-paired, app foregrounded). */
  kick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.drain();
      } while (this.rerun && !this.disposed);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.inFlight?.abort.abort();
  }

  private async drain(): Promise<void> {
    await this.loaded;
    while (!this.disposed && this.opts.canSend()) {
      const items = await this.opts.store.list();
      const head = items[0];
      if (!head) { this.retries = 0; return; }
      const abort = new AbortController();
      const flight = { id: head.id, abort, accepted: head.accepted };
      this.inFlight = flight;
      let cursor = head.cursor;
      let savedAt = 0;
      let result: DeliveryResult;
      try {
        result = await this.opts.deliver(head, {
          signal: abort.signal,
          markAccepted: () => {
            if (flight.accepted) return;
            flight.accepted = true;
            void this.opts.store.update(head.id, { accepted: true }).then(() => this.refresh());
          },
          setCursor: (c) => {
            cursor = c;
            const now = this.opts.now();
            if (now - savedAt >= this.opts.cursorSaveMs) {
              savedAt = now;
              void this.opts.store.update(head.id, { cursor: c });
            }
          },
        });
      } catch {
        result = 'retry';
      } finally {
        if (this.inFlight === flight) this.inFlight = null;
      }
      // Cancelled or stopped while in flight: it's already gone.
      if (abort.signal.aborted) { await this.refresh(); continue; }
      if (result === 'retry') {
        await this.opts.store.update(head.id, { cursor });
        await this.refresh();
        if (this.rerun) return; // something changed meanwhile (back online, re-paired): try again now
        this.scheduleRetry();
        return;
      }
      this.retries = 0;
      await this.opts.store.remove(head.id);
      await this.refresh();
    }
  }

  private scheduleRetry(): void {
    const delay = this.opts.retryDelayMs(this.retries++);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.kick(); }, delay);
  }

  private async refresh(): Promise<void> {
    this.snapshot = await this.opts.store.list();
    this.opts.onChange?.(this.snapshot);
  }
}
