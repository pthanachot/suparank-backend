/**
 * Wizard analysis ordering — deferAnalysis + startAnalysis.
 *
 * The article wizard needs the declared page type saved BEFORE the first
 * analysis runs (runAnalysis reads content.contentType when calling the
 * engine). So:
 *  - createContent accepts deferAnalysis: true → skips the creation-time
 *    auto-trigger (every other creation path keeps it).
 *  - updateContent accepts a startAnalysis: true directive → kicks off the
 *    deferred analysis exactly like the creation auto-trigger (same billing:
 *    NOT the audited /analyze route). Guarded to analysisStatus === 'idle' so
 *    it can never restart or double-run an analysis.
 *
 * No DB / no network: models and auditService are monkey-patched; the
 * fire-and-forget runAnalysis early-returns via a null Content.findById.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const auditService = require('../src/services/auditService');
const contentController = require('../src/controllers/contentController');

function mkRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// statusUpdates collects every $set passed to Content.findByIdAndUpdate — the
// auto-trigger's observable effect is `{ analysisStatus: 'pending' }`.
function triggeredPending(statusUpdates) {
  return statusUpdates.some((u) => u && u.$set && u.$set.analysisStatus === 'pending');
}

async function runCreate(body) {
  const saved = {
    create: Content.create,
    next: Content.getNextContentNumber,
    upd: Content.findByIdAndUpdate,
    findById: Content.findById,
    audit: auditService.fromReq,
  };
  const statusUpdates = [];
  Content.getNextContentNumber = async () => 42;
  Content.create = async (doc) => ({ _id: 'c1', ...doc });
  Content.findByIdAndUpdate = async (_id, u) => { statusUpdates.push(u); return {}; };
  Content.findById = async () => null; // fire-and-forget runAnalysis early-returns
  auditService.fromReq = () => {};
  const req = { user: { userId: 'u1' }, workspace: { _id: 'w1' }, body };
  const res = mkRes();
  try {
    await contentController.createContent(req, res);
  } finally {
    Content.create = saved.create;
    Content.getNextContentNumber = saved.next;
    Content.findByIdAndUpdate = saved.upd;
    Content.findById = saved.findById;
    auditService.fromReq = saved.audit;
  }
  return { res, statusUpdates };
}

test('createContent(deferAnalysis: true) does NOT auto-trigger analysis', async () => {
  const { res, statusUpdates } = await runCreate({
    title: 't', targetKeywords: ['best seo tool'], deferAnalysis: true,
  });
  assert.equal(res.statusCode, 201);
  assert.equal(triggeredPending(statusUpdates), false, 'deferred creation must not set analysisStatus pending');
});

test('createContent without deferAnalysis keeps the auto-trigger', async () => {
  const { res, statusUpdates } = await runCreate({
    title: 't', targetKeywords: ['best seo tool'],
  });
  assert.equal(res.statusCode, 201);
  assert.equal(triggeredPending(statusUpdates), true, 'non-wizard creation paths must keep auto-analysis');
});

// The directive claims the run via an ATOMIC findOneAndUpdate CAS
// ({ _id, analysisStatus: 'idle' } → pending) so two concurrent requests can
// never both start an engine run. The stub emulates that: a claim query
// matches only when the stored status is actually 'idle'.
async function runUpdate(body, existingStatus) {
  const saved = {
    findOne: Content.findOneAndUpdate,
    upd: Content.findByIdAndUpdate,
    findById: Content.findById,
    audit: auditService.fromReq,
  };
  const claimAttempts = [];
  let claimsWon = 0;
  let capturedSet = null;
  Content.findOneAndUpdate = async (q, set) => {
    if (q.analysisStatus === 'idle') {
      // CAS claim attempt from the startAnalysis directive
      claimAttempts.push(set);
      if (existingStatus === 'idle') { claimsWon += 1; return { _id: 'c1' }; }
      return null; // status moved on — claim loses, no analysis starts
    }
    capturedSet = set.$set;
    return {
      _id: 'c1', contentNumber: 5, analysisStatus: existingStatus,
      targetKeywords: ['best seo tool'], locked: false,
    };
  };
  Content.findByIdAndUpdate = async () => ({});
  Content.findById = async () => null; // fire-and-forget runAnalysis early-returns
  auditService.fromReq = () => {};
  const req = {
    user: { userId: 'u1' },
    workspace: { _id: 'w1' },
    params: { contentNumber: '5' },
    body,
  };
  const res = mkRes();
  try {
    await contentController.updateContent(req, res);
  } finally {
    Content.findOneAndUpdate = saved.findOne;
    Content.findByIdAndUpdate = saved.upd;
    Content.findById = saved.findById;
    auditService.fromReq = saved.audit;
  }
  return { res, claimAttempts, claimsWon, capturedSet };
}

test('updateContent(startAnalysis) claims and starts the deferred analysis when idle', async () => {
  const { claimAttempts, claimsWon } = await runUpdate(
    { contentType: 'product-page', startAnalysis: true }, 'idle',
  );
  assert.equal(claimAttempts.length, 1, 'idle + startAnalysis must attempt the CAS claim');
  assert.equal(claimsWon, 1);
  assert.deepEqual(claimAttempts[0], { $set: { analysisStatus: 'pending' } });
});

test('updateContent(startAnalysis) is a no-op when analysis already ran', async () => {
  for (const status of ['ready', 'analyzing', 'pending', 'failed']) {
    const { claimAttempts } = await runUpdate(
      { contentType: 'product-page', startAnalysis: true }, status,
    );
    assert.equal(claimAttempts.length, 0, `status=${status} must not even attempt a claim`);
  }
});

test('updateContent without startAnalysis never triggers analysis', async () => {
  const { claimAttempts } = await runUpdate({ contentType: 'product-page' }, 'idle');
  assert.equal(claimAttempts.length, 0);
});

test('startAnalysis is a directive, not a field — it must not be persisted', async () => {
  const { capturedSet } = await runUpdate(
    { contentType: 'product-page', startAnalysis: true }, 'idle',
  );
  assert.equal('startAnalysis' in capturedSet, false, 'directive leaked into the $set update');
  assert.equal(capturedSet.contentType, 'product-page');
});
