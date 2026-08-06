/**
 * Data-integrity & crawl regression tests (findings B1, C, D, E, H). Uses an
 * in-memory MongoDB (mongodb-memory-server) and drives the REAL crawler,
 * controllers, and deletion service hermetically (network via the Phase 1 seams).
 *
 * Began as a Phase 2 red-net (all `{ todo }`); Phase 3 landed the fixes and the
 * `todo` flags were removed, so these now ENFORCE the fixed behavior. See
 * SITE-SITEMAP-TEST-PLAN.md findings→tests matrix.
 *
 *   npm run test:crawler:rednet      (or)   MONGO_TEST_URI=... node --test tests/sitemapRedNet.test.js
 */

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Sitemap = require('../src/models/Sitemap');
const CrawlPage = require('../src/models/CrawlPage');
const Workspace = require('../src/models/Workspace');
const Organization = require('../src/models/Organization');

const crawler = require('../src/services/sitemapCrawlerService');
const { crawlSite, __setTestDeps, __resetTestDeps, __resetCaches } = crawler;
const { getSitemapPages } = require('../src/controllers/sitemapController');
const { deleteWorkspace } = require('../src/controllers/workspaceController');
const { deleteOrgData } = require('../src/services/deletionService');

const oid = () => new mongoose.Types.ObjectId();

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = () => res;
  res.send = (b) => { res.body = b; return res; };
  return res;
}

function htmlResponse(body) {
  return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => body };
}
function xmlResponse(body) {
  return { ok: true, status: 200, headers: { get: () => 'application/xml' }, text: async () => body };
}

before(async () => { await connect(); }, { timeout: 120000 });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); __resetTestDeps(); __resetCaches(); });
afterEach(() => { __resetTestDeps(); __resetCaches(); });

// ─── B (B1): a RELATIVE robots Sitemap: directive must not lose all seeding ────
// Today `Sitemap: /sitemap.xml` (relative) is fed straight to fetch(), throws, is
// swallowed, and suppresses the ${origin}/sitemap.xml fallback → total seeding
// loss. With a link-less homepage the crawl then errors out entirely.

test('crawl seeds from a relative robots Sitemap: directive (finding B)',
  async () => {
    const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://b1.test' });

    __setTestDeps({
      resolver: async () => [{ address: '93.184.216.34', family: 4 }], // b1.test → public
      fetchImpl: async (url) => {
        if (url === 'https://b1.test/robots.txt') {
          return htmlResponse('User-agent: *\nAllow: /\nSitemap: /sitemap.xml'); // RELATIVE
        }
        if (url === 'https://b1.test/sitemap.xml') {
          return xmlResponse('<urlset><url><loc>https://b1.test/p1</loc></url><url><loc>https://b1.test/p2</loc></url></urlset>');
        }
        if (url === 'https://b1.test/') return htmlResponse('<title>Home</title>'); // no links
        if (url === 'https://b1.test/p1') return htmlResponse('<title>P1</title>');
        if (url === 'https://b1.test/p2') return htmlResponse('<title>P2</title>');
        throw new Error(`ENOTFOUND ${url}`); // relative '/sitemap.xml' lands here, like real fetch
      },
    });

    await crawlSite(sm._id, { maxPages: 50 });

    const fresh = await Sitemap.findById(sm._id).lean();
    assert.equal(fresh.crawlStatus, 'completed', `crawl must complete via seeding, not error out; status=${fresh.crawlStatus}`);

    const urls = (await CrawlPage.find({ sitemapId: sm._id, diffStatus: { $ne: 'removed' } }).lean())
      .map((p) => p.url);
    assert.ok(
      urls.includes('https://b1.test/p1') && urls.includes('https://b1.test/p2'),
      `sitemap URLs from a relative Sitemap: directive must be crawled; got ${JSON.stringify(urls)}`,
    );
  });

// ─── C: deleting a workspace must cascade-delete its Sitemaps + CrawlPages ──────

test('deleting a workspace cascades to Sitemap and CrawlPage (finding C)',
  async () => {
    const userId = oid();
    const orgId = oid();
    const wsId = oid();
    await Organization.collection.insertOne({ _id: orgId, ownerId: userId, name: 'Org' });
    await Workspace.collection.insertOne({ _id: wsId, organizationId: orgId, name: 'W', isDefault: false, createdAt: new Date() });
    const sm = await Sitemap.create({ organizationId: orgId, workspaceId: wsId, url: 'https://c.test' });
    await CrawlPage.create({ sitemapId: sm._id, url: 'https://c.test/1', title: 'x', statusCode: 200, diffStatus: 'new' });

    const req = { params: { workspaceId: String(wsId) }, user: { userId, email: 'o@test' }, ip: '127.0.0.1' };
    await deleteWorkspace(req, makeRes());

    assert.equal(await Sitemap.countDocuments({ workspaceId: wsId }), 0, 'sitemaps must be deleted with the workspace');
    assert.equal(await CrawlPage.countDocuments({ sitemapId: sm._id }), 0, 'crawl pages must be deleted with the workspace');
  });

// ─── D: org erasure must not orphan CrawlPages of org-scoped sitemaps ───────────
// The org-level fallback deletes Sitemap by organizationId without first
// collecting sitemapIds to purge CrawlPage. Reproduce with a sitemap whose
// workspaceId maps to no Workspace of the org (so the per-workspace pass skips it).

test('org erasure purges CrawlPages of org-scoped sitemaps (finding D)',
  async () => {
    const orgId = oid();
    const orphanWsId = oid(); // deliberately NO Workspace document for this id
    const sm = await Sitemap.create({ organizationId: orgId, workspaceId: orphanWsId, url: 'https://d.test' });
    await CrawlPage.create({ sitemapId: sm._id, url: 'https://d.test/1', title: 'x', statusCode: 200, diffStatus: 'new' });

    await deleteOrgData(orgId, {});

    assert.equal(await Sitemap.countDocuments({ organizationId: orgId }), 0, 'org sitemaps must be deleted');
    assert.equal(await CrawlPage.countDocuments({ sitemapId: sm._id }), 0, 'org erasure must not orphan crawl pages');
  });

// ─── E: page search must escape regex metacharacters (ReDoS / regex injection) ──
// "a+b" as a raw regex matches "aaab" but NOT the literal "a+b"; escaped, it
// matches only the literal. So a literal search proves whether escaping happened.

test('page search escapes regex metacharacters (finding E)',
  async () => {
    const orgId = oid();
    const wsId = oid();
    const sm = await Sitemap.create({ organizationId: orgId, workspaceId: wsId, url: 'https://e.test' });
    await CrawlPage.create([
      { sitemapId: sm._id, url: 'https://e.test/1', title: 'a+b', statusCode: 200, diffStatus: 'new' },
      { sitemapId: sm._id, url: 'https://e.test/2', title: 'aaab', statusCode: 200, diffStatus: 'new' },
    ]);

    const req = {
      params: { sitemapId: String(sm._id) },
      query: { search: 'a+b' },
      workspace: { _id: wsId, organizationId: orgId },
    };
    const res = makeRes();
    await getSitemapPages(req, res);

    const titles = (res.body.pages || []).map((p) => p.title).sort();
    assert.deepEqual(titles, ['a+b'], `literal "a+b" must match only the literal title, not the regex expansion; got ${JSON.stringify(titles)}`);
  });

// ─── H: {workspaceId, url} must be a unique index (TOCTOU / duplicate rows) ─────

test('Sitemap enforces a unique {workspaceId, url} index (finding H)',
  async () => {
    await Sitemap.syncIndexes();
    const doc = { organizationId: oid(), workspaceId: oid(), url: 'https://dup.test' };
    await Sitemap.create(doc);
    await assert.rejects(
      () => Sitemap.create(doc),
      (err) => !!err && (err.code === 11000 || /duplicate|E11000/i.test(err.message || '')),
      'a second sitemap with the same workspaceId+url must be rejected by a unique index',
    );
  });

// ─── Control: the harness itself works (enforcing, NOT todo) ───────────────────

test('control: CrawlPage documents persist and are queryable', async () => {
  const sm = await Sitemap.create({ organizationId: oid(), workspaceId: oid(), url: 'https://ctrl.test' });
  await CrawlPage.create({ sitemapId: sm._id, url: 'https://ctrl.test/1', title: 't', statusCode: 200, diffStatus: 'new' });
  assert.equal(await CrawlPage.countDocuments({ sitemapId: sm._id }), 1);
});
