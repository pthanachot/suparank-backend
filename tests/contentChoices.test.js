'use strict';

/**
 * Wave 5 Phase 5 — content choices, Tier 1 (plan §9).
 *
 * The claims worth pinning: keywords group case-insensitively so one human
 * keyword is one row (W3), articles predating createdVia are held apart in a
 * `legacy` bucket instead of inflating "manual" (W3), the word-count comparison
 * distinguishes "agreed" from "nothing to compare", and every content type is
 * reported including the ones nobody picks.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Content = require('../src/models/Content');
const {
  getContentChoices, getKeywordLedger, getCreationShape, getWordCountChoice, CONTENT_TYPES,
} = require('../src/services/contentChoicesService');

const DAY_MS = 24 * 60 * 60 * 1000;
// Content has no workspaceNumber path — seed the real field, else these tests
// re-create the masking that hid the ledger's always-zero workspaces column.
const WS = (n) => new mongoose.Types.ObjectId(String(n).padStart(24, '0'));
// The service treats anything created before this as pre-tracking.
const AFTER = new Date('2026-08-08T12:00:00.000Z');
const BEFORE = new Date('2026-07-01T12:00:00.000Z');

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

let n = 5000;
async function article(fields = {}) {
  await Content.collection.insertOne({
    contentNumber: n++, title: `a${n}`, workspaceId: WS(fields.ws ?? 1),
    targetKeywords: fields.keywords ?? [], createdVia: fields.createdVia ?? 'blank',
    contentType: fields.contentType ?? '', language: fields.language ?? 'en',
    country: fields.country ?? 'US', device: fields.device ?? 'desktop',
    score: fields.score ?? 0, targetWordCount: fields.targetWordCount ?? 0,
    aiFormatData: fields.aiFormatData ?? null, analysisStatus: fields.analysisStatus ?? 'idle',
    createdAt: fields.createdAt ?? AFTER, updatedAt: fields.createdAt ?? AFTER,
  });
}

test('keywords group case-insensitively and keep the most-used spelling', async () => {
  await article({ keywords: ['Best CRM'], ws: 1 });
  await article({ keywords: ['best crm'], ws: 2 });
  await article({ keywords: ['  best crm  '], ws: 2 });

  const ledger = await getKeywordLedger();
  assert.equal(ledger.length, 1, 'one human keyword is one row');
  assert.equal(ledger[0].articles, 3);
  assert.equal(ledger[0].workspaces, 2);
  assert.equal(ledger[0].keyword, 'best crm', 'the spelling people actually use wins');
});

test('the ledger reports source mix, average score and recency', async () => {
  await article({ keywords: ['seo tools'], createdVia: 'keyword', score: 80 });
  await article({ keywords: ['seo tools'], createdVia: 'blank', score: 60 });
  // A zero score means "never analysed", not "scored zero" — it must not drag
  // the average down.
  await article({ keywords: ['seo tools'], createdVia: 'blank', score: 0, createdAt: new Date(AFTER.getTime() + DAY_MS) });

  const [row] = await getKeywordLedger();
  assert.equal(row.articles, 3);
  assert.deepEqual(row.sources, { keyword: 1, blank: 2 });
  assert.equal(row.avgScore, 70, 'unscored articles are excluded from the average');
  assert.equal(+row.lastCreated, +new Date(AFTER.getTime() + DAY_MS));
});

test('articles predating createdVia land in a legacy bucket, not in manual', async () => {
  // Both carry createdVia 'blank' — the schema default — so only age separates
  // a genuine manual creation from one that predates the field.
  await article({ keywords: ['a'], createdVia: 'blank', createdAt: BEFORE });
  await article({ keywords: ['b'], createdVia: 'blank', createdAt: AFTER });

  const { sources } = await getCreationShape();
  assert.equal(sources.legacy, 1, 'the old one is held apart');
  assert.equal(sources.blank, 1, 'and does not inflate manual');
});

test('an explicit source is trusted even on an article older than the rollout', async () => {
  // 'keyword'/'url'/'template' are only ever written deliberately, so ageing
  // them into the legacy bucket would discard attribution we actually have.
  await article({ keywords: ['a'], createdVia: 'keyword', createdAt: BEFORE });
  await article({ keywords: ['b'], createdVia: 'url', createdAt: BEFORE });
  await article({ keywords: ['c'], createdVia: 'blank', createdAt: BEFORE });

  const { sources } = await getCreationShape();
  assert.equal(sources.keyword, 1, 'explicit source survives its age');
  assert.equal(sources.url, 1);
  assert.equal(sources.legacy, 1, 'only the ambiguous default is aged out');
  assert.equal(sources.blank, undefined);
});

test('keywords-per-article buckets, including articles with none', async () => {
  await article({ keywords: [] });
  await article({ keywords: ['one'] });
  await article({ keywords: ['a', 'b'] });
  await article({ keywords: ['a', 'b', 'c', 'd', 'e'] });
  // Blank strings are not keywords.
  await article({ keywords: ['  ', ''] });

  const { keywordsPerArticle, total } = await getCreationShape();
  assert.equal(total, 5);
  assert.equal(keywordsPerArticle[0], 2, 'empty and whitespace-only both count as none');
  assert.equal(keywordsPerArticle[1], 1);
  assert.equal(keywordsPerArticle[2], 1);
  assert.equal(keywordsPerArticle['4-5'], 1);
});

test('word count: agreement, disagreement and nothing-to-compare are distinct', async () => {
  const rec = (v) => ({ recommendedStructure: { targetWordCount: { recommended: v } } });
  await article({ targetWordCount: 1500, aiFormatData: rec(1500) });   // kept
  await article({ targetWordCount: 1530, aiFormatData: rec(1500) });   // within 5% => kept
  await article({ targetWordCount: 2500, aiFormatData: rec(1500) });   // raised
  await article({ targetWordCount: 800, aiFormatData: rec(1500) });    // lowered
  await article({ targetWordCount: 1200, aiFormatData: null });        // no recommendation

  const wc = await getWordCountChoice();
  assert.equal(wc.kept, 2);
  assert.equal(wc.raised, 1);
  assert.equal(wc.lowered, 1);
  assert.equal(wc.noRecommendation, 1, 'must not be counted as agreement');
});

test('a flat recommended word count is understood as well as a ranged one', async () => {
  await article({ targetWordCount: 1000, aiFormatData: { recommendedStructure: { targetWordCount: 1000 } } });
  const wc = await getWordCountChoice();
  assert.equal(wc.kept, 1);
  assert.equal(wc.noRecommendation, 0);
});

test('every content type is reported, including the ones nobody picks', async () => {
  await article({ contentType: 'listicle' });
  const { settings } = await getContentChoices();
  for (const t of CONTENT_TYPES) {
    assert.ok(t in settings.contentType, `${t} must appear even at zero`);
  }
  assert.equal(settings.contentType.listicle, 1);
  assert.equal(settings.contentType['blog-post'], 0, 'an unused type is the actionable one');
});

test('unset language/country/device are labelled rather than dropped', async () => {
  await article({ device: '', country: '' });
  const { settings } = await getContentChoices();
  assert.equal(settings.device['(unset)'], 1);
  assert.equal(settings.country['(unset)'], 1);
});

test('engine offer averages only analysed articles and flags itself current-state', async () => {
  await Content.collection.insertOne({
    contentNumber: n++, title: 'analysed', workspaceNumber: 1, analysisStatus: 'ready',
    targetKeywords: ['x'], benchmark: { topNlpTerms: [1, 2, 3] }, relatedSearches: [1, 2],
    peopleAlsoAsk: [1], aiAnswerAnalysis: { query_groups: [1, 2, 3, 4] },
    createdAt: AFTER, updatedAt: AFTER,
  });
  await article({ analysisStatus: 'idle', keywords: ['y'] }); // never analysed

  const { engineOffer } = await getContentChoices();
  assert.equal(engineOffer.analysedArticles, 1, 'unanalysed articles are not averaged in');
  assert.equal(engineOffer.avgNlpTerms, 3);
  assert.equal(engineOffer.avgAeoQueryGroups, 4);
  assert.equal(engineOffer.currentStateOnly, true, 're-analysis overwrites these fields');
});

test('the ledger is returned in full and ordered by reach', async () => {
  await article({ keywords: ['rare'] });
  for (let i = 0; i < 3; i++) await article({ keywords: ['popular'] });

  const ledger = await getKeywordLedger();
  assert.equal(ledger[0].keyword, 'popular');
  assert.equal(ledger.length, 2, 'no truncation — the export needs every row');
});
