import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyApprovalEvent, diffLines, diffStat, parsePending, timeLeft, type PendingEdit } from './edit-approval.ts';

const NOW = Date.parse('2026-11-25T10:00:00.000Z');
const edit = (id: string, expires = '2026-11-25T10:10:00.000Z'): PendingEdit => ({
  approval_id: id, tool: 'edit_file', path: 'src/a.ts', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-a\n+b\n+c',
  created_at: '2026-11-25T10:00:00.000Z', expires_at: expires,
});

describe('edits waiting for approval', () => {
  it('adds a requested change once and removes it when resolved', () => {
    let list: PendingEdit[] = [];
    list = applyApprovalEvent(list, { event_type: 'EditApprovalRequested', payload: edit('a1') }, NOW);
    list = applyApprovalEvent(list, { event_type: 'EditApprovalRequested', payload: edit('a1') }, NOW);
    list = applyApprovalEvent(list, { event_type: 'EditApprovalRequested', payload: edit('a2') }, NOW);
    assert.deepEqual(list.map((p) => p.approval_id), ['a1', 'a2']);
    list = applyApprovalEvent(list, { event_type: 'EditApprovalResolved', payload: { approval_id: 'a1', outcome: 'approved' } }, NOW);
    assert.deepEqual(list.map((p) => p.approval_id), ['a2']);
  });

  it('ignores other events, malformed and already expired changes', () => {
    const list = [edit('a1')];
    assert.equal(applyApprovalEvent(list, { event_type: 'ToolCallCompleted', payload: {} }, NOW), list);
    assert.equal(applyApprovalEvent(list, { event_type: 'EditApprovalRequested', payload: { approval_id: 'x' } }, NOW), list);
    const replayed = applyApprovalEvent(list, { event_type: 'EditApprovalRequested', payload: edit('old', '2026-11-25T09:00:00.000Z') }, NOW);
    assert.deepEqual(replayed.map((p) => p.approval_id), ['a1']);
    // An expired change drops out on the next event.
    assert.deepEqual(applyApprovalEvent([edit('gone', '2026-11-25T09:59:00.000Z'), edit('a1')], { event_type: 'EditApprovalResolved', payload: { approval_id: 'zz' } }, NOW).map((p) => p.approval_id), ['a1']);
  });

  it('reads the server list without expired entries', () => {
    assert.deepEqual(parsePending([edit('a1'), edit('old', '2026-11-25T09:00:00.000Z'), { bad: true }], NOW).map((p) => p.approval_id), ['a1']);
    assert.deepEqual(parsePending(undefined, NOW), []);
  });

  it('colours a diff and counts its lines', () => {
    assert.deepEqual(diffLines(edit('a').diff).map((l) => l.kind), ['file', 'file', 'hunk', 'del', 'add', 'add']);
    assert.deepEqual(diffStat(edit('a').diff), { added: 2, removed: 1 });
  });

  it('says how long a change still waits', () => {
    assert.equal(timeLeft('2026-11-25T10:09:30.000Z', NOW), '10 min left');
    assert.equal(timeLeft('2026-11-25T10:00:30.000Z', NOW), 'under a minute left');
    assert.equal(timeLeft('2026-11-25T09:00:00.000Z', NOW), 'expired');
  });
});
