'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rankStrikingDistance } = require('../src/services/gscService');

// Build a synthetic GSC ['query','page'] row.
function row(query, page, position, impressions, clicks = 0, ctr = 0) {
  return { keys: [query, page], position, impressions, clicks, ctr };
}

test('filters to the 11-20 position band', () => {
  const rows = [
    row('in band low', '/a', 11, 500),
    row('in band high', '/b', 20, 500),
    row('page one', '/c', 4, 500),   // too high (already page 1)
    row('page three', '/d', 25, 500), // too low
  ];
  const { rows: out } = rankStrikingDistance(rows);
  const kws = out.map((r) => r.keyword).sort();
  assert.deepStrictEqual(kws, ['in band high', 'in band low']);
});

test('applies the minimum-impressions cutoff', () => {
  const rows = [
    row('enough', '/a', 12, 100),
    row('too few', '/b', 12, 5), // below default minImpressions (30)
  ];
  const { rows: out } = rankStrikingDistance(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].keyword, 'enough');
});

test('dedups one row per query, keeping the highest-impression page', () => {
  const rows = [
    row('shared kw', '/weak', 13, 100),
    row('shared kw', '/strong', 15, 900), // more impressions → this page wins
  ];
  const { rows: out } = rankStrikingDistance(rows);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].page, '/strong');
  assert.strictEqual(out[0].impressions, 900);
});

test('ranks by opportunity: closeness to page 1 breaks impression ties', () => {
  const rows = [
    row('near jump', '/a', 11, 1000), // closeness 1.0
    row('deep page 2', '/b', 20, 1000), // closeness 0.1
  ];
  const { rows: out } = rankStrikingDistance(rows);
  assert.strictEqual(out[0].keyword, 'near jump');
  assert.ok(out[0].opportunity > out[1].opportunity, 'nearer keyword scores higher');
  // opportunity = impressions * (maxPos - pos + 1)/span; span=10
  assert.strictEqual(out[0].opportunity, 1000); // 1000 * 10/10
  assert.strictEqual(out[1].opportunity, 100); //  1000 *  1/10
});

test('higher impressions rank higher at equal position', () => {
  const rows = [
    row('small', '/a', 12, 200),
    row('big', '/b', 12, 2000),
  ];
  const { rows: out } = rankStrikingDistance(rows);
  assert.strictEqual(out[0].keyword, 'big');
});

test('output shape: percent ctr and estimated potential clicks', () => {
  const rows = [row('kw', '/p', 12, 1000, 5, 0.005)]; // 0.5% ctr, 5 clicks
  const { rows: out } = rankStrikingDistance(rows);
  const r = out[0];
  assert.strictEqual(r.ctr, 0.5, 'ctr as percent');
  // potentialClicks = max(0, round(1000*0.05) - 5) = 50 - 5 = 45
  assert.strictEqual(r.potentialClicks, 45);
  assert.deepStrictEqual(Object.keys(r).sort(), ['clicks', 'ctr', 'impressions', 'keyword', 'opportunity', 'page', 'position', 'potentialClicks']);
});

test('caps output and flags truncation', () => {
  const rows = [];
  for (let i = 0; i < 250; i++) rows.push(row('kw' + i, '/p' + i, 12, 100 + i));
  const { rows: out, truncated } = rankStrikingDistance(rows, { cap: 200 });
  assert.strictEqual(out.length, 200);
  assert.strictEqual(truncated, true);
});

test('degenerate inputs do not throw', () => {
  assert.deepStrictEqual(rankStrikingDistance(null).rows, []);
  assert.deepStrictEqual(rankStrikingDistance([]).rows, []);
  assert.deepStrictEqual(rankStrikingDistance([null, undefined]).rows, []);
});
