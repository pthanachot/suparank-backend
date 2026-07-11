/**
 * Rec 10 — drift detection. Models + fetch monkey-patched; no DB/network.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const Content = require('../src/models/Content');
const Workspace = require('../src/models/Workspace');
const tierService = require('../src/services/tierService');
const {
  normalizeUrl, computeOverlap, checkContentDrift, runDriftSweep, DRIFT_OVERLAP_THRESHOLD,
} = require('../src/services/driftService');

const originals = {
  contentFind: Content.find,
  contentUpdateOne: Content.updateOne,
  wsFindById: Workspace.findById,
  tierCfg: tierService.getOrgTierConfig,
  fetch: global.fetch,
};
after(() => {
  Content.find = originals.contentFind;
  Content.updateOne = originals.contentUpdateOne;
  Workspace.findById = originals.wsFindById;
  tierService.getOrgTierConfig = originals.tierCfg;
  global.fetch = originals.fetch;
});

/* ── normalizeUrl: engine cluster.NormalizeURL parity ── */

describe('normalizeUrl — engine parity', () => {
  // EXACT input/expected pairs from engine cluster_test.go TestNormalizeURL —
  // this is a cross-language parity contract; do not edit one side alone.
  const engineParityTable = [
    ['https://example.com/page/', 'https://example.com/page'],
    ['https://example.com/page?utm_source=google&id=5', 'https://example.com/page?id=5'],
    ['https://example.com/?fbclid=abc', 'https://example.com/'],
    ['https://example.com/page#section', 'https://example.com/page'],
  ];
  it('matches every engine test case', () => {
    for (const [input, want] of engineParityTable) {
      assert.equal(normalizeUrl(input), want, `normalizeUrl(${input})`);
    }
  });
  it('strips all documented tracking params case-insensitively', () => {
    assert.equal(
      normalizeUrl('https://x.com/p?UTM_Campaign=a&REF=b&gclid=c&keep=1'),
      'https://x.com/p?keep=1',
    );
  });
  it('sorts surviving query params (Go Encode() parity)', () => {
    assert.equal(normalizeUrl('https://x.com/p?z=1&a=2'), 'https://x.com/p?a=2&z=1');
  });
  it('unparseable input returned unchanged', () => {
    assert.equal(normalizeUrl('not a url'), 'not a url');
  });

  // KNOWN, PINNED divergence from the Go implementation: the JS URL API always
  // canonicalizes a bare root to a trailing slash ("https://example.com" →
  // "https://example.com/"), while Go keeps it bare. This is harmless here —
  // BOTH sides of the overlap comparison go through this same function, so
  // homepage spellings match each other (Go would treat the two spellings as
  // distinct URLs). Do NOT "fix" this by string surgery: that would break the
  // homepage-spelling unification.
  it('bare root canonicalizes to trailing slash (pinned JS/Go divergence)', () => {
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
    assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
    // The two spellings therefore overlap — the property that matters.
    assert.equal(computeOverlap(['https://example.com'], ['https://example.com/']).overlap, 1);
  });
});

/* ── computeOverlap ── */

describe('computeOverlap', () => {
  it('identical sets → 1.0', () => {
    const urls = ['https://a.com/x', 'https://b.com/y'];
    const { overlap, newUrls } = computeOverlap(urls, [...urls]);
    assert.equal(overlap, 1);
    assert.deepEqual(newUrls, []);
  });

  it('disjoint sets → 0 with all fresh urls as new', () => {
    const { overlap, newUrls } = computeOverlap(['https://a.com/1'], ['https://b.com/2']);
    assert.equal(overlap, 0);
    assert.deepEqual(newUrls, ['https://b.com/2']);
  });

  it('known partial fixture: 2 shared of 4 total → 0.5', () => {
    const stored = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3'];
    const fresh = ['https://a.com/2', 'https://a.com/3', 'https://b.com/new'];
    const { overlap, newUrls } = computeOverlap(stored, fresh);
    assert.equal(overlap, 0.5); // intersection 2, union 4
    assert.deepEqual(newUrls, ['https://b.com/new']);
  });

  it('normalization applies before comparison (trailing slash / utm)', () => {
    const { overlap } = computeOverlap(
      ['https://a.com/page/'],
      ['https://a.com/page?utm_source=x'],
    );
    assert.equal(overlap, 1);
  });

  it('empty stored → overlap 1 (no drift on missing data)', () => {
    assert.equal(computeOverlap([], ['https://a.com']).overlap, 1);
    assert.equal(computeOverlap(['https://a.com'], []).overlap, 1);
  });
});

/* ── checkContentDrift ── */

describe('checkContentDrift', () => {
  const content = {
    _id: 'c1',
    targetKeywords: ['crm software'],
    competitors: [
      { url: 'https://a.com/1' }, { url: 'https://a.com/2' },
      { url: 'https://a.com/3' }, { url: 'https://a.com/4' },
    ],
  };

  it('drifted when fresh SERP mostly differs; sends skip_volumes + internal key', async () => {
    const prevKey = process.env.ENGINE_INTERNAL_KEY;
    process.env.ENGINE_INTERNAL_KEY = 'test-internal-key';
    let sentBody = null;
    let sentHeaders = null;
    global.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      sentHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          candidates: [
            { url: 'https://a.com/1' }, { url: 'https://new1.com' },
            { url: 'https://new2.com' }, { url: 'https://new3.com' },
          ],
        }),
      };
    };
    const r = await checkContentDrift(content);
    // Cost guard: the sweep must not bill DataForSEO volume enrichment.
    assert.equal(sentBody.skip_volumes, true);
    assert.deepEqual(sentBody.keywords, ['crm software']);
    // Auth guard: the engine gates /api/discover; without X-Internal-Key the
    // sweep 401s on every keyed deployment (regression guard for the fix).
    assert.equal(sentHeaders['X-Internal-Key'], 'test-internal-key');
    if (prevKey === undefined) delete process.env.ENGINE_INTERNAL_KEY;
    else process.env.ENGINE_INTERNAL_KEY = prevKey;
    // intersection 1, union 7 → ~0.14 < 0.6
    assert.equal(r.drifted, true);
    assert.ok(r.overlap < DRIFT_OVERLAP_THRESHOLD);
    assert.deepEqual(r.newCompetitors, ['https://new1.com/', 'https://new2.com/', 'https://new3.com/']);
  });

  it('not drifted when SERP is stable', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ candidates: content.competitors.map((c) => ({ url: c.url })) }),
    });
    const r = await checkContentDrift(content);
    assert.equal(r.drifted, false);
    assert.equal(r.overlap, 1);
  });

  it('engine 502 → throws (sweep counts it; nothing flagged)', async () => {
    global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    await assert.rejects(() => checkContentDrift(content), /502/);
  });

  it('no stored competitors or keywords → no drift, no fetch', async () => {
    let fetched = false;
    global.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
    assert.equal((await checkContentDrift({ targetKeywords: [], competitors: content.competitors })).drifted, false);
    assert.equal((await checkContentDrift({ targetKeywords: ['k'], competitors: [] })).drifted, false);
    assert.equal(fetched, false);
  });

  it('empty fresh SERP → data problem, not drift', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [] }) });
    const r = await checkContentDrift(content);
    assert.equal(r.drifted, false);
  });
});

/* ── runDriftSweep ── */

describe('runDriftSweep', () => {
  let capturedFilter; let capturedLimit; let sweepDocs; let updates;

  beforeEach(() => {
    capturedFilter = null;
    capturedLimit = null;
    updates = [];
    sweepDocs = [
      { _id: 'paid1', workspaceId: 'wsPaid', targetKeywords: ['k'], competitors: [{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }] },
      { _id: 'free1', workspaceId: 'wsFree', targetKeywords: ['k'], competitors: [{ url: 'https://a.com/1' }] },
    ];
    Content.find = (filter) => {
      capturedFilter = filter;
      return {
        sort: () => ({
          limit: (n) => { capturedLimit = n; return { select: () => Promise.resolve(sweepDocs) }; },
        }),
      };
    };
    Content.updateOne = async (filter, update) => { updates.push({ filter, update }); return {}; };
    Workspace.findById = () => ({
      select: () => ({
        lean: async () => ({ organizationId: 'org1' }),
      }),
    });
    tierService.getOrgTierConfig = async () => ({ tier: 'pro', config: {} });
    // Fresh SERP totally different → drift for every checked doc.
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ candidates: [{ url: 'https://x.com/1' }, { url: 'https://x.com/2' }, { url: 'https://x.com/3' }] }),
    });
  });

  it('selection query matches the eligibility contract', async () => {
    await runDriftSweep({ batchSize: 7 });
    assert.equal(capturedFilter.analysisStatus, 'ready');
    assert.ok(capturedFilter.analyzedAt.$lt instanceof Date, 'age cutoff');
    assert.equal(capturedFilter.driftDetected, null);
    assert.ok(capturedFilter.updatedAt.$gte instanceof Date, 'abandoned-doc cutoff');
    assert.equal(capturedLimit, 7, 'batch cap respected');
    // 21-day analysis age and 90-day activity window.
    const ageDays = (Date.now() - capturedFilter.analyzedAt.$lt.getTime()) / 86400000;
    const idleDays = (Date.now() - capturedFilter.updatedAt.$gte.getTime()) / 86400000;
    assert.ok(Math.abs(ageDays - 21) < 0.1, `age cutoff ~21d, got ${ageDays}`);
    assert.ok(Math.abs(idleDays - 90) < 0.1, `idle cutoff ~90d, got ${idleDays}`);
  });

  it('flags drifted docs with at/overlap/newCompetitors', async () => {
    const r = await runDriftSweep({});
    assert.equal(r.flagged, 2);
    const flag = updates[0].update.$set.driftDetected;
    assert.ok(flag.at instanceof Date);
    assert.equal(typeof flag.overlap, 'number');
    assert.ok(Array.isArray(flag.newCompetitors) && flag.newCompetitors.length > 0);
  });

  it('skips free-tier orgs (cost gate)', async () => {
    tierService.getOrgTierConfig = async () => ({ tier: 'free', config: {} });
    const r = await runDriftSweep({});
    assert.equal(r.checked, 0);
    assert.equal(r.flagged, 0);
    assert.equal(updates.length, 0);
  });

  it('engine failure → error counted, nothing flagged, no throw', async () => {
    global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    const r = await runDriftSweep({});
    assert.equal(r.errors, 2);
    assert.equal(r.flagged, 0);
    assert.equal(updates.length, 0);
  });

  it('stable SERP → checked but not flagged', async () => {
    // Both docs store exactly the URLs the fresh SERP returns → overlap 1.
    sweepDocs = sweepDocs.map((d) => ({
      ...d,
      competitors: [{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }],
    }));
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ candidates: [{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }] }),
    });
    const r = await runDriftSweep({});
    assert.equal(r.checked, 2);
    assert.equal(r.flagged, 0);
  });
});
