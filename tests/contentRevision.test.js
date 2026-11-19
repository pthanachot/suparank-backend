/**
 * QA Nov 2026 (B03 backend half, N1 wiring) — optimistic concurrency on
 * PUT /content/:n, the revision on GET, and the save-path sanitizer.
 * Content model stubbed; no DB.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBaseRevision, revisionFilter, revisionUpdate, conflictBody, RevisionInputError,
} = require('../src/services/contentRevision');
const contentController = require('../src/controllers/contentController');
const Content = require('../src/models/Content');
const imageStorage = require('../src/services/imageStorage');

test('parseBaseRevision', () => {
  assert.equal(parseBaseRevision({}), null);
  assert.equal(parseBaseRevision({ baseRevision: null }), null);
  assert.equal(parseBaseRevision({ baseRevision: 0 }), 0);
  assert.equal(parseBaseRevision({ baseRevision: 7 }), 7);
  assert.equal(parseBaseRevision({ baseRevision: '7' }), 7);
  for (const bad of [-1, 1.5, 'abc', '', true, {}, []]) {
    assert.throws(() => parseBaseRevision({ baseRevision: bad }), RevisionInputError, JSON.stringify(bad));
  }
});

test('revisionFilter: absent → unconditional; 0 also matches legacy rows without the field', () => {
  assert.deepEqual(revisionFilter(null), {});
  assert.deepEqual(revisionFilter(3), { revision: 3 });
  assert.deepEqual(revisionFilter(0), { $or: [{ revision: 0 }, { revision: { $exists: false } }] });
});

test('revisionUpdate always bumps', () => {
  // No writer: the same-writer marker is cleared so the next tab can't claim it.
  assert.deepEqual(revisionUpdate({ title: 't' }), { $set: { title: 't' }, $unset: { lastWriter: 1 }, $inc: { revision: 1 } });
  assert.deepEqual(revisionUpdate({ title: 't' }, { id: 'tabAAAAAAAAA', seq: 3 }),
    { $set: { title: 't', lastWriter: { id: 'tabAAAAAAAAA', seq: 3 } }, $inc: { revision: 1 } });
});

test('conflictBody shape', () => {
  const b = conflictBody({ revision: 5, title: 'server' });
  assert.equal(b.error, 'revision_conflict');
  assert.equal(b.revision, 5);
  assert.deepEqual(b.content, { revision: 5, title: 'server' });
  assert.doesNotMatch(b.message, /—/);
});

// ─── controller wiring ───────────────────────────────────────

function doc(fields) {
  return { ...fields, toObject() { const { toObject, ...rest } = this; return { ...rest }; } };
}

async function put(body, { serverRevision = 4, exists = true } = {}) {
  const saved = [[Content, 'findOneAndUpdate', Content.findOneAndUpdate], [Content, 'findOne', Content.findOne], [imageStorage, 'isEnabled', imageStorage.isEnabled]];
  const calls = [];
  imageStorage.isEnabled = () => false;
  Content.findOneAndUpdate = async (filter, update) => {
    calls.push({ filter, update });
    const rev = filter.revision !== undefined ? filter.revision : (filter.$or ? 0 : undefined);
    if (!exists) return null;
    if (rev !== undefined && rev !== serverRevision) return null;
    return doc({
      _id: 'c1', contentNumber: 9, title: 'saved', blocks: update.$set.blocks || [],
      revision: serverRevision + 1, favoritedBy: ['x'], analysisStatus: 'idle',
    });
  };
  Content.findOne = async () => (exists ? doc({
    _id: 'c1', contentNumber: 9, title: 'server copy', revision: serverRevision, favoritedBy: ['secret'],
    articleQuotaCtx: { userId: 'u' }, analysisStatus: 'failed', analysisError: 'Engine returned 500: raw',
    blocks: [{ id: 'b', type: 'p', text: 'theirs' }],
  }) : null);
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await contentController.updateContent({
      workspace: { _id: 'w1' }, params: { contentNumber: '9' }, body, user: { userId: 'u1' },
    }, res);
  } finally {
    for (const [o, k, v] of saved) o[k] = v;
  }
  return { res, calls };
}

test('PUT with the current baseRevision saves, bumps, and returns the new revision', async () => {
  const { res, calls } = await put({ title: 'mine', baseRevision: 4 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.content.revision, 5);
  assert.equal(calls[0].filter.revision, 4);
  assert.deepEqual(calls[0].update.$inc, { revision: 1 });
  assert.equal(res.body.content.favoritedBy, undefined);
});

test('PUT with a stale baseRevision → 409 revision_conflict with the server copy in GET shape', async () => {
  const { res } = await put({ title: 'mine', baseRevision: 3 });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'revision_conflict');
  assert.equal(res.body.revision, 4);
  assert.equal(res.body.content.title, 'server copy');
  assert.equal(res.body.content.revision, 4);
  assert.equal(res.body.content.favoritedBy, undefined, 'same strip as GET');
  assert.equal(res.body.content.articleQuotaCtx, undefined);
  assert.doesNotMatch(JSON.stringify(res.body), /Engine returned/, 'presented analysis error, not raw');
});

test('PUT without baseRevision is accepted (backward compatible) and still bumps', async () => {
  const { res, calls } = await put({ title: 'legacy client' });
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].filter.revision, undefined);
  assert.equal(calls[0].filter.$or, undefined);
  assert.deepEqual(calls[0].update.$inc, { revision: 1 });
});

test('PUT on a missing document is still 404, with or without baseRevision', async () => {
  assert.equal((await put({ title: 'x', baseRevision: 1 }, { exists: false })).res.statusCode, 404);
  assert.equal((await put({ title: 'x' }, { exists: false })).res.statusCode, 404);
});

test('PUT with an invalid baseRevision → 400', async () => {
  const { res, calls } = await put({ title: 'x', baseRevision: -2 });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('PUT sanitizes block HTML before it is stored (N1)', async () => {
  const { calls } = await put({
    baseRevision: 4,
    blocks: [{ id: 'b1', type: 'p', text: 'hi <img src=x onerror=alert(1)><b onclick=1>x</b>' }],
    versions: [{ id: 'v1', timestamp: 1, blocks: [{ id: 'b1', type: 'p', text: '<script>1</script>ok' }] }],
  });
  assert.equal(calls[0].update.$set.blocks[0].text, 'hi <b>x</b>');
  assert.equal(calls[0].update.$set.versions[0].blocks[0].text, 'ok');
});

test('GET includes revision (0 for legacy rows)', async () => {
  const saved = Content.findByNumber;
  Content.findByNumber = async () => doc({ _id: 'c1', contentNumber: 9, blocks: [], favoritedBy: [] });
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await contentController.getContent({ workspace: { _id: 'w1' }, params: { contentNumber: '9' } }, res);
  } finally {
    Content.findByNumber = saved;
  }
  assert.equal(res.body.content.revision, 0);
});
