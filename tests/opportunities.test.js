/**
 * Rec 15 — GSC Opportunities. Models/services monkey-patched; no DB/network.
 * Covers: relevance split, agent-goal phrasing, connection states, the striking
 * lifecycle (dismissed filtered, applied→recovered), and apply/dismiss flow.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Site = require('../src/models/Site');
const GscConnection = require('../src/models/GscConnection');
const Content = require('../src/models/Content');
const Opportunity = require('../src/models/Opportunity');
const gscService = require('../src/services/gscService');
const tierService = require('../src/services/tierService');
const aiController = require('../src/controllers/aiController');
const opp = require('../src/controllers/opportunitiesController');

const { isRelevant, relevantStems, buildAgentGoal } = opp._internals;

const real = {};
for (const [obj, keys] of [
  [Site, ['findOne']],
  [GscConnection, ['findOne']],
  [Content, ['findByNumber', 'findById', 'find']],
  [Opportunity, ['findOne', 'findOneAndUpdate', 'find', 'updateOne']],
  [gscService, ['getStrikingDistance', 'getDecliningPages', 'getKeywordPosition']],
  [tierService, ['getOrgTierConfig']],
  [aiController, ['resyncBriefIfActive']],
]) {
  for (const k of keys) real[`${obj.modelName || 'x'}.${k}.${Math.random()}`] = null; // placeholder to avoid lints
}
const originals = {
  SiteFindOne: Site.findOne,
  GscFindOne: GscConnection.findOne,
  CFindByNumber: Content.findByNumber,
  CFindById: Content.findById,
  CFind: Content.find,
  OFindOne: Opportunity.findOne,
  OFindOneAndUpdate: Opportunity.findOneAndUpdate,
  OFind: Opportunity.find,
  OUpdateOne: Opportunity.updateOne,
  gsStriking: gscService.getStrikingDistance,
  gsDeclining: gscService.getDecliningPages,
  gsKwPos: gscService.getKeywordPosition,
  tierCfg: tierService.getOrgTierConfig,
  resync: aiController.resyncBriefIfActive,
};
after(() => {
  Site.findOne = originals.SiteFindOne;
  GscConnection.findOne = originals.GscFindOne;
  Content.findByNumber = originals.CFindByNumber;
  Content.findById = originals.CFindById;
  Content.find = originals.CFind;
  Opportunity.findOne = originals.OFindOne;
  Opportunity.findOneAndUpdate = originals.OFindOneAndUpdate;
  Opportunity.find = originals.OFind;
  Opportunity.updateOne = originals.OUpdateOne;
  gscService.getStrikingDistance = originals.gsStriking;
  gscService.getDecliningPages = originals.gsDeclining;
  gscService.getKeywordPosition = originals.gsKwPos;
  tierService.getOrgTierConfig = originals.tierCfg;
  aiController.resyncBriefIfActive = originals.resync;
});

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function keywordStemsFor(keywords) {
  const set = new Set();
  for (const kw of keywords) for (const s of relevantStems(kw)) set.add(s);
  return set;
}

// ── pure: relevance split ──
describe('opportunities — relevance split', () => {
  const stems = keywordStemsFor(['crm software']);
  it('a query sharing a content stem is relevant', () => {
    assert.equal(isRelevant('best crm software', stems), true); // "best" is a stopword; shares crm/softwar
    assert.equal(isRelevant('crm pricing', stems), true);       // shares crm (stemmed)
  });
  it('an unrelated query is not relevant', () => {
    assert.equal(isRelevant('email marketing tips', stems), false);
  });
  it('stopword-only overlap does NOT qualify', () => {
    const s = keywordStemsFor(['best crm']); // {crm} — "best" dropped
    assert.equal(isRelevant('best email', s), false); // only shared word "best" is a stopword
  });
});

// ── pure: agent goal ──
describe('opportunities — agent goal', () => {
  it('striking goal names the query + position + impressions', () => {
    const g = buildAgentGoal({ source: 'gsc_striking', query: 'best crm', metrics: { position: 12, impressions: 400 } });
    assert.match(g, /best crm/);
    assert.match(g, /position 12/);
    assert.match(g, /400 impressions/);
  });
  it('decay goal uses the refresh/recover framing', () => {
    const g = buildAgentGoal({ source: 'gsc_decay', query: 'crm guide', metrics: {} });
    assert.match(g, /crm guide/);
    assert.match(g, /recover/i);
  });
  it('decay goal falls back to topQuery when identity query is empty', () => {
    const g = buildAgentGoal({ source: 'gsc_decay', query: '', topQuery: 'crm pricing', metrics: {} });
    assert.match(g, /crm pricing/);
    assert.match(g, /recover/i);
  });
  it('decay goal degrades gracefully when no keyword is known (no empty quotes)', () => {
    const g = buildAgentGoal({ source: 'gsc_decay', query: '', topQuery: '', metrics: {} });
    assert.doesNotMatch(g, /""/);
    assert.match(g, /core sections/);
  });
});

// ── connection states ──
describe('opportunities — connection states', () => {
  beforeEach(() => {
    Content.find = () => ({ select: () => ({ lean: async () => [] }) });
  });
  it('no GSC connection → {connected:false}', async () => {
    GscConnection.findOne = async () => null;
    const r = res();
    await opp.getWorkspaceOpportunities({ workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.deepEqual(r.body, { connected: false });
  });
  it('connected but no matching site → {connected:true, propertyMatched:false}', async () => {
    GscConnection.findOne = async () => ({ refreshToken: 'tok' });
    Site.findOne = () => ({ lean: async () => null });
    const r = res();
    await opp.getWorkspaceOpportunities({ workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.deepEqual(r.body, { connected: true, propertyMatched: false });
  });
});

// ── lifecycle via content-scoped fetch ──
describe('opportunities — striking lifecycle', () => {
  beforeEach(() => {
    GscConnection.findOne = async () => ({ refreshToken: 'tok' });
    Site.findOne = () => ({ lean: async () => ({ gscPropertyId: 'sc-domain:x' }) });
    tierService.getOrgTierConfig = async () => ({ tier: 'standard', config: {} });
    Content.findByNumber = async () => ({ _id: 'c1', contentNumber: 5, targetKeywords: ['crm software'], publishedUrl: '' });
    Opportunity.find = () => ({ lean: async () => [] }); // no applied rows by default
    Opportunity.updateOne = async () => ({});
    // upsert returns an open row unless the query is the dismissed one.
    Opportunity.findOneAndUpdate = () => ({
      lean: async function () {
        const query = this._q;
        return { _id: `o-${query}`, status: query === 'dismissed q' ? 'dismissed' : 'open', query };
      },
    });
    gscService.getStrikingDistance = async () => ({
      rows: [
        { keyword: 'best crm software', page: 'p1', position: 12, impressions: 400, clicks: 1, opportunity: 300, potentialClicks: 5 },
        { keyword: 'email marketing tips', page: 'p2', position: 15, impressions: 200, clicks: 0, opportunity: 120, potentialClicks: 4 },
        { keyword: 'dismissed q', page: 'p3', position: 18, impressions: 100, clicks: 0, opportunity: 40, potentialClicks: 2 },
      ],
      truncated: false,
    });
  });

  it('splits relevant vs site-wide and filters dismissed rows', async () => {
    // Make the upsert echo the query it was called with.
    Opportunity.findOneAndUpdate = (filter) => ({
      lean: async () => ({ _id: `o-${filter.query}`, status: filter.query === 'dismissed q' ? 'dismissed' : 'open', query: filter.query }),
    });
    const r = res();
    await opp.getContentOpportunities({ params: { contentNumber: 5 }, workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.equal(r.body.connected, true);
    assert.deepEqual(r.body.contentOpportunities.map((o) => o.keyword), ['best crm software']);
    assert.deepEqual(r.body.siteOpportunities.map((o) => o.keyword), ['email marketing tips']);
    const all = [...r.body.contentOpportunities, ...r.body.siteOpportunities].map((o) => o.keyword);
    assert.ok(!all.includes('dismissed q'), 'dismissed rows never resurface');
    assert.equal(typeof r.body.applyCreditCost, 'number');
  });

  it('applied row flips to recovered when position ≤ 10', async () => {
    Opportunity.find = () => ({ lean: async () => [{ _id: 'oa', query: 'best crm software', status: 'applied' }] });
    gscService.getKeywordPosition = async () => 8; // recovered
    let recoveredWith = null;
    Opportunity.updateOne = async (filter, update) => { recoveredWith = update; return {}; };
    Opportunity.findOneAndUpdate = (filter) => ({ lean: async () => ({ _id: 'x', status: 'open', query: filter.query }) });
    const r = res();
    await opp.getContentOpportunities({ params: { contentNumber: 5 }, workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.equal(recoveredWith?.$set?.status, 'recovered');
    assert.ok(recoveredWith?.$set?.recoveredAt instanceof Date);
  });

  it('applied row NOT recovered at position 10.5', async () => {
    Opportunity.find = () => ({ lean: async () => [{ _id: 'oa', query: 'best crm software', status: 'applied' }] });
    gscService.getKeywordPosition = async () => 10.5;
    let called = false;
    Opportunity.updateOne = async () => { called = true; return {}; };
    Opportunity.findOneAndUpdate = (filter) => ({ lean: async () => ({ _id: 'x', status: 'open', query: filter.query }) });
    const r = res();
    await opp.getContentOpportunities({ params: { contentNumber: 5 }, workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.equal(called, false, 'position 10.5 is still striking distance, not recovered');
  });
});

// ── apply / dismiss ──
describe('opportunities — apply/dismiss', () => {
  let oppDoc; let content; let resyncCalls;
  beforeEach(() => {
    resyncCalls = [];
    oppDoc = {
      _id: 'o1', workspaceId: 'ws1', source: 'gsc_striking', query: 'best crm',
      status: 'open', metrics: { position: 12, impressions: 400 }, contentId: null, appliedAt: null,
      async save() { /* in-place */ }, toObject() { return { ...this }; },
    };
    content = { _id: 'c1', contentNumber: 5, appliedGscQueries: [], async save() {} };
    Opportunity.findOne = async () => oppDoc;
    Content.findByNumber = async () => content;
    aiController.resyncBriefIfActive = async (id) => { resyncCalls.push(id); return true; };
  });

  it('apply marks applied, appends query once (idempotent), resyncs, returns goal', async () => {
    const req = { params: { id: 'o1' }, workspace: { _id: 'ws1' }, body: { contentNumber: 5 } };
    const r1 = res();
    await opp.applyOpportunity(req, r1);
    assert.equal(r1.body.opportunity.status, 'applied');
    assert.ok(r1.body.opportunity.appliedAt);
    assert.deepEqual(content.appliedGscQueries, ['best crm']);
    assert.equal(resyncCalls.length, 1);
    assert.match(r1.body.agentGoal, /best crm/);

    // Second apply — query already present → appended once.
    const r2 = res();
    await opp.applyOpportunity(req, r2);
    assert.deepEqual(content.appliedGscQueries, ['best crm']);
  });

  it('apply 404s when the opportunity is missing', async () => {
    Opportunity.findOne = async () => null;
    const r = res();
    await opp.applyOpportunity({ params: { id: 'zzz' }, workspace: { _id: 'ws1' }, body: {} }, r);
    assert.equal(r.statusCode, 404);
  });

  it('apply 400s when no target content resolves', async () => {
    Content.findByNumber = async () => null;
    oppDoc.contentId = null;
    const r = res();
    await opp.applyOpportunity({ params: { id: 'o1' }, workspace: { _id: 'ws1' }, body: { contentNumber: 99 } }, r);
    assert.equal(r.statusCode, 400);
  });

  it('dismiss sets status + timestamp', async () => {
    Opportunity.findOneAndUpdate = async (filter, update) => ({ toObject() { return { _id: 'o1', status: update.$set.status, dismissedAt: update.$set.dismissedAt }; } });
    const r = res();
    await opp.dismissOpportunity({ params: { id: 'o1' }, workspace: { _id: 'ws1' } }, r);
    assert.equal(r.body.opportunity.status, 'dismissed');
    assert.ok(r.body.opportunity.dismissedAt instanceof Date);
  });
});

// ── fix #1: decay identity is the page, not the (drifting) top query ──
describe('opportunities — decay identity is page-based', () => {
  let capturedDecay;
  beforeEach(() => {
    capturedDecay = null;
    GscConnection.findOne = async () => ({ refreshToken: 'tok' });
    Site.findOne = () => ({ lean: async () => ({ gscPropertyId: 'sc-domain:x' }) });
    tierService.getOrgTierConfig = async () => ({ tier: 'standard', config: {} });
    Content.find = () => ({ select: () => ({ lean: async () => [{ _id: 'c1', contentNumber: 5, publishedUrl: 'https://x.com/blog/a' }] }) });
    Opportunity.find = () => ({ lean: async () => [] });
    gscService.getStrikingDistance = async () => ({ rows: [], truncated: false });
    gscService.getDecliningPages = async () => ({ pages: [{ page: 'https://x.com/blog/a/', topKeyword: 'crm guide', clicks7: 3, impressions: 50, delta: -40 }] });
    Opportunity.findOneAndUpdate = (filter, update) => {
      if (filter.source === 'gsc_decay') capturedDecay = { filter, update };
      return { lean: async () => ({ _id: 'o1', status: 'open' }) };
    };
  });

  it('keys on the normalized page with query empty, storing the drifting keyword as topQuery', async () => {
    const r = res();
    await opp.getWorkspaceOpportunities({ workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.ok(capturedDecay, 'a decay opportunity was upserted');
    assert.equal(capturedDecay.filter.query, '', 'query is NOT part of decay identity');
    assert.equal(capturedDecay.filter.page, 'https://x.com/blog/a', 'trailing slash normalized away');
    assert.equal(capturedDecay.update.$set.topQuery, 'crm guide', 'top query stored for display/goal');
    assert.equal(String(capturedDecay.update.$set.contentId), 'c1');
  });
});

// ── fix #2: concurrent upsert retries on a duplicate-key error ──
describe('opportunities — upsert retries on E11000', () => {
  beforeEach(() => {
    GscConnection.findOne = async () => ({ refreshToken: 'tok' });
    Site.findOne = () => ({ lean: async () => ({ gscPropertyId: 'sc-domain:x' }) });
    tierService.getOrgTierConfig = async () => ({ tier: 'standard', config: {} });
    Content.findByNumber = async () => ({ _id: 'c1', contentNumber: 5, targetKeywords: ['crm software'], publishedUrl: '' });
    Opportunity.find = () => ({ lean: async () => [] });
    gscService.getStrikingDistance = async () => ({ rows: [{ keyword: 'best crm software', page: 'p', position: 12, impressions: 400, clicks: 1, opportunity: 300, potentialClicks: 5 }], truncated: false });
  });

  it('retries as an update after a concurrent insert hits the unique index', async () => {
    let calls = 0;
    Opportunity.findOneAndUpdate = () => ({
      lean: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(Object.assign(new Error('dup key'), { code: 11000 }));
        return Promise.resolve({ _id: 'o1', status: 'open' });
      },
    });
    const r = res();
    await opp.getContentOpportunities({ params: { contentNumber: 5 }, workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.equal(r.body.connected, true, 'request succeeds despite the race');
    assert.equal(calls, 2, 'retried exactly once after E11000');
    assert.equal(r.body.contentOpportunities.length, 1);
  });
});

// ── fix #8: content view does not leak site-wide unmapped declining pages ──
describe('opportunities — content view omits site-wide unmapped decline', () => {
  beforeEach(() => {
    GscConnection.findOne = async () => ({ refreshToken: 'tok' });
    Site.findOne = () => ({ lean: async () => ({ gscPropertyId: 'sc-domain:x' }) });
    tierService.getOrgTierConfig = async () => ({ tier: 'standard', config: {} });
    Content.findByNumber = async () => ({ _id: 'c1', contentNumber: 5, targetKeywords: ['crm software'], publishedUrl: 'https://x.com/blog/a' });
    Opportunity.find = () => ({ lean: async () => [] });
    Opportunity.findOneAndUpdate = (filter) => ({ lean: async () => ({ _id: `o-${filter.page || filter.query}`, status: 'open' }) });
    gscService.getStrikingDistance = async () => ({ rows: [], truncated: false });
    // A declining page that is NOT this article.
    gscService.getDecliningPages = async () => ({ pages: [{ page: 'https://x.com/other', topKeyword: 'z', clicks7: 1, impressions: 10, delta: -50 }] });
  });

  it('returns no unmappedDecliningPages and no matched decay for this article', async () => {
    const r = res();
    await opp.getContentOpportunities({ params: { contentNumber: 5 }, workspace: { _id: 'ws1', organizationId: 'org1' } }, r);
    assert.equal(r.body.unmappedDecliningPages, undefined, 'other pages\' decline is not leaked into the article panel');
    assert.deepEqual(r.body.decayOpportunities, []);
  });
});
