'use strict';

// A4: runAnalysis must forward the content's resolved locale (gl/hl for Serper,
// location_code/language_code for DataForSEO) to the engine on the discover AND
// analyze calls. We monkeypatch the model/service singletons and global.fetch to
// capture the outbound request bodies without a DB or a live engine.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const tierService = require('../src/services/tierService');
const { runAnalysis } = require('../src/controllers/analysisController');

const real = {
  fetch: global.fetch,
  findById: Content.findById,
  findByIdAndUpdate: Content.findByIdAndUpdate,
  wsFindById: Workspace.findById,
  getTier: tierService.getOrgTierConfig,
};

afterEach(() => {
  global.fetch = real.fetch;
  Content.findById = real.findById;
  Content.findByIdAndUpdate = real.findByIdAndUpdate;
  Workspace.findById = real.wsFindById;
  tierService.getOrgTierConfig = real.getTier;
});

function stub(content) {
  Content.findById = async () => content;
  Content.findByIdAndUpdate = async () => ({});
  Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: null }) }) });
  tierService.getOrgTierConfig = async () => ({ tier: '' });

  const bodies = {};
  global.fetch = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    try { bodies[path] = JSON.parse(opts.body); } catch { bodies[path] = null; }
    // ok + no job_id → analyzeViaEngine returns immediately (no poll loop);
    // discover reads candidates:[]. Keeps runAnalysis moving without a real engine.
    return { ok: true, status: 200, json: async () => ({ candidates: [] }), text: async () => '{}' };
  };
  return bodies;
}

test('runAnalysis forwards resolved locale (DE market, Spanish) to discover + analyze', async () => {
  const bodies = stub({ _id: 'c1', targetKeywords: ['crm'], country: 'DE', language: 'es', contentType: '', workspaceId: 'w1' });
  await runAnalysis('c1');

  for (const path of ['/api/discover', '/api/analyze/jobs']) {
    const b = bodies[path];
    assert.ok(b, `${path} was called`);
    assert.equal(b.gl, 'de', `${path} gl`);
    assert.equal(b.hl, 'es', `${path} hl`);
    assert.equal(b.location_code, 2276, `${path} location_code`);
    assert.equal(b.language_code, 'es', `${path} language_code`);
    assert.deepEqual(b.keywords, ['crm'], `${path} keywords preserved`);
  }
});

test('runAnalysis defaults empty country/language to US/English (byte-identical to pre-locale)', async () => {
  const bodies = stub({ _id: 'c2', targetKeywords: ['crm'], country: '', language: '', contentType: '', workspaceId: 'w1' });
  await runAnalysis('c2');

  const d = bodies['/api/discover'];
  assert.ok(d);
  assert.equal(d.gl, 'us');
  assert.equal(d.hl, 'en');
  assert.equal(d.location_code, 2840);
  assert.equal(d.language_code, 'en');
});

test('runAnalysis honors an existing country while defaulting language to English', async () => {
  const bodies = stub({ _id: 'c3', targetKeywords: ['crm'], country: 'TH', language: 'en', contentType: '', workspaceId: 'w1' });
  await runAnalysis('c3');

  const d = bodies['/api/discover'];
  assert.ok(d);
  assert.equal(d.gl, 'th');
  assert.equal(d.hl, 'en');
  assert.equal(d.location_code, 2764);
  assert.equal(d.language_code, 'en');
});
