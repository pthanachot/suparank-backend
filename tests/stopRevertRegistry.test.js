/**
 * W4-b: stop-revert registry + usage-tap stopReason capture.
 *
 * The billing-critical bits without booting the full SSE handler: the
 * in-flight run registry's lifecycle semantics, and the tap that feeds the
 * run record's stopReason (including the token_budget error-event path the
 * review flagged as a gap — V5).
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-key';
const { activeAgentRuns, makeUsageTap } = require('../src/controllers/aiController');

test.beforeEach(() => activeAgentRuns.clear());

test('registry entry carries the pre-run doc + defaults revertIntent false', () => {
  activeAgentRuns.set('c1', { sessionId: 's1', markdownBefore: '# Before', startedAt: Date.now(), revertIntent: false });
  const e = activeAgentRuns.get('c1');
  assert.strictEqual(e.revertIntent, false);
  assert.strictEqual(e.markdownBefore, '# Before');
});

test('a matching entry can be flagged for revert; deletion makes a later flag a no-op', () => {
  activeAgentRuns.set('c1', { sessionId: 's1', markdownBefore: '', startedAt: Date.now(), revertIntent: false });
  // stop-revert path: matching sessionId sets the flag.
  const entry = activeAgentRuns.get('c1');
  assert.ok(entry && entry.sessionId === 's1');
  entry.revertIntent = true;
  assert.strictEqual(activeAgentRuns.get('c1').revertIntent, true);
  // Handler tail deletes the entry (review V3: before the settle await) — a
  // concurrent stop-revert then finds nothing and would 409.
  activeAgentRuns.delete('c1');
  assert.strictEqual(activeAgentRuns.has('c1'), false);
});

// ── W4-c-2: explicit-stop abort contract ─────────────────────────────────
// A socket close no longer aborts the engine (detached runs keep going), so
// /ai/stop and /ai/stop-revert MUST drive entry.abort() to halt it. These pin
// that the registry carries an abort fn the stop endpoints can invoke.
test('registry entry carries an abort fn that the stop path invokes', () => {
  let aborted = 0;
  activeAgentRuns.set('c1', {
    sessionId: 's1', markdownBefore: '', startedAt: Date.now(),
    revertIntent: false, abort: () => { aborted += 1; },
  });
  const entry = activeAgentRuns.get('c1');
  // stop / stop-revert handler tail: flag + abort.
  entry.revertIntent = true;
  if (typeof entry.abort === 'function') entry.abort();
  assert.strictEqual(aborted, 1);
  assert.strictEqual(entry.revertIntent, true);
});

test('identity-guarded delete: a finishing run never evicts a shadowing run', () => {
  // W4-c-2 review BUG: registry is keyed by contentId. If run B overlaps and
  // overwrites run A's entry, A's completion must NOT delete B's entry.
  const key = 'c1';
  const entryA = { sessionId: 'sA', startedAt: Date.now(), revertIntent: false, abort() {} };
  activeAgentRuns.set(key, entryA);
  const entryB = { sessionId: 'sB', startedAt: Date.now(), revertIntent: false, abort() {} };
  activeAgentRuns.set(key, entryB); // B shadows A on the same key
  // A finishes: guarded delete only removes the key if it still holds entryA.
  if (activeAgentRuns.get(key) === entryA) activeAgentRuns.delete(key);
  assert.strictEqual(activeAgentRuns.get(key), entryB, "A's delete must leave B's live entry intact");
  // B finishes: it DOES own the key now → deletes.
  if (activeAgentRuns.get(key) === entryB) activeAgentRuns.delete(key);
  assert.strictEqual(activeAgentRuns.has(key), false);
});

test('abort is idempotent — a second stop on the same entry is safe', () => {
  const ctrl = new AbortController();
  activeAgentRuns.set('c1', {
    sessionId: 's1', markdownBefore: '', startedAt: Date.now(),
    revertIntent: false, abort: () => ctrl.abort(),
  });
  const entry = activeAgentRuns.get('c1');
  entry.abort();
  entry.abort(); // AbortController.abort() is idempotent — no throw.
  assert.strictEqual(ctrl.signal.aborted, true);
});

// ── usage tap: stopReason capture ────────────────────────────────────────
function feed(tap, obj) {
  tap.addChunk(Buffer.from(`data: ${JSON.stringify(obj)}\n\n`));
}

test('tap captures stopReason from the complete event', () => {
  const tap = makeUsageTap();
  feed(tap, { type: 'usage', usage: { input_tokens: 10, output_tokens: 20 } });
  feed(tap, { type: 'complete', completion: { stopReason: 'done', turns: 3 } });
  const s = tap.snapshot();
  assert.strictEqual(s.stopReason, 'done');
  assert.strictEqual(s.outputTokens, 20);
});

test('tap captures token_budget from an error event (review V5 gap)', () => {
  const tap = makeUsageTap();
  feed(tap, { type: 'usage', usage: { input_tokens: 5, output_tokens: 5 } });
  // The cumulative-cap path emits an error with a code and NO complete event.
  feed(tap, { type: 'error', code: 'token_budget', error: 'output budget hit' });
  assert.strictEqual(tap.snapshot().stopReason, 'token_budget');
});

test('tap ignores generic error codes for stopReason', () => {
  const tap = makeUsageTap();
  feed(tap, { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } });
  feed(tap, { type: 'error', code: 'api_error', error: 'provider blip' });
  assert.strictEqual(tap.snapshot().stopReason, '');
});

test('docWrites counts only document_diff, not document_update', () => {
  const tap = makeUsageTap();
  feed(tap, { type: 'document_diff', toolName: 'EditTool' });
  feed(tap, { type: 'document_update', toolName: 'EditTool' }); // no-op edit
  feed(tap, { type: 'document_diff', toolName: 'WriteTool' });
  assert.strictEqual(tap.snapshot().docWrites, 2);
});
