/**
 * Phase 4 — Node threading of the tier preset into the controllers.
 *  - aiController.resolvePreset: req → preset (via tierService), fail-safe to "".
 *  - analysisController.runAnalysis: sends `preset` on the engine /analyze +
 *    /recommend-outline bodies (budget for Free, absent/"" for paid).
 *
 * No DB / no network: models, tierService, and global.fetch are monkey-patched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tierService = require('../src/services/tierService');
const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const aiController = require('../src/controllers/aiController');
const analysisController = require('../src/controllers/analysisController');

// ─── aiController.resolvePreset ─────────────────────────────────────────

test('resolvePreset: Free org → "budget"', async () => {
  const orig = tierService.getOrgTierConfig;
  tierService.getOrgTierConfig = async () => ({ tier: 'free' });
  try {
    assert.equal(await aiController.resolvePreset({ creditContext: { orgId: 'o1' } }), 'budget');
  } finally { tierService.getOrgTierConfig = orig; }
});

test('resolvePreset: paid org → "" (base)', async () => {
  const orig = tierService.getOrgTierConfig;
  tierService.getOrgTierConfig = async () => ({ tier: 'professional' });
  try {
    assert.equal(await aiController.resolvePreset({ creditContext: { orgId: 'o1' } }), '');
  } finally { tierService.getOrgTierConfig = orig; }
});

test('resolvePreset: no creditContext → "" (never throws)', async () => {
  assert.equal(await aiController.resolvePreset({}), '');
  assert.equal(await aiController.resolvePreset({ creditContext: {} }), '');
});

test('resolvePreset: tierService failure → "" (fail-safe)', async () => {
  const orig = tierService.getOrgTierConfig;
  tierService.getOrgTierConfig = async () => { throw new Error('db down'); };
  try {
    assert.equal(await aiController.resolvePreset({ creditContext: { orgId: 'o1' } }), '');
  } finally { tierService.getOrgTierConfig = orig; }
});

// ─── analysisController.runAnalysis threads preset into engine bodies ────

// Drive runAnalysis with a fully stubbed environment and capture the JSON
// bodies POSTed to each engine endpoint.
async function runAndCapture(tier, contentType) {
  const saved = {
    findById: Content.findById,
    update: Content.findByIdAndUpdate,
    wsFind: Workspace.findById,
    tier: tierService.getOrgTierConfig,
    fetch: global.fetch,
  };
  const bodies = {};
  const headers = {};
  Content.findById = async () => ({
    _id: 'c1', workspaceId: 'w1', targetKeywords: ['best seo tool'],
    ...(contentType ? { contentType } : {}),
  });
  Content.findByIdAndUpdate = async () => ({});
  Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: 'org1' }) }) });
  tierService.getOrgTierConfig = async () => ({ tier });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.body) { try { bodies[u.split('/api/')[1]] = JSON.parse(opts.body); } catch { /* ignore */ } }
    if (opts.headers) { headers[u.split('/api/')[1]] = opts.headers; }
    const json = async () => {
      if (u.includes('/discover')) return { candidates: [] };
      if (u.includes('/analyze')) return { content_brief: {}, competitor_pages: [], pipeline_steps: [], conversations: [] };
      if (u.includes('/ai-format-recommend')) return { nlp_terms: [] };
      if (u.includes('/recommend-outline')) return { sections: [] };
      return {};
    };
    return { ok: true, status: 200, json, text: async () => '' };
  };
  try {
    await analysisController.runAnalysis('c1');
  } finally {
    Content.findById = saved.findById;
    Content.findByIdAndUpdate = saved.update;
    Workspace.findById = saved.wsFind;
    tierService.getOrgTierConfig = saved.tier;
    global.fetch = saved.fetch;
  }
  return { bodies, headers };
}

// CONTRACT CORRECTION (2026-07-11): the engine reads `preset` from the request
// BODY (handleAnalyze/recommend-outline decode a `preset` JSON field). It has
// NO X-Model-Preset handling — the "withPreset middleware" the 2026-07-09
// cleanup referenced never existed in any engine commit or branch (verified
// via git log -S across the engine repo). That cleanup therefore severed the
// Free tier's budget preset entirely: header-only delivery meant Free runs
// silently burned base-model COGS. engineFetch now merges preset into the
// body (the real contract) and still sends the header (informational). These
// tests pin the BODY threading — the field the engine actually reads.
test('runAnalysis(Free): /analyze + /recommend-outline carry body preset "budget"', async () => {
  const { bodies, headers } = await runAndCapture('free');
  assert.ok(bodies.analyze, 'analyze was called');
  assert.equal(bodies.analyze.preset, 'budget');
  assert.ok(bodies['recommend-outline'], 'recommend-outline was called');
  assert.equal(bodies['recommend-outline'].preset, 'budget');
  // Header still rides along for proxy-log visibility.
  assert.equal(headers.analyze['X-Model-Preset'], 'budget');
  assert.equal(headers['recommend-outline']['X-Model-Preset'], 'budget');
});

test('runAnalysis(paid): no preset in body or header (base models)', async () => {
  const { bodies, headers } = await runAndCapture('professional');
  assert.ok(bodies.analyze, 'analyze was called');
  assert.equal('preset' in bodies.analyze, false);
  assert.equal('preset' in bodies['recommend-outline'], false);
  assert.equal('X-Model-Preset' in (headers.analyze || {}), false);
  assert.equal('X-Model-Preset' in (headers['recommend-outline'] || {}), false);
});

// ─── runAnalysis threads the declared page type into /analyze ────────────

test('runAnalysis forwards content.contentType as body content_type', async () => {
  const { bodies } = await runAndCapture('professional', 'product-page');
  assert.ok(bodies.analyze, 'analyze was called');
  assert.equal(bodies.analyze.content_type, 'product-page');
});

test('runAnalysis omits content_type when the content has none', async () => {
  const { bodies } = await runAndCapture('professional');
  assert.ok(bodies.analyze, 'analyze was called');
  assert.equal('content_type' in bodies.analyze, false);
});

// regenerate-outline is a SECOND live outline path (review finding #1) — it must
// also thread the preset, else Free users leak base-model COGS on regenerate.
async function runRegenerate(tier) {
  const saved = {
    findByNumber: Content.findByNumber, update: Content.findByIdAndUpdate,
    wsFind: Workspace.findById, tier: tierService.getOrgTierConfig, fetch: global.fetch,
  };
  let outlineBody = null;
  let outlineHeaders = null;
  Content.findByNumber = async () => ({
    _id: 'c1', workspaceId: 'w1', benchmark: { keywords: ['best seo tool'] },
    competitorPages: [], peopleAlsoAsk: [], relatedSearches: [],
    contentBrief: { structure: [], terms: [] }, aiConversations: [],
  });
  Content.findByIdAndUpdate = async () => ({});
  Workspace.findById = () => ({ select: () => ({ lean: async () => ({ organizationId: 'org1' }) }) });
  tierService.getOrgTierConfig = async () => ({ tier });
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('/recommend-outline')) {
      if (opts.body) outlineBody = JSON.parse(opts.body);
      outlineHeaders = opts.headers || {};
    }
    return { ok: true, status: 200, json: async () => ({ sections: [], h1: '' }), text: async () => '' };
  };
  const req = { params: { contentNumber: '1' }, workspace: { _id: 'w1' } };
  const res = { status: () => res, json: () => res };
  try { await analysisController.regenerateOutline(req, res); }
  finally {
    Content.findByNumber = saved.findByNumber; Content.findByIdAndUpdate = saved.update;
    Workspace.findById = saved.wsFind; tierService.getOrgTierConfig = saved.tier; global.fetch = saved.fetch;
  }
  return { outlineBody, outlineHeaders };
}

test('regenerateOutline(Free): recommend-outline carries body preset "budget"', async () => {
  const { outlineBody, outlineHeaders } = await runRegenerate('free');
  assert.ok(outlineBody, 'recommend-outline was called');
  assert.equal(outlineBody.preset, 'budget'); // the field the engine reads
  assert.equal(outlineHeaders['X-Model-Preset'], 'budget');
});

test('regenerateOutline(paid): no X-Model-Preset header (base models)', async () => {
  const { outlineBody, outlineHeaders } = await runRegenerate('professional');
  assert.ok(outlineBody, 'recommend-outline was called');
  assert.equal('X-Model-Preset' in outlineHeaders, false);
});
