/**
 * E2E seeding CLI (test plan Phase 7) — invoked by the Playwright suite
 * against the HERMETIC memory-replset DB its global-setup spawned. Never
 * point this at a real database: modes mutate credits and trackers freely.
 *
 * Usage: MONGODB_URI=<uri> node scripts/e2eSeed.js <mode>
 * Modes:
 *   base        user(verified)+org+subscription(standard)+workspace+500 credits
 *   matrix      AI-Tracker monitor + 5 prompts + injected ready scan (P1-P5
 *               data matrix ported from the lost 28-* regression suite)
 *   aux         second workspace with a reselection tracker (defaultModels=[])
 *   drain       set org credit pools to zero (insufficient-credit UX)
 *   restore     re-grant 500 general credits
 *
 * Prints a single JSON line with created ids; idempotent per mode (upserts
 * by the fixed e2e email/workspace numbers).
 */

const mongoose = require('mongoose');

const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const Workspace = require('../src/models/Workspace');
const Subscription = require('../src/models/Subscription');
const Credit = require('../src/models/Credit');
const AiTracker = require('../src/models/AiTracker');
const AiTrackerPrompt = require('../src/models/AiTrackerPrompt');
const AiTrackerScan = require('../src/models/AiTrackerScan');
const creditService = require('../src/services/creditService');

const E2E_EMAIL = 'e2e-tracker@suparank.test';
const E2E_PASSWORD = 'E2ePassword!234';
const WS_MAIN = 971001;
const WS_AUX = 971002;

const DAY = 24 * 60 * 60 * 1000;

function platformResult(platformId, { mentioned = false, cited = false, position = null, error = false, sentiment = null } = {}) {
  const citedUrls = cited
    ? [`https://suparank.com/e2e-${platformId}`, 'https://ahrefs.com/blog']
    : (mentioned ? ['https://ahrefs.com/blog'] : []);
  return {
    platformId,
    mentioned,
    position,
    cited,
    citationCount: citedUrls.length,
    citedUrls,
    brandRanking: mentioned
      ? [
          { brandName: 'SupaRank', isTargetBrand: true, mentionCount: 2 },
          { brandName: 'Ahrefs', isTargetBrand: false, mentionCount: 1 },
          { brandName: 'Semrush', isTargetBrand: false, mentionCount: 1 },
        ]
      : (error ? [] : [{ brandName: 'Ahrefs', isTargetBrand: false, mentionCount: 1 }]),
    aiResponse: error
      ? ''
      : `E2E fixture answer for ${platformId}. SupaRank is ${mentioned ? 'a leading choice' : 'not covered here'} [suparank.com](https://suparank.com/e2e-${platformId}). Ahrefs also appears [ahrefs.com](https://ahrefs.com/blog).`,
    sentiment: mentioned ? (sentiment || 'positive') : null,
    sentimentScore: mentioned ? 78 : null,
    error,
    fanoutQueries: mentioned ? [`best ai seo ${platformId}`] : [],
  };
}

async function ensureBase() {
  let user = await User.findOne({ email: E2E_EMAIL });
  if (!user) {
    user = await User.create({
      userId: 971_000_001, // numeric public id, normally minted by signup
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
      name: 'E2E Tracker',
      verified: true,
      // else every dashboard route redirects to the product wizard
      onboarding: { completed: true, completedAt: new Date() },
    });
  } else if (!user.onboarding?.completed) {
    await User.updateOne(
      { _id: user._id },
      { $set: { 'onboarding.completed': true, 'onboarding.completedAt': new Date() } },
    );
  }
  let org = await Organization.findOne({ slug: 'e2e-tracker-org' });
  if (!org) {
    org = await Organization.create({ name: 'E2E Tracker Org', slug: 'e2e-tracker-org', ownerId: user._id });
  }
  if (!(await Subscription.findOne({ organizationId: org._id }))) {
    await Subscription.create({ organizationId: org._id, planId: 'standard-monthly', status: 'active', userId: user._id });
  }
  let ws = await Workspace.findOne({ workspaceNumber: WS_MAIN });
  if (!ws) {
    ws = await Workspace.create({
      workspaceNumber: WS_MAIN, userId: user._id, organizationId: org._id, name: 'E2E Tracker WS',
    });
  }
  const { total } = await creditService.getBalance(org._id.toString());
  if (total < 500) {
    await creditService.grantGeneralCredits(org._id.toString(), 500 - total, 'e2e seed');
  }
  return { user, org, ws };
}

async function main() {
  const mode = process.argv[2] || 'base';
  // HARD GUARD: this script mutates trackers/credits destructively. The E2E
  // harness sets E2E_SEED=1; a bare manual run against ANY database refuses.
  if (process.env.E2E_SEED !== '1') {
    console.error('[e2eSeed] refusing to run: set E2E_SEED=1 (only the e2e harness should ever do this)');
    process.exit(2);
  }
  // Mirror src/config/database.js — the backend reads dbName 'suparank';
  // a bare connect would land in 'test' and the app would never see the seed.
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'suparank' });

  const { user, org, ws } = await ensureBase();
  const out = {
    mode,
    email: E2E_EMAIL,
    password: E2E_PASSWORD,
    workspaceNumber: WS_MAIN,
    auxWorkspaceNumber: WS_AUX,
    orgId: org._id.toString(),
    userId: user._id.toString(),
  };

  if (mode === 'matrix') {
    // Scope ALL deletes to this workspace's trackers — an unscoped
    // deleteMany({}) here would wipe every tenant's scans/prompts if the
    // script were ever pointed at a shared database (review fix).
    const wsTrackerIds = (await AiTracker.find({ workspaceId: ws._id }).select('_id').lean()).map((t) => t._id);
    await AiTrackerScan.deleteMany({ trackerId: { $in: wsTrackerIds } });
    await AiTrackerPrompt.deleteMany({ trackerId: { $in: wsTrackerIds } });
    await AiTracker.deleteMany({ workspaceId: ws._id });

    const tracker = await AiTracker.create({
      workspaceId: ws._id,
      name: 'E2E Monitor',
      domain: 'suparank.com',
      defaultModels: ['chatgpt', 'gemini', 'claude', 'perplexity'],
      scanStatus: 'ready',
      scanProgress: 100,
      lastScanAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      nextScanAt: new Date(Date.now() + 5 * DAY),
      platformStatuses: ['chatgpt', 'gemini', 'claude', 'perplexity'].map((p) => ({ platformId: p, status: 'completed' })),
    });

    const promptSpecs = [
      { prompt: 'best ai seo tools 2026' }, // P1 high
      { prompt: 'suparank alternatives' }, // P2 low
      { prompt: 'how to rank in ai overviews' }, // P3 zero
      { prompt: 'ai visibility tracking software' }, // P4 error row
      { prompt: 'content optimization for llms' }, // P5 medium
    ];
    const prompts = [];
    for (const spec of promptSpecs) {
      prompts.push(await AiTrackerPrompt.create({
        trackerId: tracker._id, prompt: spec.prompt, models: ['chatgpt', 'gemini', 'claude', 'perplexity'],
        frequency: 'Weekly', active: true, lastScannedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      }));
    }

    // The ported fake-scan data matrix (P1 high / P2 low / P3 zero / P4 error / P5 medium).
    const rows = [
      [
        platformResult('chatgpt', { mentioned: true, cited: true, position: 1 }),
        platformResult('gemini', { mentioned: true, position: 3 }),
        platformResult('claude', {}),
        platformResult('perplexity', { mentioned: true, cited: true, position: 2 }),
      ],
      [
        platformResult('chatgpt', { mentioned: true, position: 8, sentiment: 'neutral' }),
        platformResult('gemini', {}),
        platformResult('claude', {}),
        platformResult('perplexity', {}),
      ],
      [
        platformResult('chatgpt', {}),
        platformResult('gemini', {}),
        platformResult('claude', {}),
        platformResult('perplexity', {}),
      ],
      [
        platformResult('chatgpt', { mentioned: true, cited: true, position: 2 }),
        platformResult('gemini', { mentioned: true, position: 4 }),
        platformResult('claude', { mentioned: true, position: 5 }),
        platformResult('perplexity', { error: true }),
      ],
      [
        platformResult('chatgpt', {}),
        platformResult('gemini', { mentioned: true, position: 4 }),
        platformResult('claude', {}),
        platformResult('perplexity', { mentioned: true, cited: true, position: 3 }),
      ],
    ];

    // Mirror executeScan's write path exactly: create bare, then set results
    // via findByIdAndUpdate (B10). Update-path writes skip validators, which
    // is how production stores competitorId:null for auto-detected rows —
    // create() would reject them (schema marks the path required).
    const scan = await AiTrackerScan.create({
      trackerId: tracker._id,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000),
    });
    await AiTrackerScan.findByIdAndUpdate(scan._id, {
      $set: {
        status: 'ready',
        completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        results: prompts.map((p, i) => ({ promptId: p._id, prompt: p.prompt, platforms: rows[i] })),
        competitorResults: [
          { competitorId: null, name: 'suparank', isOwn: true, mentions: 8, citations: 4, visibility: 40 },
          { competitorId: null, name: 'Ahrefs', isOwn: false, mentions: 6, citations: 2, visibility: 30 },
          { competitorId: null, name: 'Semrush', isOwn: false, mentions: 4, citations: 1, visibility: 20 },
        ],
        detectedBrands: [
          { name: 'Ahrefs', mentionCount: 6 },
          { name: 'Semrush', mentionCount: 4 },
        ],
      },
    });
    await AiTracker.findByIdAndUpdate(tracker._id, { $set: { currentScanId: null } });

    out.trackerId = tracker._id.toString();
    out.scanId = scan._id.toString();
    out.promptIds = prompts.map((p) => p._id.toString());
  }

  if (mode === 'aux') {
    let aux = await Workspace.findOne({ workspaceNumber: WS_AUX });
    if (!aux) {
      aux = await Workspace.create({
        workspaceNumber: WS_AUX, userId: user._id, organizationId: org._id, name: 'E2E Reselection WS',
      });
    }
    const auxTrackerIds = (await AiTracker.find({ workspaceId: aux._id }).select('_id').lean()).map((t) => t._id);
    await AiTrackerScan.deleteMany({ trackerId: { $in: auxTrackerIds } });
    await AiTrackerPrompt.deleteMany({ trackerId: { $in: auxTrackerIds } });
    await AiTracker.deleteMany({ workspaceId: aux._id });
    const resel = await AiTracker.create({
      workspaceId: aux._id,
      name: 'E2E Reselection Monitor',
      domain: 'reselect.suparank.com',
      defaultModels: [], // triggers the platform-reselection recovery view
      scanStatus: 'ready',
      scanProgress: 100,
      lastScanAt: new Date(Date.now() - 3 * DAY),
    });
    await AiTrackerPrompt.create({
      trackerId: resel._id, prompt: 'reselection seed prompt', models: ['chatgpt'], frequency: 'Weekly', active: true,
    });
    out.reselectionTrackerId = resel._id.toString();
  }

  if (mode === 'drain') {
    await Credit.updateOne(
      { organizationId: org._id },
      { $set: { subscriptionCredits: 0, generalCredits: 0 } },
    );
    out.balance = (await creditService.getBalance(org._id.toString())).total;
  }

  if (mode === 'restore') {
    await creditService.grantGeneralCredits(org._id.toString(), 500, 'e2e restore');
    out.balance = (await creditService.getBalance(org._id.toString())).total;
  }

  // Sites + Sitemap fixtures for the frontend E2E (Phase 5, §8). Seeds a
  // connected GSC Site plus a completed sitemap crawl with a few pages, and
  // enables the `sites`/`sitemap` feature flags so the routes/nav are live.
  if (mode === 'sites') {
    const FeatureFlag = require('../src/models/FeatureFlag');
    const Site = require('../src/models/Site');
    const Sitemap = require('../src/models/Sitemap');
    const CrawlPage = require('../src/models/CrawlPage');

    for (const [key, displayName] of [['sites', 'Sites'], ['sitemap', 'Sitemap']]) {
      await FeatureFlag.updateOne(
        { key },
        { $set: { key, displayName, enabled: true, implemented: true } },
        { upsert: true },
      );
    }

    // Idempotent: clear this workspace's prior site/sitemap fixtures first.
    const priorSitemapIds = (await Sitemap.find({ workspaceId: ws._id }).select('_id').lean()).map((s) => s._id);
    await CrawlPage.deleteMany({ sitemapId: { $in: priorSitemapIds } });
    await Sitemap.deleteMany({ workspaceId: ws._id });
    await Site.deleteMany({ workspaceId: ws._id });

    const site = await Site.create({
      organizationId: org._id,
      workspaceId: ws._id,
      url: 'https://e2e-demo.suparank.test',
      label: 'E2E Demo Site',
      gscPropertyId: 'sc-domain:e2e-demo.suparank.test',
      gscPropertyType: 'DOMAIN',
      verified: true,
      syncStatus: 'idle',
      lastSyncAt: new Date(),
      snapshotStats: {
        clicks: 1234, impressions: 56000, ctr: 2.2, position: 12.4,
        clicksTrend: [10, 20, 15, 30, 25, 40], trendDirection: 'up',
        pagesCount: 3, keywordsCount: 42, updatedAt: new Date(),
      },
      locked: false,
    });

    const sitemap = await Sitemap.create({
      organizationId: org._id,
      workspaceId: ws._id,
      url: 'https://e2e-demo.suparank.test',
      label: 'E2E Demo Sitemap',
      crawlStatus: 'completed',
      crawlProgress: 100,
      crawlCompletedAt: new Date(),
      lastCrawlAt: new Date(),
      crawlStats: { totalFound: 3, newUrls: 3, removedUrls: 0, unchanged: 0, errors: 0, truncated: false },
    });
    await CrawlPage.create([
      { sitemapId: sitemap._id, url: 'https://e2e-demo.suparank.test/', title: 'Home', statusCode: 200, depth: 0, diffStatus: 'new', priority: 1.0, changefreq: 'weekly', lastmod: '2026-08-01' },
      { sitemapId: sitemap._id, url: 'https://e2e-demo.suparank.test/pricing', title: 'Pricing', statusCode: 200, depth: 1, diffStatus: 'new', priority: 0.5, changefreq: 'weekly', lastmod: '2026-08-01' },
      { sitemapId: sitemap._id, url: 'https://e2e-demo.suparank.test/blog', title: 'Blog', statusCode: 200, depth: 1, diffStatus: 'new', priority: 0.5, changefreq: 'weekly', lastmod: '2026-08-01' },
    ]);

    out.siteId = site._id.toString();
    out.sitemapId = sitemap._id.toString();
    out.siteUrl = site.url;
  }

  // Phase C2 — Keyword Research fixtures. Seeds the GLOBAL keyword cache plus
  // this workspace's history so the UI can be driven with zero vendor calls:
  // a history replay hits /keywords/cached, which reads the cache directly.
  // Row shapes deliberately span what the table must render: high volume, zero
  // volume, a question, a UK-country row, and a downgrade-LOCKED history entry.
  if (mode === 'keywords') {
    const FeatureFlag = require('../src/models/FeatureFlag');
    const KeywordSearch = require('../src/models/KeywordSearch');
    const KeywordDetail = require('../src/models/KeywordDetail');
    const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');

    await FeatureFlag.updateOne(
      { key: 'keywords' },
      { $set: { key: 'keywords', displayName: 'Keyword Research', enabled: true, implemented: true } },
      { upsert: true },
    );

    await KeywordResearchHistory.deleteMany({ workspaceId: ws._id });
    await KeywordSearch.deleteMany({ seedKeyword: { $in: ['e2e seed keyword', 'e2e locked keyword', 'e2e uk keyword'] } });
    await KeywordDetail.deleteMany({ keyword: 'e2e high volume term' });

    const row = (keyword, over = {}) => ({
      keyword,
      searchVolume: over.searchVolume ?? 1000,
      keywordDifficulty: over.keywordDifficulty ?? 30,
      cpc: over.cpc ?? 1.25,
      competition: over.competition ?? 0.4,
      searchIntent: over.searchIntent ?? 'informational',
      isQuestion: over.isQuestion ?? false,
      monthlySearches: over.monthlySearches ?? [800, 900, 1000, 1100, 1200, 1000],
      serpFeatures: over.serpFeatures ?? ['organic'],
    });

    const relatedKeywords = [
      row('e2e high volume term', { searchVolume: 90500, keywordDifficulty: 78, cpc: 12.5, searchIntent: 'commercial' }),
      row('e2e zero volume term', { searchVolume: 0, keywordDifficulty: 0, cpc: 0, monthlySearches: [0, 0, 0, 0, 0, 0] }),
      row('how do i use e2e keywords', { isQuestion: true, searchVolume: 2400, serpFeatures: ['organic', 'people_also_ask'] }),
      row('e2e mid volume term', { searchVolume: 5400, keywordDifficulty: 45 }),
    ];

    await KeywordSearch.create({
      seedKeyword: 'e2e seed keyword',
      country: 'US',
      seedMetrics: row('e2e seed keyword', { searchVolume: 12100, keywordDifficulty: 55 }),
      relatedKeywords,
      totalCount: relatedKeywords.length,
      fetchedAt: new Date(),
    });
    await KeywordSearch.create({
      seedKeyword: 'e2e uk keyword',
      country: 'UK', // K2: canonical form is UK, not GB
      seedMetrics: row('e2e uk keyword', { searchVolume: 3300 }),
      relatedKeywords: [row('e2e uk related', { searchVolume: 720 })],
      totalCount: 1,
      fetchedAt: new Date(),
    });
    await KeywordSearch.create({
      seedKeyword: 'e2e locked keyword',
      country: 'US',
      seedMetrics: row('e2e locked keyword'),
      relatedKeywords: [row('e2e locked related')],
      totalCount: 1,
      fetchedAt: new Date(),
    });

    await KeywordDetail.create({
      keyword: 'e2e high volume term',
      country: 'US',
      serpResults: [
        { position: 1, title: 'E2E Result One', link: 'https://example.com/one', snippet: 'First result', domain: 'example.com' },
        { position: 2, title: 'E2E Result Two', link: 'https://other.com/two', snippet: 'Second result', domain: 'other.com' },
      ],
      peopleAlsoAsk: [
        { question: 'What is an e2e keyword?', snippet: 'It is a test fixture.', link: 'https://example.com/paa' },
      ],
      fetchedAt: new Date(),
    });

    await KeywordResearchHistory.create([
      { workspaceId: ws._id, seedKeyword: 'e2e seed keyword', country: 'US', searchedAt: new Date(), createdOnPlan: 'paid', locked: false },
      { workspaceId: ws._id, seedKeyword: 'e2e uk keyword', country: 'UK', searchedAt: new Date(Date.now() - 60_000), createdOnPlan: 'paid', locked: false },
      { workspaceId: ws._id, seedKeyword: 'e2e locked keyword', country: 'US', searchedAt: new Date(Date.now() - 120_000), createdOnPlan: 'paid', locked: true },
    ]);

    out.keywords = {
      seedKeyword: 'e2e seed keyword',
      ukKeyword: 'e2e uk keyword',
      lockedKeyword: 'e2e locked keyword',
      detailKeyword: 'e2e high volume term',
      relatedCount: relatedKeywords.length,
    };
  }

  console.log(JSON.stringify(out));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('[e2eSeed] failed:', e.message);
  process.exit(1);
});
