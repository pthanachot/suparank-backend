/**
 * QA Nov 2026 B03 follow-up: same-writer save ordering, against a REAL
 * (in-memory) MongoDB. One tab's overlapping saves (keepalive flush during an
 * in-flight autosave, an aborted PUT that still committed) must not 409
 * against the tab's own earlier write, while another writer is still always
 * a conflict and an older same-writer save can never overwrite a newer one.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Content = require('../src/models/Content');
const contentController = require('../src/controllers/contentController');
const imageStorage = require('../src/services/imageStorage');
const { parseWriter, RevisionInputError } = require('../src/services/contentRevision');

let restoreImg;
before(async () => {
  await connect();
  await Content.init();
  const orig = imageStorage.isEnabled;
  imageStorage.isEnabled = () => false;
  restoreImg = () => { imageStorage.isEnabled = orig; };
});
after(async () => { restoreImg(); await disconnect(); });
beforeEach(async () => { await clear(); });

const WS = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();
let n = 5000;
const TAB_A = 'tabAAAAAAAAA';
const TAB_B = 'tabBBBBBBBBB';

async function makeDoc() {
  const contentNumber = n++;
  await Content.create({ userId: USER, workspaceId: WS, contentNumber, title: 'orig', blocks: [{ id: 'b1', type: 'p', text: 'hello' }] });
  return contentNumber;
}
async function put(contentNumber, body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await contentController.updateContent({
    workspace: { _id: WS, organizationId: null }, params: { contentNumber: String(contentNumber) },
    body, user: { userId: String(USER) },
  }, res);
  return res;
}
const stored = (num) => Content.findOne({ contentNumber: num }).lean();

test('parseWriter: absent → null; valid → parsed; malformed → RevisionInputError', () => {
  assert.equal(parseWriter({}), null);
  assert.equal(parseWriter({ writer: null }), null);
  assert.deepEqual(parseWriter({ writer: { id: TAB_A, seq: 3 } }), { id: TAB_A, seq: 3 });
  for (const bad of [
    { id: 'short', seq: 1 }, { id: TAB_A, seq: 0 }, { id: TAB_A, seq: 1.5 }, { id: TAB_A, seq: '2' },
    { id: 'has space here', seq: 1 }, { id: 'x'.repeat(65), seq: 1 }, { id: { $ne: 1 }, seq: 1 }, 'str',
  ]) {
    assert.throws(() => parseWriter({ writer: bad }), RevisionInputError, JSON.stringify(bad));
  }
});

test('malformed writer is a 400, nothing written', async () => {
  const num = await makeDoc();
  const r = await put(num, { title: 'x', baseRevision: 0, writer: { id: 'bad', seq: 1 } });
  assert.equal(r.statusCode, 400);
  assert.equal((await stored(num)).title, 'orig');
});

test('keepalive overlap: same tab, same base, higher seq is accepted (no self-conflict)', async () => {
  const num = await makeDoc();
  const a = await put(num, { title: 'autosave', baseRevision: 0, writer: { id: TAB_A, seq: 1 } });
  assert.equal(a.statusCode, 200);
  // Keepalive went out on the same base before the autosave response arrived.
  const k = await put(num, { title: 'keepalive newer', baseRevision: 0, writer: { id: TAB_A, seq: 2 } });
  assert.equal(k.statusCode, 200);
  assert.equal(k.body.content.revision, 2);
  const s = await stored(num);
  assert.equal(s.title, 'keepalive newer');
  assert.deepEqual(s.lastWriter, { id: TAB_A, seq: 2 });
});

test('aborted PUT that still committed: the next save on the old base succeeds', async () => {
  const num = await makeDoc();
  await put(num, { title: 'aborted but landed', baseRevision: 0, writer: { id: TAB_A, seq: 4 } });
  const next = await put(num, { title: 'next', baseRevision: 0, writer: { id: TAB_A, seq: 5 } });
  assert.equal(next.statusCode, 200);
});

test('late OLDER same-tab save after a newer one: 409 (never overwrites newer), carrying lastWriter', async () => {
  const num = await makeDoc();
  await put(num, { title: 'newer (seq 7)', baseRevision: 0, writer: { id: TAB_A, seq: 7 } });
  const late = await put(num, { title: 'older (seq 6)', baseRevision: 0, writer: { id: TAB_A, seq: 6 } });
  assert.equal(late.statusCode, 409);
  assert.deepEqual(late.body.lastWriter, { id: TAB_A, seq: 7 });
  assert.equal((await stored(num)).title, 'newer (seq 7)');
});

test('equal seq replay is not accepted on a stale base', async () => {
  const num = await makeDoc();
  await put(num, { title: 'first', baseRevision: 0, writer: { id: TAB_A, seq: 3 } });
  const replay = await put(num, { title: 'replay', baseRevision: 0, writer: { id: TAB_A, seq: 3 } });
  assert.equal(replay.statusCode, 409);
});

test('another tab is always a real conflict, whatever its seq', async () => {
  const num = await makeDoc();
  await put(num, { title: 'tab A', baseRevision: 0, writer: { id: TAB_A, seq: 1 } });
  const b = await put(num, { title: 'tab B', baseRevision: 0, writer: { id: TAB_B, seq: 999 } });
  assert.equal(b.statusCode, 409);
  assert.equal(b.body.content.title, 'tab A');
  assert.deepEqual(b.body.lastWriter, { id: TAB_A, seq: 1 });
});

test('a write by someone else in between clears the marker: tab A is then a real conflict', async () => {
  const num = await makeDoc();
  await put(num, { title: 'A1', baseRevision: 0, writer: { id: TAB_A, seq: 1 } });
  const b = await put(num, { title: 'B', baseRevision: 1, writer: { id: TAB_B, seq: 1 } });
  assert.equal(b.statusCode, 200);
  const a2 = await put(num, { title: 'A2', baseRevision: 1, writer: { id: TAB_A, seq: 2 } });
  assert.equal(a2.statusCode, 409, 'B wrote in between: A must see the conflict');
  assert.equal((await stored(num)).title, 'B');
});

test('a legacy (writer-less) write clears the marker', async () => {
  const num = await makeDoc();
  await put(num, { title: 'A1', baseRevision: 0, writer: { id: TAB_A, seq: 1 } });
  await put(num, { title: 'old client' });
  const s = await stored(num);
  assert.equal(s.lastWriter, undefined);
  const a2 = await put(num, { title: 'A2', baseRevision: 1, writer: { id: TAB_A, seq: 2 } });
  assert.equal(a2.statusCode, 409);
});

test('concurrent same-tab saves on one base: both may land but the final state is the highest seq', async () => {
  const num = await makeDoc();
  const results = await Promise.all([1, 2, 3, 4, 5].map((s) =>
    put(num, { title: `seq${s}`, baseRevision: 0, writer: { id: TAB_A, seq: s } })));
  const ok = results.filter((r) => r.statusCode === 200).length;
  assert.ok(ok >= 1);
  const s = await stored(num);
  // Whatever interleaving happened, the stored state can only be the newest
  // seq that landed, and no landed write was older than its predecessor.
  assert.equal(s.lastWriter.id, TAB_A);
  assert.equal(s.title, `seq${s.lastWriter.seq}`);
  const landedSeqs = results.map((r, i) => (r.statusCode === 200 ? i + 1 : null)).filter(Boolean);
  assert.equal(s.lastWriter.seq, Math.max(...landedSeqs));
});

test('client shape never exposes lastWriter on 200', async () => {
  const num = await makeDoc();
  const r = await put(num, { title: 'x', baseRevision: 0, writer: { id: TAB_A, seq: 1 } });
  assert.equal(r.body.content.lastWriter, undefined);
});
