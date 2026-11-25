/**
 * The phone's outbox: messages the user sent that the desktop hasn't finished
 * answering yet. Kept in IndexedDB so a message typed while offline survives
 * the app being closed, and is sent (once) when the connection comes back.
 */

export interface OutboxItem {
  /** Also the client_message_id the gateway dedupes on, so a resend never starts a second turn. */
  id: string;
  text: string;
  projectId?: string;
  createdAt: number;
  /** Send order. */
  seq: number;
  /** The desktop has the message: it can no longer be withdrawn, only stopped. */
  accepted: boolean;
  /** Last stream cursor seen, so an interrupted reply resumes where it left off. */
  cursor: string | null;
}

export interface OutboxStore {
  add(item: OutboxItem): Promise<void>;
  /** All items, oldest first. */
  list(): Promise<OutboxItem[]>;
  update(id: string, patch: Partial<Omit<OutboxItem, 'id'>>): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'mobile-outbox';
const STORE = 'messages';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export class IndexedDbOutbox implements OutboxStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB, private readonly name = DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const r = this.factory.open(this.name, 1);
        r.onupgradeneeded = () => {
          const store = r.result.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('seq', 'seq');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      this.db.catch(() => { this.db = null; });
    }
    return this.db;
  }

  async add(item: OutboxItem): Promise<void> {
    const tx = (await this.open()).transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(item);
    await done(tx);
  }

  async list(): Promise<OutboxItem[]> {
    const tx = (await this.open()).transaction(STORE, 'readonly');
    return req(tx.objectStore(STORE).index('seq').getAll() as IDBRequest<OutboxItem[]>);
  }

  async update(id: string, patch: Partial<Omit<OutboxItem, 'id'>>): Promise<void> {
    const tx = (await this.open()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const current = await req(store.get(id) as IDBRequest<OutboxItem | undefined>);
    if (current) store.put({ ...current, ...patch, id });
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const tx = (await this.open()).transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await done(tx);
  }
}

/** Fallback when IndexedDB isn't available (private browsing on some browsers): lasts until reload. */
export class MemoryOutbox implements OutboxStore {
  private readonly items = new Map<string, OutboxItem>();
  async add(item: OutboxItem) {
    if (this.items.has(item.id)) throw new Error('Duplicate outbox id');
    this.items.set(item.id, { ...item });
  }
  async list() { return [...this.items.values()].sort((a, b) => a.seq - b.seq).map(i => ({ ...i })); }
  async update(id: string, patch: Partial<Omit<OutboxItem, 'id'>>) {
    const cur = this.items.get(id);
    if (cur) this.items.set(id, { ...cur, ...patch, id });
  }
  async remove(id: string) { this.items.delete(id); }
}

export function createOutboxStore(): OutboxStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbOutbox();
  } catch { /* fall through */ }
  return new MemoryOutbox();
}
