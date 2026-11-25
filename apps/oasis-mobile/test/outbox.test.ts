import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbOutbox, MemoryOutbox, type OutboxItem, type OutboxStore } from '../src/lib/outbox';
import { OutboxRunner, type Deliver } from '../src/lib/outbox-runner';

const item = (id: string, seq: number): OutboxItem => ({ id, text: `msg ${id}`, createdAt: seq, seq, accepted: false, cursor: null });
const tick = () => new Promise(r => setTimeout(r, 0));

describe('IndexedDbOutbox', () => {
  it('keeps messages in send order across reopening the database', async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbOutbox(factory, 'outbox-test');
    await first.add(item('b', 2));
    await first.add(item('a', 1));
    await first.add(item('c', 3));
    await first.update('b', { accepted: true, cursor: '9-0' });
    await first.remove('c');

    const reopened = new IndexedDbOutbox(factory, 'outbox-test');
    const items = await reopened.list();
    expect(items.map(i => i.id)).toEqual(['a', 'b']);
    expect(items[1]).toMatchObject({ accepted: true, cursor: '9-0', text: 'msg b' });
  });

  it('refuses a second message with the same id', async () => {
    const store = new IndexedDbOutbox(new IDBFactory(), 'dupes');
    await store.add(item('a', 1));
    await expect(store.add(item('a', 2))).rejects.toBeTruthy();
    const mem = new MemoryOutbox();
    await mem.add(item('a', 1));
    await expect(mem.add(item('a', 2))).rejects.toThrow('Duplicate');
  });
});

function runner(store: OutboxStore, deliver: Deliver, opts: { online?: () => boolean; ids?: string[] } = {}) {
  const ids = [...(opts.ids || ['m1', 'm2', 'm3', 'm4'])];
  return new OutboxRunner({
    store,
    deliver,
    canSend: opts.online || (() => true),
    retryDelayMs: () => 5,
    newId: () => ids.shift()!,
    cursorSaveMs: 0,
  });
}

describe('OutboxRunner', () => {
  it('sends queued messages in order, one at a time, and empties the outbox', async () => {
    const store = new MemoryOutbox();
    let online = false;
    const order: string[] = [];
    let concurrent = 0, maxConcurrent = 0;
    const deliver: Deliver = async (i, ctl) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(i.text);
      ctl.markAccepted();
      await tick();
      concurrent--;
      return 'sent';
    };
    const r = runner(store, deliver, { online: () => online });
    await r.enqueue('first');
    await r.enqueue('second');
    await r.enqueue('third');
    expect(order).toEqual([]); // offline: nothing goes out
    expect(r.items.map(i => i.text)).toEqual(['first', 'second', 'third']);

    online = true;
    await Promise.all([r.kick(), r.kick(), r.kick()]);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(maxConcurrent).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it('retries with the same id and resume cursor until delivered, never twice at once', async () => {
    const store = new MemoryOutbox();
    const calls: Array<[string, string | null]> = [];
    let attempts = 0;
    const deliver: Deliver = async (i, ctl) => {
      calls.push([i.id, i.cursor]);
      attempts++;
      if (attempts === 1) { ctl.markAccepted(); ctl.setCursor('7-0'); return 'retry'; }
      return 'sent';
    };
    const r = runner(store, deliver);
    await r.enqueue('hello');
    r.kick(); r.kick();
    await new Promise(res => setTimeout(res, 40));
    expect(calls).toEqual([['m1', null], ['m1', '7-0']]);
    expect(await store.list()).toEqual([]);
  });

  it('cancels a queued message so it is never sent', async () => {
    const store = new MemoryOutbox();
    let online = false;
    const deliver = vi.fn<Deliver>(async () => 'sent');
    const r = runner(store, deliver, { online: () => online });
    await r.enqueue('keep');
    const drop = await r.enqueue('drop');
    await expect(r.cancel(drop.id)).resolves.toBe(true);
    await expect(r.cancel('nope')).resolves.toBe(false);
    online = true;
    await r.kick();
    expect(deliver.mock.calls.map(c => c[0].text)).toEqual(['keep']);
  });

  it('withdraws a message mid-send only until the desktop accepted it', async () => {
    const store = new MemoryOutbox();
    let release!: () => void;
    let accept!: () => void;
    let seenSignal!: AbortSignal;
    const deliver: Deliver = (_i, ctl) => new Promise(res => {
      seenSignal = ctl.signal;
      accept = ctl.markAccepted;
      release = () => res('sent');
      ctl.signal.addEventListener('abort', () => res('dropped'));
    });
    const r = runner(store, deliver);
    const a = await r.enqueue('a');
    await tick();
    await expect(r.cancel(a.id)).resolves.toBe(true);
    expect(seenSignal.aborted).toBe(true);
    await tick();

    const b = await r.enqueue('b');
    await tick();
    accept();
    await tick();
    await expect(r.cancel(b.id)).resolves.toBe(false); // accepted: stop it instead
    release();
    await tick();
    expect(await store.list()).toEqual([]);
  });

  it('picks up where it left off after the app restarts', async () => {
    const factory = new IDBFactory();
    const before = runner(new IndexedDbOutbox(factory, 'restart'), async () => 'retry', { online: () => false });
    await before.enqueue('one');
    await before.enqueue('two');
    await new IndexedDbOutbox(factory, 'restart').update('m1', { accepted: true, cursor: '5-0' });
    before.dispose();

    const sent: Array<[string, string, string | null]> = [];
    const after = runner(new IndexedDbOutbox(factory, 'restart'), async (i) => { sent.push([i.id, i.text, i.cursor]); return 'sent'; }, { ids: ['m3'] });
    await after.ready();
    await after.kick();
    expect(sent).toEqual([['m1', 'one', '5-0'], ['m2', 'two', null]]);
    await after.enqueue('three'); // numbering continues after the restored ones
    await after.kick();
    expect(sent.map(s => s[1])).toEqual(['one', 'two', 'three']);
  });

  it('stops the reply in progress and moves on', async () => {
    const store = new MemoryOutbox();
    const seen: string[] = [];
    const deliver: Deliver = (i, ctl) => new Promise(res => {
      seen.push(i.text);
      ctl.markAccepted();
      if (i.text === 'second') return res('sent');
      ctl.signal.addEventListener('abort', () => res('dropped'));
    });
    const r = runner(store, deliver);
    await r.enqueue('first');
    await r.enqueue('second');
    await tick();
    await r.stopCurrent();
    await r.kick();
    expect(seen).toEqual(['first', 'second']);
    expect(await store.list()).toEqual([]);
  });
});
