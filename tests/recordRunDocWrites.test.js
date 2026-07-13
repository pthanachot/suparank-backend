/**
 * W2-b review fix (1b): the doc-write marker must bind to the run's OWN
 * session. A concurrent setup on the same content REPLACES the session-map
 * entry with a newer session; an orphaned older run finishing later must
 * LOSE its record (safe — next setup re-pushes the document) rather than
 * clobber the live session's marker back to 0 and re-arm a document-push
 * skip while that session's engine copy is ahead of the last-pushed state.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-key';
const { contentSessionMap, rememberSession, recordRunDocWrites } =
  require('../src/controllers/aiController');

test.beforeEach(() => contentSessionMap.clear());

test('records docWrites when the sessionId matches the live entry', () => {
  rememberSession('content-1', 'session-A');
  recordRunDocWrites('content-1', 'session-A', 3);
  assert.strictEqual(contentSessionMap.get('content-1').lastRunDocWrites, 3);
});

test('an orphaned run (entry replaced by a newer session) cannot clobber the marker', () => {
  rememberSession('content-1', 'session-A');
  // Concurrent setup mints session-B → entry replaced; B's run writes the doc.
  rememberSession('content-1', 'session-B');
  recordRunDocWrites('content-1', 'session-B', 5);

  // Older run on the orphaned session-A finishes later with zero writes —
  // pre-fix this overwrote lastRunDocWrites to 0 and re-armed the skip.
  recordRunDocWrites('content-1', 'session-A', 0);
  assert.strictEqual(contentSessionMap.get('content-1').lastRunDocWrites, 5);
});

test('poison marker (-1) applies under the same guard', () => {
  rememberSession('content-1', 'session-A');
  recordRunDocWrites('content-1', 'session-A', -1);
  assert.strictEqual(contentSessionMap.get('content-1').lastRunDocWrites, -1);

  recordRunDocWrites('content-1', 'session-ghost', 0);
  assert.strictEqual(contentSessionMap.get('content-1').lastRunDocWrites, -1);
});

test('no entry at all is a silent no-op (TTL-swept mid-run)', () => {
  assert.doesNotThrow(() => recordRunDocWrites('gone', 'session-A', 2));
  assert.strictEqual(contentSessionMap.has('gone'), false);
});

test('rememberSession replaces the entry — pushHashes and marker reset with it', () => {
  rememberSession('content-1', 'session-A');
  const entry = contentSessionMap.get('content-1');
  entry.pushHashes = { document: 'h1' };
  entry.lastRunDocWrites = 0;

  rememberSession('content-1', 'session-B');
  const fresh = contentSessionMap.get('content-1');
  // Fresh session ⇒ no inherited hashes (never skips) and no stale marker.
  assert.strictEqual(fresh.pushHashes, undefined);
  assert.strictEqual(fresh.lastRunDocWrites, undefined);
  assert.strictEqual(fresh.sessionId, 'session-B');
});
