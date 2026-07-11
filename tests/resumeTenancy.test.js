/**
 * Phase 3 — resume-loop hardening.
 *   3.1 tenancy binding: clarify-answer / plan-confirm accept only the sessionId
 *       bound to THIS content's active session (contentSessionMap), resolved
 *       from the authenticated URL.
 *   3.2 status passthrough: the engine's HTTP status (404 gone / 409 wrong
 *       state) surfaces instead of a flat 500.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const writingEngine = require('../src/services/writingEngine');
const { clarifyAnswer, planConfirm, contentSessionMap, rememberSession } = require('../src/controllers/aiController');

const CONTENT_ID = 'content-abc';
const SESSION = 'sess-1';

const originals = {
  cFindByNumber: Content.findByNumber,
  submitClarifyAnswer: writingEngine.submitClarifyAnswer,
  submitPlanConfirm: writingEngine.submitPlanConfirm,
};
after(() => {
  Content.findByNumber = originals.cFindByNumber;
  writingEngine.submitClarifyAnswer = originals.submitClarifyAnswer;
  writingEngine.submitPlanConfirm = originals.submitPlanConfirm;
  contentSessionMap.clear();
});

function res() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = (body) => ({ workspace: { _id: 'ws1' }, params: { contentNumber: '5' }, body });

// Seed the binding through the REAL rememberSession so the test exercises the
// set carry-forward. Pass multiple ids to simulate a concurrent same-content
// setupSession minting a newer session while an earlier one is still paused.
function bind(...sessionIds) {
  for (const sid of sessionIds) rememberSession(CONTENT_ID, sid);
}

beforeEach(() => {
  contentSessionMap.clear();
  Content.findByNumber = async () => ({ _id: CONTENT_ID });
  writingEngine.submitClarifyAnswer = async () => ({ status: 'ok' });
  writingEngine.submitPlanConfirm = async () => ({ status: 'ok' });
});

describe('clarifyAnswer tenancy + status passthrough', () => {
  it('400 when required fields are missing', async () => {
    const r = res();
    await clarifyAnswer(req({ sessionId: SESSION }), r); // no answer
    assert.equal(r.statusCode, 400);
  });

  it('409 when no session is bound to the content', async () => {
    const r = res();
    await clarifyAnswer(req({ sessionId: SESSION, answer: 'a' }), r);
    assert.equal(r.statusCode, 409);
  });

  it('409 when the sessionId does not match the bound session', async () => {
    bind(SESSION);
    const r = res();
    await clarifyAnswer(req({ sessionId: 'someone-elses', answer: 'a' }), r);
    assert.equal(r.statusCode, 409);
  });

  it('passes through to the engine when the sessionId matches', async () => {
    bind(SESSION);
    let gotSession = null;
    writingEngine.submitClarifyAnswer = async (sid) => { gotSession = sid; return { status: 'ok' }; };
    const r = res();
    await clarifyAnswer(req({ sessionId: SESSION, answer: 'a' }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(gotSession, SESSION);
    assert.deepEqual(r.body, { status: 'ok' });
  });

  it('accepts a still-paused session after a concurrent same-content session (no spurious 409)', async () => {
    // S1 is paused for clarify; a concurrent setupSession (2nd tab / image-gen /
    // non-reusing chat) minted S2 and overwrote the primary binding.
    bind('S1', 'S2');
    const entry = contentSessionMap.get(CONTENT_ID);
    assert.equal(entry.sessionId, 'S2', 'primary tracks the newest session');
    assert.ok(entry.sessionIds.has('S1'), 'earlier paused session is still bound');
    let gotSession = null;
    writingEngine.submitClarifyAnswer = async (sid) => { gotSession = sid; return { status: 'ok' }; };
    const r = res();
    await clarifyAnswer(req({ sessionId: 'S1', answer: 'a' }), r);
    assert.equal(r.statusCode, 200, 'resuming the paused S1 must NOT 409');
    assert.equal(gotSession, 'S1', 'forwards the actual paused session, not the newest');
  });

  it('passes the engine HTTP status through (409, not 500)', async () => {
    bind(SESSION);
    writingEngine.submitClarifyAnswer = async () => {
      const err = new Error('wrong state');
      err.status = 409;
      throw err;
    };
    const r = res();
    await clarifyAnswer(req({ sessionId: SESSION, answer: 'a' }), r);
    assert.equal(r.statusCode, 409);
  });

  it('falls back to 500 for a non-HTTP failure (no status)', async () => {
    bind(SESSION);
    writingEngine.submitClarifyAnswer = async () => { throw new Error('engine unreachable'); };
    const r = res();
    await clarifyAnswer(req({ sessionId: SESSION, answer: 'a' }), r);
    assert.equal(r.statusCode, 500);
  });
});

describe('planConfirm tenancy + status passthrough', () => {
  it('409 when the sessionId does not match the bound session', async () => {
    bind(SESSION);
    const r = res();
    await planConfirm(req({ sessionId: 'someone-elses', action: 'confirm' }), r);
    assert.equal(r.statusCode, 409);
  });

  it('passes through to the engine when the sessionId matches', async () => {
    bind(SESSION);
    let gotSession = null;
    writingEngine.submitPlanConfirm = async (sid) => { gotSession = sid; return { status: 'ok' }; };
    const r = res();
    await planConfirm(req({ sessionId: SESSION, action: 'confirm' }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(gotSession, SESSION);
  });

  it('passes the engine HTTP status through (404, not 500)', async () => {
    bind(SESSION);
    writingEngine.submitPlanConfirm = async () => {
      const err = new Error('session gone');
      err.status = 404;
      throw err;
    };
    const r = res();
    await planConfirm(req({ sessionId: SESSION, action: 'confirm' }), r);
    assert.equal(r.statusCode, 404);
  });
});
