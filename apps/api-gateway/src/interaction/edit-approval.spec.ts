import { EditApprovalGate, MemoryEditApprovalStore, MAX_PREVIEW_CHARS, editPreview, verdictOutput } from './edit-approval';
import { EditApprovalController } from './edit-approval.controller';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(pollMs = 1_000) {
  const store = new MemoryEditApprovalStore();
  const gate = new EditApprovalGate(store, undefined, pollMs);
  const events: Array<{ type: string; payload: any }> = [];
  const publish = (type: string, payload: Record<string, any>) => { events.push({ type, payload }); };
  return { store, gate, events, publish };
}

const change = { sessionId: 'chat-1', tool: 'edit_file' as const, path: 'src/a.ts', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b' };

describe('EditApprovalGate', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is off for a chat that never turned it on (edits run as before)', async () => {
    const { gate } = setup();
    expect(await gate.enabledFor('chat-1')).toBe(false);
  });

  it('is off, not an error, when the store fails', async () => {
    const { store, gate } = setup();
    store.isEnabled = () => Promise.reject(new Error('redis down'));
    expect(await gate.enabledFor('chat-1')).toBe(false);
  });

  it('holds the change until the user approves it, and announces it to the chat', async () => {
    const { store, gate, events, publish } = setup();
    await store.setEnabled('chat-1', true);
    expect(await gate.enabledFor('chat-1')).toBe(true);
    const pending = gate.request(change, { publish, timeoutMs: 60_000 });
    await flush();
    const asked = events.find((e) => e.type === 'EditApprovalRequested')!.payload;
    expect(asked).toMatchObject({ session_id: 'chat-1', tool: 'edit_file', path: 'src/a.ts', diff: change.diff });
    expect((await gate.pending('chat-1')).map((p) => p.approval_id)).toEqual([asked.approval_id]);
    expect(await gate.decide('chat-1', asked.approval_id, 'approved')).toBe(true);
    const v = await pending;
    expect(v.outcome).toBe('approved');
    expect(events.at(-1)).toMatchObject({ type: 'EditApprovalResolved', payload: { approval_id: asked.approval_id, outcome: 'approved' } });
    expect(await gate.pending('chat-1')).toEqual([]);
    expect(gate.waiting).toBe(0);
  });

  it('gives back a rejection with the reason the user wrote', async () => {
    const { gate, events, publish } = setup();
    const pending = gate.request(change, { publish });
    await flush();
    const id = events[0].payload.approval_id;
    await gate.decide('chat-1', id, 'rejected', '  keep the   old name ');
    const v = await pending;
    expect(v).toMatchObject({ outcome: 'rejected', reason: 'keep the old name' });
    expect(verdictOutput('edit_file', 'src/a.ts', v, 60_000)).toMatch(/^Rejected by the user: edit_file on src\/a\.ts was not applied.*Their reason: keep the old name/);
  });

  it('times out instead of waiting forever', async () => {
    const { gate, events, publish } = setup();
    const pending = gate.request(change, { publish, timeoutMs: 5_000 });
    await flush();
    jest.advanceTimersByTime(5_000);
    const v = await pending;
    expect(v.outcome).toBe('timeout');
    expect(events.at(-1)!.payload.outcome).toBe('timeout');
    expect(verdictOutput('edit_file', 'src/a.ts', v, 5 * 60_000)).toMatch(/did not approve or reject .* within 5 min/);
    // A late answer finds nothing to decide.
    expect(await gate.decide('chat-1', v.approval_id, 'approved')).toBe(false);
  });

  it('ends the wait when the turn is stopped', async () => {
    const { gate, publish } = setup();
    const ctl = new AbortController();
    const pending = gate.request(change, { publish, signal: ctl.signal });
    await flush();
    ctl.abort();
    expect((await pending).outcome).toBe('cancelled');
    expect(gate.waiting).toBe(0);
  });

  it('notices a stop that only isAborted reports, at its next poll', async () => {
    const { gate, publish } = setup(1_000);
    let stopped = false;
    const pending = gate.request(change, { publish, isAborted: () => stopped });
    await flush();
    stopped = true;
    jest.advanceTimersByTime(1_000);
    await flush();
    expect((await pending).outcome).toBe('cancelled');
  });

  it('does not wait at all for a turn already stopped', async () => {
    const { gate } = setup();
    const ctl = new AbortController();
    ctl.abort();
    expect((await gate.request(change, { signal: ctl.signal })).outcome).toBe('cancelled');
  });

  it('picks up a decision posted to another gateway process (shared store)', async () => {
    const { store, gate, events, publish } = setup(1_000);
    const other = new EditApprovalGate(store, undefined, 1_000);
    const pending = gate.request(change, { publish });
    await flush();
    const id = events[0].payload.approval_id;
    expect(await other.decide('chat-1', id, 'rejected', 'no')).toBe(true);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(await pending).toMatchObject({ outcome: 'rejected', reason: 'no' });
  });

  it("refuses a decision from another chat", async () => {
    const { gate, events, publish } = setup();
    const pending = gate.request(change, { publish, timeoutMs: 1_000 });
    await flush();
    expect(await gate.decide('chat-2', events[0].payload.approval_id, 'approved')).toBe(false);
    jest.advanceTimersByTime(1_000);
    expect((await pending).outcome).toBe('timeout');
  });
});

describe('editPreview', () => {
  it('shows an edit as its old lines removed and new lines added', () => {
    const { diff, truncated } = editPreview('edit_file', { path: 'src/a.ts', old_string: 'one\ntwo', new_string: 'one\n2' });
    expect(diff).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-one\n-two\n+one\n+2');
    expect(truncated).toBe(false);
  });

  it('shows each replacement of a multi-edit call, also when edits come as JSON text', () => {
    const edits = [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }];
    for (const e of [edits, JSON.stringify(edits)]) {
      expect(editPreview('edit_file', { path: 'x', edits: e }).diff.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,1 +1,1 @@', '@@ -1,1 +1,0 @@']);
    }
  });

  it('shows a written file as its new content', () => {
    expect(editPreview('write_file', { path: 'n.md', content: 'hi\nthere\n' }).diff).toBe('--- /dev/null\n+++ b/n.md\n@@ -1,0 +1,2 @@\n+hi\n+there');
  });

  it('cuts a huge change', () => {
    const r = editPreview('write_file', { path: 'big', content: 'x'.repeat(MAX_PREVIEW_CHARS * 2) });
    expect(r.truncated).toBe(true);
    expect(r.diff.length).toBeLessThan(MAX_PREVIEW_CHARS + 200);
  });
});

describe('EditApprovalController', () => {
  function controller() {
    const { gate, store, events, publish } = setup();
    return { c: new EditApprovalController(gate), gate, store, events, publish };
  }

  it('turns the setting on and off, off by default', async () => {
    const { c } = controller();
    expect(await c.get('chat-1')).toEqual({ session_id: 'chat-1', enabled: false, pending: [] });
    await c.set('chat-1', { enabled: true });
    expect((await c.get('chat-1')).enabled).toBe(true);
    await c.set('chat-1', { enabled: false });
    expect((await c.get('chat-1')).enabled).toBe(false);
    await expect(c.set('chat-1', { enabled: 'yes' })).rejects.toThrow('enabled must be true or false');
  });

  it('passes the decision to the waiting call; a stale one is not found', async () => {
    const { c, gate, events, publish } = controller();
    const pending = gate.request(change, { publish });
    await flush();
    const id = events[0].payload.approval_id;
    await expect(c.decide('chat-1', id, { decision: 'maybe' })).rejects.toThrow('decision must be');
    expect(await c.decide('chat-1', id, { decision: 'rejected', reason: 'later' })).toEqual({ session_id: 'chat-1', approval_id: id, decision: 'rejected' });
    expect(await pending).toMatchObject({ outcome: 'rejected', reason: 'later' });
    await expect(c.decide('chat-1', id, { decision: 'approved' })).rejects.toThrow('approval_not_found');
  });

  it('is not found for a malformed chat id', async () => {
    const { c } = controller();
    await expect(c.get('../etc')).rejects.toThrow('session_not_found');
  });
});
