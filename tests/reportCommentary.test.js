/**
 * Phase 5 — reportController.generateReport commentary branching.
 *
 * The contract under test (the review's Flaw-1 fix):
 *   - commentary + existing snapshot  → commentary-only update, NO re-aggregation
 *   - commentary + missing snapshot   → falls through to full generation
 *   - commentary + regenerate: true   → full generation (explicit refresh)
 *   - no commentary                   → full generation (dashboard Generate button)
 *   - invalid commentary              → 400 before any service call
 *
 * Run: node --test tests/reportCommentary.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const reportService = require('../src/services/reportService');
const auditService = require('../src/services/auditService');
const reportController = require('../src/controllers/reportController');

const { ObjectId } = mongoose.Types;

const originals = {
  updateCommentary: reportService.updateCommentary,
  generateSnapshot: reportService.generateSnapshot,
  fromReq: auditService.fromReq,
};

let calls;
let audits;

function fakeSnapshot(period, data = {}) {
  return { _id: new ObjectId(), period, generatedAt: new Date(), data };
}

function makeReq(body) {
  return { body, workspace: { _id: new ObjectId() }, user: { userId: 'u1' } };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

beforeEach(() => {
  calls = { updateCommentary: [], generateSnapshot: [] };
  audits = [];
  reportService.updateCommentary = async (...args) => {
    calls.updateCommentary.push(args);
    return fakeSnapshot(args[1], { commentary: args[2] });
  };
  reportService.generateSnapshot = async (...args) => {
    calls.generateSnapshot.push(args);
    return fakeSnapshot(args[1], { commentary: args[2]?.commentary });
  };
  auditService.fromReq = (req, entry) => {
    audits.push(entry);
  };
});

afterEach(() => {
  reportService.updateCommentary = originals.updateCommentary;
  reportService.generateSnapshot = originals.generateSnapshot;
  auditService.fromReq = originals.fromReq;
});

describe('generateReport commentary branching (Phase 5)', () => {
  it('commentary on an existing snapshot takes the fast path — no aggregation', async () => {
    const req = makeReq({ period: '2026-06', commentary: '  A strong month.  ' });
    const res = makeRes();

    await reportController.generateReport(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.updateCommentary.length, 1);
    assert.equal(calls.generateSnapshot.length, 0); // history untouched
    // Trimmed before storage
    assert.equal(calls.updateCommentary[0][2], 'A strong month.');
    assert.equal(res.body.report.commentary, 'A strong month.');
    // Audit marks the edit as commentary-only
    assert.equal(audits.length, 1);
    assert.equal(audits[0].meta.commentaryOnly, true);
  });

  it('falls through to full generation when no snapshot exists yet', async () => {
    reportService.updateCommentary = async (...args) => {
      calls.updateCommentary.push(args);
      return null; // nothing to edit
    };
    const req = makeReq({ period: '2026-06', commentary: 'First words' });
    const res = makeRes();

    await reportController.generateReport(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.updateCommentary.length, 1);
    assert.equal(calls.generateSnapshot.length, 1);
    assert.deepEqual(calls.generateSnapshot[0][2], { commentary: 'First words' });
  });

  it('regenerate: true bypasses the fast path (explicit full refresh)', async () => {
    const req = makeReq({ period: '2026-06', commentary: 'With refresh', regenerate: true });
    const res = makeRes();

    await reportController.generateReport(req, res);

    assert.equal(calls.updateCommentary.length, 0);
    assert.equal(calls.generateSnapshot.length, 1);
    assert.deepEqual(calls.generateSnapshot[0][2], { commentary: 'With refresh' });
  });

  it('no commentary → full generation, preserving the Generate-button behavior', async () => {
    const req = makeReq({ period: '2026-06' });
    const res = makeRes();

    await reportController.generateReport(req, res);

    assert.equal(calls.updateCommentary.length, 0);
    assert.equal(calls.generateSnapshot.length, 1);
    assert.deepEqual(calls.generateSnapshot[0][2], { commentary: undefined });
  });

  it('rejects non-string commentary with 400 before any service call', async () => {
    const req = makeReq({ period: '2026-06', commentary: 42 });
    const res = makeRes();

    await reportController.generateReport(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /must be a string/);
    assert.equal(calls.updateCommentary.length, 0);
    assert.equal(calls.generateSnapshot.length, 0);
  });

  it('rejects over-length commentary with 400 (limit from the service)', async () => {
    const req = makeReq({
      period: '2026-06',
      commentary: 'x'.repeat(reportService.COMMENTARY_MAX_LENGTH + 1),
    });
    const res = makeRes();

    await reportController.generateReport(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /1500/);
    assert.equal(calls.updateCommentary.length, 0);
    assert.equal(calls.generateSnapshot.length, 0);
  });

  it('propagates service-level 400s (invalid period) from the fast path', async () => {
    reportService.updateCommentary = async () => {
      const err = new Error('Invalid period — expected YYYY-MM');
      err.status = 400;
      throw err;
    };
    const req = makeReq({ period: '2026-13', commentary: 'text' });
    const res = makeRes();

    await reportController.generateReport(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Invalid period/);
  });
});
