'use strict';

/**
 * Wave 5 Phase 8 — cross-cutting guards for the analytics read models.
 *
 * These are SOURCE SCANS, deliberately. The behavioural tests prove each
 * service does the right thing today; these prove the next person can't add a
 * query that quietly skips a rule, because the guard fails closed on a pattern
 * rather than on a known list of call sites.
 *
 * The rules being enforced (USAGE-TELEMETRY-PLAN §7.0, §9.0):
 *  - every read of ObservationEvent excludes impersonated rows;
 *  - every read of Content excludes soft-deleted (archived) articles;
 *  - the raw horizon is never re-hardcoded away from the model that owns it;
 *  - $size is never applied to a Mixed field without an array guard.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVICES = path.join(__dirname, '../src/services');
const ANALYTICS = [
  'usageAnalyticsService.js',
  'conversionAnalyticsService.js',
  'retentionAnalyticsService.js',
  'contentChoicesService.js',
];
const read = (f) => fs.readFileSync(path.join(SERVICES, f), 'utf8');

/** The `{ ... }` immediately following each `$match:` in a source file. */
function matchStages(src) {
  const out = [];
  const re = /\$match:\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ index: m.index, body: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** Which collection a pipeline belongs to — the nearest `X.aggregate(` above it. */
function collectionFor(src, index) {
  const before = src.slice(0, index);
  const hits = [...before.matchAll(/(\w+)\.(?:aggregate|find|distinct|countDocuments)\s*\(/g)];
  return hits.length ? hits[hits.length - 1][1] : null;
}

test('every ObservationEvent pipeline excludes impersonated rows', () => {
  const offenders = [];
  for (const file of ANALYTICS) {
    const src = read(file);
    for (const stage of matchStages(src)) {
      if (collectionFor(src, stage.index) !== 'ObservationEvent') continue;
      // Either inline, or via a spread of a named filter that carries it.
      const inline = /impersonatedBy\s*:\s*null/.test(stage.body);
      const viaSpread = /\.\.\.\w+/.test(stage.body) && /impersonatedBy: null/.test(src);
      if (!inline && !viaSpread) {
        offenders.push(`${file}: ${stage.body.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'an admin browsing as a customer must never appear in that customer\'s numbers');
});

test('every Content read in the analytics services excludes archived articles', () => {
  const offenders = [];
  const src = read('contentChoicesService.js');
  for (const stage of matchStages(src)) {
    if (collectionFor(src, stage.index) !== 'Content') continue;
    if (!/LIVE|status/.test(stage.body)) {
      offenders.push(stage.body.replace(/\s+/g, ' ').slice(0, 90));
    }
  }
  // Content.find() calls take a filter rather than a $match stage.
  for (const m of src.matchAll(/Content\.find\(\s*([^,]+),/g)) {
    if (!/LIVE/.test(m[1])) offenders.push(`Content.find(${m[1].trim().slice(0, 60)}`);
  }
  assert.deepEqual(offenders, [],
    'soft-deleted articles (status archived) are not live articles');
});

test('the raw horizon is imported, never re-hardcoded', () => {
  const offenders = [];
  for (const file of [...ANALYTICS, 'observationRollupService.js']) {
    const src = read(file);
    if (/RAW_HORIZON_DAYS\s*=\s*\d+/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'the model that owns the TTL owns the constant — a second literal can drift from actual retention');
});

test('$size is never applied to a Mixed field without an array guard', () => {
  // benchmark and aiAnswerAnalysis are Schema.Types.Mixed: $size on a
  // non-array throws and takes the whole endpoint down for every admin.
  const src = read('contentChoicesService.js');
  const unguarded = [...src.matchAll(/\$size:\s*\{?\s*['"`]?\$(benchmark|aiAnswerAnalysis)[^}]*/g)]
    .map((m) => m[0].slice(0, 80));
  assert.deepEqual(unguarded, [], 'use safeSize() — one malformed document must not 500 the tab');
});

test('the analytics services do not trust a client-supplied organisation', () => {
  // Org attribution is derived server-side; accepting payload.orgId from the
  // ingest lane would let any user attribute their activity to another org.
  const ingest = fs.readFileSync(path.join(__dirname, '../src/controllers/observeController.js'), 'utf8');
  const ingestFn = ingest.slice(ingest.indexOf('async function ingestObservations'), ingest.indexOf('/** Server-side helper'));
  assert.ok(!/payload\.orgId|body\.orgId/.test(ingestFn),
    'ingestObservations must derive org from the workspace or the authenticated user, never from the request body');
});
