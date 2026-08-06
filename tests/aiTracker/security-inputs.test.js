/**
 * Phase 8 — input-abuse rows through the real handlers (memory-Mongo tier):
 * oversized domains/names/prompts, empty/whitespace payloads, oversized and
 * malformed bulk-delete arrays, invalid ObjectIds (the B1 fix), invalid
 * frequencies. Every row asserts the 400 AND that nothing was persisted.
 *
 * Run: node --test tests/aiTracker/security-inputs.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const db = require('./helpers/db');

process.env.CHATGPT_API_KEY = 'test-key';
process.env.OPENROUTER_API_KEY = 'test-key';

const Workspace = require('../../src/models/Workspace');
const AiTracker = require('../../src/models/AiTracker');
const AiTrackerPrompt = require('../../src/models/AiTrackerPrompt');
const aiTrackerController = require('../../src/controllers/aiTrackerController');

let ws;
let tracker;

function makeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function call(handler, { params = {}, body = {}, query = {} } = {}) {
  const res = makeRes();
  await aiTrackerController[handler]({
    workspace: ws,
    user: {},
    params: { workspaceNumber: String(ws.workspaceNumber), ...params },
    body,
    query,
  }, res);
  return res;
}

before(async () => {
  await db.connect();
  await db.clear();
  ws = await Workspace.create({
    workspaceNumber: 998001,
    userId: new mongoose.Types.ObjectId(),
    organizationId: null, // org-less: no quota/billing noise, validation still runs
    name: 'Inputs WS',
  });
  tracker = await AiTracker.create({
    workspaceId: ws._id, domain: 'inputs.com', name: 'Inputs Monitor',
    defaultModels: ['chatgpt'], scanStatus: 'ready',
  });
}, { timeout: 300_000 });

after(async () => {
  await db.disconnect();
});

describe('createMonitor input abuse', () => {
  const cases = [
    ['254-char domain', { domain: 'a'.repeat(250) + '.com', prompts: ['p'] }],
    ['domain with spaces', { domain: 'bad domain.com', prompts: ['p'] }],
    ['domain with injection chars', { domain: 'evil.com/<script>', prompts: ['p'] }],
    ['empty prompts array', { domain: 'ok.com', prompts: [] }],
    ['all-whitespace prompts (F4-20 fix)', { domain: 'ok.com', prompts: ['', '   ', '\t'] }],
    ['101-char monitor name', { domain: 'ok.com', name: 'n'.repeat(101), prompts: ['p'] }],
    ['prompts as non-array', { domain: 'ok.com', prompts: 'not-an-array' }],
  ];
  for (const [name, body] of cases) {
    it(`rejects ${name} with 400 and creates nothing`, async () => {
      const beforeCount = await AiTracker.countDocuments({ workspaceId: ws._id });
      const res = await call('createMonitor', { body });
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.equal(await AiTracker.countDocuments({ workspaceId: ws._id }), beforeCount, 'no monitor persisted');
    });
  }
});

describe('prompt input abuse (monitor-scoped)', () => {
  const p = (extra) => ({ params: { monitorId: tracker._id.toString(), ...(extra?.params || {}) }, body: extra?.body || {} });

  it('rejects a 501-char prompt with 400', async () => {
    const res = await call('addMonitorPrompt', p({ body: { prompt: 'x'.repeat(501) } }));
    assert.equal(res.statusCode, 400);
    assert.equal(await AiTrackerPrompt.countDocuments({ trackerId: tracker._id }), 0);
  });

  it('rejects an invalid frequency with 400 (S26/S56)', async () => {
    const res = await call('addMonitorPrompt', p({ body: { prompt: 'valid prompt', frequency: 'Hourly' } }));
    assert.equal(res.statusCode, 400);
  });

  it('rejects empty prompt with 400', async () => {
    const res = await call('addMonitorPrompt', p({ body: { prompt: '   ' } }));
    assert.equal(res.statusCode, 400);
  });

  it('rejects a malformed promptId with 400, not a CastError 500 (B1)', async () => {
    const res = await call('updateMonitorPrompt', p({ params: { promptId: 'not-hex!' }, body: { frequency: 'Weekly' } }));
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  });

  it('rejects a malformed competitorId with 400 (B1)', async () => {
    const res = await call('removeMonitorCompetitor', p({ params: { competitorId: '../../etc/passwd' } }));
    assert.equal(res.statusCode, 400);
  });

  it('rejects a malformed monitorId with 400 (resolveMonitor guard)', async () => {
    const res = await call('getMonitor', { params: { monitorId: 'x'.repeat(23) } });
    assert.equal(res.statusCode, 400);
  });
});

describe('bulk-delete input abuse (B2)', () => {
  const p = (body) => ({ params: { monitorId: tracker._id.toString() }, body });

  it('rejects 501-item arrays with 400', async () => {
    const ids = Array.from({ length: 501 }, () => new mongoose.Types.ObjectId().toString());
    const res = await call('bulkDeleteMonitorPrompts', p({ ids }));
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  });

  it('rejects arrays containing malformed ObjectIds with 400', async () => {
    const res = await call('bulkDeleteMonitorPrompts', p({ ids: [new mongoose.Types.ObjectId().toString(), 'DROP TABLE'] }));
    assert.equal(res.statusCode, 400);
  });

  it('rejects a non-array ids payload with 400', async () => {
    const res = await call('bulkDeleteMonitorPrompts', p({ ids: 'everything' }));
    assert.equal(res.statusCode, 400);
  });
});

describe('updateMonitor input abuse', () => {
  it('rejects a 254-char monitor name with 400', async () => {
    const res = await call('updateMonitor', {
      params: { monitorId: tracker._id.toString() },
      body: { name: 'n'.repeat(254) },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((await AiTracker.findById(tracker._id).lean()).name, 'Inputs Monitor');
  });

  it('rejects an all-invalid defaultModels list with 400 (F19-03)', async () => {
    const res = await call('updateMonitor', {
      params: { monitorId: tracker._id.toString() },
      body: { defaultModels: ['skynet', 'hal9000'] },
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual((await AiTracker.findById(tracker._id).lean()).defaultModels, ['chatgpt']);
  });
});
