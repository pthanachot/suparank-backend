/**
 * QA gap (Phase 2): the "marked done" lock enforced on the server.
 *
 *   1. services/doneLock: what counts as a content change.
 *   2. middleware rejectIfDone: refuses AI starts on a done article.
 *   3. route wiring: exactly the AI-starting routes carry the guard, before
 *      the credit gate; the run-control routes (stop, steer, ...) do not.
 *   4. updateContent against a REAL in-memory MongoDB: refusals, the allowed
 *      saves (identical autosave, reopen, non-content fields), and the race
 *      where the article is marked done between the check and the write.
 */
const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Content = require('../src/models/Content');
const contentController = require('../src/controllers/contentController');
const imageStorage = require('../src/services/imageStorage');
const { rejectIfDone } = require('../src/middleware/lockGuard');
const {
  DONE_CODE, doneLockBody, isReopen, touchesContent, changesContent, canonical,
} = require('../src/services/doneLock');

// ─── 1. pure rules ───────────────────────────────────────────

describe('doneLock rules', () => {
  test('isReopen: only a status other than done', () => {
    assert.equal(isReopen({}), false);
    assert.equal(isReopen({ status: 'done' }), false);
    assert.equal(isReopen({ status: null }), false);
    for (const s of ['draft', 'optimizing', 'published', 'scheduled']) assert.equal(isReopen({ status: s }), true, s);
  });

  test('touchesContent: blocks/title/slug/description only', () => {
    assert.equal(touchesContent({ score: 5, versions: [], publishedUrl: 'x', status: 'done' }), false);
    for (const f of ['blocks', 'title', 'slug', 'description']) assert.equal(touchesContent({ [f]: '' }), true, f);
  });

  test('canonical ignores key order and undefined', () => {
    assert.equal(canonical({ a: 1, b: { c: 2, d: undefined } }), canonical({ b: { c: 2 }, a: 1 }));
    assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  });

  const stored = {
    title: 'T', slug: 's', description: 'D',
    blocks: [
      { id: 'a', type: 'h1', text: 'Title', faqItems: [] },
      { id: 'b', type: 'p', text: 'Body <strong>bold</strong>', faqItems: [] },
      { id: 'c', type: 'faq', text: '', faqItems: [{ question: 'Q', answer: 'A' }] },
    ],
  };

  test('identical content is not a change, whatever the key order or omitted defaults', () => {
    assert.equal(changesContent(Content, stored, {
      title: 'T', slug: 's', description: 'D',
      blocks: [
        { type: 'h1', id: 'a', text: 'Title' }, // no faqItems: the model default fills it
        { text: 'Body <strong>bold</strong>', id: 'b', type: 'p' },
        { id: 'c', type: 'faq', faqItems: [{ answer: 'A', question: 'Q' }] }, // no text: default ''
      ],
    }), false);
    // Fields not in the update are not compared.
    assert.equal(changesContent(Content, stored, { score: 99 }), false);
  });

  test('any real difference is a change', () => {
    const b = stored.blocks;
    const cases = {
      title: { title: 'T2' },
      slug: { slug: 's2' },
      description: { description: '' },
      text: { blocks: [b[0], { ...b[1], text: 'Body' }, b[2]] },
      order: { blocks: [b[1], b[0], b[2]] },
      removed: { blocks: [b[0], b[1]] },
      added: { blocks: [...b, { id: 'd', type: 'p', text: 'x' }] },
      type: { blocks: [b[0], { ...b[1], type: 'quote' }, b[2]] },
      faq: { blocks: [b[0], b[1], { ...b[2], faqItems: [{ question: 'Q', answer: 'B' }] }] },
      align: { blocks: [b[0], { ...b[1], align: 'center' }, b[2]] },
    };
    for (const [name, upd] of Object.entries(cases)) {
      assert.equal(changesContent(Content, stored, upd), true, name);
    }
  });

  test('fields the schema drops on save are not a change (legacy or unknown keys)', () => {
    assert.equal(changesContent(Content, stored, {
      blocks: stored.blocks.map((x) => ({ ...x, clientOnlyFlag: true })),
    }), false);
  });

  test('null and missing title/description compare as empty', () => {
    assert.equal(changesContent(Content, { title: null, description: undefined, blocks: [] }, { title: '', description: null }), false);
  });

  test('the 409 body: code, done flag, no em dash', () => {
    for (const kind of ['edit', 'ai']) {
      const b = doneLockBody(kind);
      assert.equal(b.code, DONE_CODE);
      assert.equal(b.done, true);
      assert.equal(b.status, 'done');
      assert.match(b.error, /Reopen it as a draft/);
      assert.doesNotMatch(b.error, /—/);
    }
    assert.match(doneLockBody('ai').error, /use the AI/);
  });
});

// ─── 2. middleware ───────────────────────────────────────────

function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function runGuard(guard, { status, throws = false, workspace = { _id: 'w1' }, contentNumber = '7' } = {}) {
  const orig = Content.findOne;
  let query = null;
  Content.findOne = async (filter, proj, opts) => {
    query = { filter, proj, opts };
    if (throws) throw new Error('db down');
    return status === undefined ? null : { status };
  };
  const res = mkRes();
  let nexted = false;
  try {
    await guard({ workspace, params: { contentNumber } }, res, () => { nexted = true; });
  } finally {
    Content.findOne = orig;
  }
  return { res, nexted, query };
}

describe('rejectIfDone middleware', () => {
  test('done → 409 ARTICLE_DONE with the AI message, no next()', async () => {
    const { res, nexted, query } = await runGuard(rejectIfDone(), { status: 'done' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'ARTICLE_DONE');
    assert.match(res.body.error, /use the AI/);
    assert.deepEqual(query.filter, { workspaceId: 'w1', contentNumber: 7 });
    assert.deepEqual(query.opts, { lean: true });
  });

  test('quiet (autocomplete) → 200 { completion: "" }', async () => {
    const { res, nexted } = await runGuard(rejectIfDone({ quiet: true }), { status: 'done' });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { completion: '' });
  });

  test('every other status passes', async () => {
    for (const status of ['draft', 'optimizing', 'published', 'scheduled', undefined]) {
      const { nexted, res } = await runGuard(rejectIfDone(), { status });
      assert.equal(nexted, true, String(status));
      assert.equal(res.body, null);
    }
  });

  test('fails open on a DB error and without a workspace or number', async () => {
    assert.equal((await runGuard(rejectIfDone(), { status: 'done', throws: true })).nexted, true);
    assert.equal((await runGuard(rejectIfDone(), { status: 'done', workspace: null })).nexted, true);
    assert.equal((await runGuard(rejectIfDone(), { status: 'done', contentNumber: 'abc' })).nexted, true);
  });
});

// ─── 3. route wiring ─────────────────────────────────────────

describe('route wiring', () => {
  const router = require('../src/routes/workspaceRoutes');
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/workspaceRoutes.js'), 'utf8');

  function layer(suffix, method = 'post') {
    return router.stack.find((l) => l.route && l.route.path === `/:workspaceNumber/content/:contentNumber/${suffix}` && l.route.methods[method]);
  }
  const guardOf = (l) => l.route.stack.map((s) => s.handle.doneGuard).find(Boolean);

  const GUARDED = ['ai/chat', 'ai/agent', 'ai/generate-image', 'ai/inline-edit', 'ai/clarify-answer', 'ai/plan-confirm',
    'plan/enter', 'plan/fast', 'plan/approve', 'plan/reopen', 'import-url', 'internal-links'];
  const OPEN = [['ai/stop'], ['ai/stop-revert'], ['ai/steer'], ['plan/reject'], ['plan', 'patch'], ['plan/continue'],
    ['ai/upload-image'], ['ai/rehost-image'], ['comments'], ['audit'], ['writing-quality'], ['reanalyze'], ['readability-check']];

  test('AI-starting routes carry the done guard', () => {
    for (const s of GUARDED) {
      const l = layer(s);
      assert.ok(l, `route ${s} exists`);
      assert.equal(guardOf(l), true, `${s} is done-guarded`);
    }
    assert.equal(guardOf(layer('ai/autocomplete')), 'quiet', 'autocomplete uses the quiet guard');
  });

  test('run controls, comments and analysis stay open on a done article', () => {
    for (const [s, m] of OPEN) {
      const l = layer(s, m || 'post');
      assert.ok(l, `route ${s} exists`);
      assert.equal(guardOf(l), undefined, `${s} must not be done-guarded`);
    }
    // The content PUT is guarded inside the controller (field-aware), not here.
    const put = router.stack.find((l) => l.route && l.route.path === '/:workspaceNumber/content/:contentNumber' && l.route.methods.put);
    assert.equal(guardOf(put), undefined);
  });

  test('the guard sits before the credit gate wherever both exist', () => {
    const lines = src.split('\n').filter((ln) => ln.includes('rejectIfDone(') && ln.includes('router.'));
    assert.ok(lines.length >= GUARDED.length + 1);
    for (const ln of lines) {
      const rc = ln.indexOf(' rc(');
      if (rc !== -1) assert.ok(ln.indexOf('rejectIfDone(') < rc, ln.trim());
    }
  });
});

// ─── 4. updateContent on a real MongoDB ──────────────────────

describe('updateContent done lock (real MongoDB)', () => {
  const saved = [];
  const stub = (o, k, v) => { saved.push([o, k, o[k]]); o[k] = v; };
  let uploads = 0;

  before(async () => {
    await connect();
    await Content.init();
    stub(imageStorage, 'isEnabled', () => true);
    stub(imageStorage, 'uploadFromDataUri', async () => { uploads++; return 'https://cdn.example/img.png'; });
  });
  after(async () => {
    for (let i = saved.length - 1; i >= 0; i--) { const [o, k, v] = saved[i]; o[k] = v; }
    await disconnect();
  });
  beforeEach(async () => { await clear(); uploads = 0; });

  const WS = new mongoose.Types.ObjectId();
  const USER = new mongoose.Types.ObjectId();
  let seq = 5000;
  const BLOCKS = [
    { id: 'h', type: 'h1', text: 'Finished piece' },
    { id: 'p', type: 'p', text: 'Final <em>copy</em> here.' },
    { id: 'f', type: 'faq', faqItems: [{ question: 'Q?', answer: 'A.' }] },
  ];

  async function makeDoc(fields = {}) {
    const contentNumber = seq++;
    await Content.create({ userId: USER, workspaceId: WS, contentNumber, title: 'Done title', slug: 'done', description: 'Meta', blocks: BLOCKS, status: 'done', ...fields });
    return contentNumber;
  }
  async function put(contentNumber, body) {
    const res = mkRes();
    await contentController.updateContent({
      workspace: { _id: WS, organizationId: null }, params: { contentNumber: String(contentNumber) },
      body, user: { userId: String(USER) },
    }, res);
    return res;
  }
  const read = (n) => Content.findOne({ workspaceId: WS, contentNumber: n }).lean();

  test('a content change on a done article → 409 ARTICLE_DONE and nothing is written', async () => {
    const n = await makeDoc();
    const before = await read(n);
    for (const body of [
      { blocks: [...BLOCKS, { id: 'x', type: 'p', text: 'sneaky' }] },
      { title: 'New title' },
      { slug: 'new-slug' },
      { description: 'New meta' },
      { blocks: BLOCKS.slice(0, 2), status: 'done' }, // keeps done → still a change
      { blocks: [{ id: 'h', type: 'h1', text: 'x' }], baseRevision: 99 }, // stale revision: done wins
    ]) {
      const res = await put(n, body);
      assert.equal(res.statusCode, 409, JSON.stringify(body));
      assert.equal(res.body.code, 'ARTICLE_DONE');
      assert.match(res.body.error, /Reopen it as a draft to edit it/);
    }
    const after = await read(n);
    assert.equal(after.revision, before.revision, 'no write happened');
    assert.deepEqual(after.blocks, before.blocks);
    assert.equal(after.title, 'Done title');
  });

  test('a refused save uploads no images', async () => {
    const n = await makeDoc();
    const res = await put(n, { blocks: [...BLOCKS, { id: 'i', type: 'img', src: 'data:image/png;base64,AAAA' }] });
    assert.equal(res.statusCode, 409);
    assert.equal(uploads, 0);
  });

  test('an autosave with identical content (score, versions) still saves on a done article', async () => {
    const n = await makeDoc();
    const stored = await read(n);
    const res = await put(n, {
      title: stored.title, slug: stored.slug, description: stored.description,
      // Re-sent the way the editor sends it: no defaults, different key order.
      blocks: BLOCKS.map((b) => ({ ...b })).reverse().reverse(),
      score: 77, wordCount: 12,
      versions: [{ id: 'v1', label: 'Snapshot', timestamp: Date.now(), blocks: BLOCKS }],
      baseRevision: stored.revision,
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const after = await read(n);
    assert.equal(after.score, 77);
    assert.equal(after.versions.length, 1);
    assert.equal(after.status, 'done');
    assert.equal(after.revision, stored.revision + 1);
  });

  test('non-content fields save without any status read', async () => {
    const n = await makeDoc();
    const orig = Content.findOne;
    let reads = 0;
    Content.findOne = function (...a) { reads++; return orig.apply(this, a); };
    try {
      const res = await put(n, { publishedUrl: 'https://example.com/p', folder: 'Archive', score: 5 });
      assert.equal(res.statusCode, 200);
    } finally { Content.findOne = orig; }
    assert.equal(reads, 0);
    assert.equal((await read(n)).publishedUrl, 'https://example.com/p');
  });

  test('reopening saves the status and the body sent with it', async () => {
    const n = await makeDoc();
    const res = await put(n, { status: 'draft', blocks: [...BLOCKS, { id: 'z', type: 'p', text: 'typed before the lock' }] });
    assert.equal(res.statusCode, 200);
    const after = await read(n);
    assert.equal(after.status, 'draft');
    assert.equal(after.blocks.length, 4);
    // ...and editing works normally afterwards.
    const res2 = await put(n, { title: 'Edited after reopen' });
    assert.equal(res2.statusCode, 200);
    assert.equal((await read(n)).title, 'Edited after reopen');
  });

  test('a draft saves normally, with the not-done guard in the write filter', async () => {
    const n = await makeDoc({ status: 'draft' });
    const orig = Content.findOneAndUpdate;
    let filter = null;
    Content.findOneAndUpdate = function (f, ...rest) { filter = f; return orig.call(this, f, ...rest); };
    try {
      const res = await put(n, { blocks: [{ id: 'a', type: 'p', text: 'new' }] });
      assert.equal(res.statusCode, 200);
    } finally { Content.findOneAndUpdate = orig; }
    assert.deepEqual(filter.status, { $ne: 'done' });
  });

  test('marking done in the same save as the last edit is allowed', async () => {
    const n = await makeDoc({ status: 'draft' });
    const res = await put(n, { status: 'done', blocks: [{ id: 'a', type: 'p', text: 'last edit' }] });
    assert.equal(res.statusCode, 200);
    const after = await read(n);
    assert.equal(after.status, 'done');
    assert.equal(after.blocks[0].text, 'last edit');
  });

  // The race: the status read says "draft", then another tab marks the article
  // done, then this save's write runs. Simulated by flipping the status right
  // after the controller's status read.
  async function racePut(n, body) {
    const orig = Content.findOne;
    let flipped = false;
    Content.findOne = function (filter, proj, opts) {
      const q = orig.call(this, filter, proj, opts);
      if (!flipped && proj && proj.status === 1 && Object.keys(proj).length === 1) {
        flipped = true;
        return Promise.resolve(q).then(async (r) => {
          await Content.collection.updateOne({ workspaceId: WS, contentNumber: n }, { $set: { status: 'done' }, $inc: { revision: 1 } });
          return r;
        });
      }
      return q;
    };
    try { return await put(n, body); } finally { Content.findOne = orig; }
  }

  test('race: marked done between the check and the write → 409 ARTICLE_DONE, content untouched', async () => {
    const n = await makeDoc({ status: 'draft' });
    const res = await racePut(n, { blocks: [{ id: 'a', type: 'p', text: 'late edit' }] });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'ARTICLE_DONE');
    const after = await read(n);
    assert.equal(after.status, 'done');
    assert.equal(after.blocks.length, 3, 'the done copy survived');
  });

  test('race with an identical body (benign autosave) still saves', async () => {
    const n = await makeDoc({ status: 'draft' });
    const res = await racePut(n, { blocks: BLOCKS, score: 42 });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const after = await read(n);
    assert.equal(after.status, 'done');
    assert.equal(after.score, 42);
  });

  test('20 concurrent edit saves racing one Mark done: the done copy is never overwritten after done', async () => {
    const n = await makeDoc({ status: 'draft' });
    const edits = Array.from({ length: 20 }, (_, i) => put(n, { blocks: [{ id: 'a', type: 'p', text: `edit ${i}` }] }));
    const done = put(n, { status: 'done' });
    const results = await Promise.all([...edits, done]);
    const doneRes = results[20];
    assert.equal(doneRes.statusCode, 200);
    const final = await read(n);
    assert.equal(final.status, 'done');
    // Every edit either landed before done (200) or was refused (409 ARTICLE_DONE).
    for (const r of results.slice(0, 20)) {
      assert.ok(r.statusCode === 200 || (r.statusCode === 409 && r.body.code === 'ARTICLE_DONE'), `${r.statusCode} ${JSON.stringify(r.body)}`);
    }
    // The stored text is the one the done save saw (or an edit that beat it):
    // after done, a refused edit can't have written. Re-check: no edit now passes.
    const late = await put(n, { blocks: [{ id: 'a', type: 'p', text: 'after done' }] });
    assert.equal(late.statusCode, 409);
    assert.notEqual((await read(n)).blocks[0].text, 'after done');
  });

  // Review fix: old documents. GET hands the client a transformed copy (old
  // image URLs migrated; the save path sanitizes), so echoing it back must not
  // count as an edit of a done article.
  async function makeLegacyDone(blocks) {
    const contentNumber = seq++;
    await Content.collection.insertOne({
      userId: USER, workspaceId: WS, contentNumber, title: 'Legacy', slug: 'legacy', description: 'm',
      blocks, status: 'done', revision: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    return contentNumber;
  }

  test('legacy unsanitized markup: echoing the stored copy is not an edit; a real edit still is', async () => {
    const raw = [{ id: 'p', type: 'p', text: 'Hi <img src=x onerror="alert(1)"> there <a href="javascript:alert(2)">x</a>' }];
    const n = await makeLegacyDone(raw);
    const echo = await put(n, { blocks: raw, score: 9 });
    assert.equal(echo.statusCode, 200, JSON.stringify(echo.body));
    const edit = await put(n, { blocks: [{ id: 'p', type: 'p', text: 'Different' }] });
    assert.equal(edit.statusCode, 409);
    assert.equal(edit.body.code, 'ARTICLE_DONE');
  });

  test('legacy image URL: the migrated src GET returns is not an edit; another src is', async () => {
    stub(imageStorage, 'migratePublicUrl', (src) => (src === 'https://old-bucket.example/images/a.png' ? '/api/b2-image/images/a.png' : null));
    try {
      const n = await makeLegacyDone([{ id: 'i', type: 'img', src: 'https://old-bucket.example/images/a.png', alt: 'a' }]);
      const echo = await put(n, { blocks: [{ id: 'i', type: 'img', src: '/api/b2-image/images/a.png', alt: 'a' }], score: 3 });
      assert.equal(echo.statusCode, 200, JSON.stringify(echo.body));
      const swap = await put(n, { blocks: [{ id: 'i', type: 'img', src: '/api/b2-image/images/b.png', alt: 'a' }] });
      assert.equal(swap.statusCode, 409);
    } finally {
      const i = saved.findIndex(([o, k]) => o === imageStorage && k === 'migratePublicUrl');
      const [o, k, v] = saved.splice(i, 1)[0];
      o[k] = v;
    }
  });

  test('a stale-revision save on a DRAFT is still an ordinary revision conflict', async () => {
    const n = await makeDoc({ status: 'draft' });
    const res = await put(n, { title: 'x', baseRevision: 42 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'revision_conflict');
  });
});
