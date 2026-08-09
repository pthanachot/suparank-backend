'use strict';

/**
 * Wave 5 Phase 6 — adoption of what the engine suggested (plan §9).
 *
 * Also covers the two Phase 5 defects this code path would otherwise have
 * inherited: soft-deleted articles counting as live (P5-2), and $size throwing
 * on a Mixed field that isn't an array, which 500s the whole endpoint (P5-1).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Content = require('../src/models/Content');
const { getContentChoices, getAdoption, getEngineOffer } = require('../src/services/contentChoicesService');

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

let n = 8000;
const add = (f = {}) => Content.collection.insertOne({
  contentNumber: n++, title: 't', workspaceNumber: 1, targetKeywords: f.keywords ?? ['k'],
  createdVia: 'keyword', status: f.status ?? 'draft', analysisStatus: f.analysisStatus ?? 'idle',
  outlineEdit: f.outlineEdit, citabilitySnapshot: f.citability,
  appliedGscQueries: f.gsc ?? [], trackedPrompts: f.tracked ?? [],
  benchmark: f.benchmark, aiAnswerAnalysis: f.aeo,
  createdAt: new Date(), updatedAt: new Date(),
});

test('outline edit depth is grouped, with approvals as the denominator', async () => {
  await add({ outlineEdit: { depth: 'unedited' } });
  await add({ outlineEdit: { depth: 'unedited' } });
  await add({ outlineEdit: { depth: 'renamed' } });
  await add({ outlineEdit: { depth: 'heavy' } });
  await add({}); // no approval recorded — must not count as "unedited"

  const { outline } = await getAdoption();
  assert.equal(outline.approvals, 4, 'denominator is approvals, not all articles');
  assert.equal(outline.keptAsIs, 2);
  assert.deepEqual(outline.byDepth, { unedited: 2, renamed: 1, heavy: 1 });
});

test('AEO coverage reports bands, not just an average', async () => {
  await add({ citability: { covered: 0, total: 10 } });   // ignored every phrase
  await add({ citability: { covered: 9, total: 10 } });   // used most
  await add({ citability: { covered: 3, total: 10 } });   // partial
  await add({ citability: { covered: 0, total: 0 } });    // nothing offered — excluded

  const { aeoPhrases } = await getAdoption();
  assert.equal(aeoPhrases.articlesWithPhrases, 3, 'articles offered nothing are not in the denominator');
  assert.equal(aeoPhrases.phrasesOffered, 30);
  assert.equal(aeoPhrases.phrasesUsed, 12);
  assert.equal(aeoPhrases.articlesUsingNone, 1);
  assert.equal(aeoPhrases.articlesUsingMost, 1);
});

test('acceptance counts articles, and says it has no offer denominator', async () => {
  await add({ gsc: ['q1', 'q2'] });
  await add({ tracked: ['p1'] });
  await add({});

  const { accepted } = await getAdoption();
  assert.equal(accepted.articlesWithGscApplied, 1);
  assert.equal(accepted.articlesWithTrackedKeywords, 1);
  assert.match(accepted.note, /no offer denominator/);
});

test('P5-2: archived articles are excluded everywhere', async () => {
  await add({ keywords: ['live'], outlineEdit: { depth: 'unedited' }, citability: { covered: 5, total: 10 }, gsc: ['q'] });
  await add({ keywords: ['deleted'], status: 'archived', outlineEdit: { depth: 'heavy' }, citability: { covered: 0, total: 10 }, gsc: ['q'] });

  const r = await getContentChoices();
  assert.equal(r.creation.total, 1, 'soft-deleted articles are not live articles');
  assert.ok(!r.keywordLedger.some((k) => k.keyword === 'deleted'));
  assert.equal(r.adoption.outline.approvals, 1);
  assert.equal(r.adoption.aeoPhrases.articlesWithPhrases, 1);
  assert.equal(r.adoption.accepted.articlesWithGscApplied, 1);
});

test('P5-1: a Mixed field holding a non-array does not take the endpoint down', async () => {
  // benchmark and aiAnswerAnalysis are Schema.Types.Mixed — nothing enforces
  // their shape, so one malformed document must not 500 every admin.
  await add({ analysisStatus: 'ready', benchmark: { topNlpTerms: 'not-an-array' } });
  await add({ analysisStatus: 'ready', benchmark: { topNlpTerms: [1, 2, 3] }, aeo: { query_groups: { nope: true } } });

  const offer = await getEngineOffer();
  assert.equal(offer.analysedArticles, 2, 'both documents still counted');
  // The malformed one contributes 0 rather than throwing: 3 terms over 2 articles.
  assert.equal(offer.avgNlpTerms, 1.5);
  assert.equal(offer.avgAeoQueryGroups, 0);

  // And the whole endpoint still answers.
  const r = await getContentChoices();
  assert.ok(r.engineOffer);
});

test('a whole-endpoint read survives documents with no analysis fields at all', async () => {
  await add({ analysisStatus: 'ready' });
  const r = await getContentChoices();
  assert.equal(r.engineOffer.avgNlpTerms, 0);
  assert.equal(r.adoption.outline.approvals, 0);
});
