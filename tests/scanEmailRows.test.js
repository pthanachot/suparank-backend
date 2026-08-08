/**
 * The scan_completed table fragments (utils/scanEmailRows).
 *
 * Extracted out of aiTrackerController.executeScan in Phase 3 so that the
 * preview harness imports the real markup instead of hand-copying it. That
 * copy had already drifted out of the Phase 1 token sweep once.
 *
 * The escaping assertions matter more than they look. Two of these inputs are
 * genuinely attacker-reachable:
 *   - `prompt` is authored by any user via prompt CRUD;
 *   - `competitor.name` is extracted by an LLM, so prompt injection reaches it.
 * Both land in a table inside an email we send to the workspace owner.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPlatformRows,
  buildPromptRows,
  buildCompetitorRows,
  buildActionRows,
  emptyRow,
} = require('../src/utils/scanEmailRows');

const cells = (html) => html.match(/<t[dh][^>]*>/g) || [];

describe('escaping', () => {
  it('escapes a user-authored prompt', () => {
    const html = buildPromptRows([
      { prompt: '<img src=x onerror=alert(1)>', platforms: [{ mentioned: true, cited: false }] },
    ]);
    assert.doesNotMatch(html, /<img src=x/, 'prompt rendered as live markup');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('escapes an LLM-extracted competitor name (prompt-injection surface)', () => {
    const html = buildCompetitorRows([
      { name: '</td><script>x</script>', mentions: 1, citations: 0, visibility: 5 },
    ]);
    assert.doesNotMatch(html, /<script>/, 'competitor name broke out of the cell');
    assert.match(html, /&lt;\/td&gt;&lt;script&gt;/);
  });

  it('escapes action-item text', () => {
    const html = buildActionRows([
      { priority: 'high', title: '<b>t</b>', description: '<i>d</i>', impact: '<u>i</u>' },
    ]);
    assert.doesNotMatch(html, /<b>|<i>|<u>/);
  });

  it('escapes the empty-state text', () => {
    assert.doesNotMatch(emptyRow(5, '<b>none</b>'), /<b>/);
  });
});

describe('markup contract', () => {
  it('every cell names the font — Outlook will not inherit it', () => {
    const html =
      buildPlatformRows([{ name: 'ChatGPT', visibility: 1, mentionCount: 1, citationCount: 1, errorCount: 0 }], 2) +
      buildPromptRows([{ prompt: 'p', platforms: [{ mentioned: true, cited: true }] }]) +
      buildCompetitorRows([{ name: 'c', mentions: 1, citations: 1, visibility: 1 }]) +
      buildActionRows([{ priority: 'low', title: 't', description: 'd', impact: 'i' }]) +
      emptyRow(3, 'none');
    const bare = cells(html).filter((c) => !c.includes('font-family') && c !== '<td>');
    assert.deepEqual(bare, [], `cells without font-family: ${bare.join(' ')}`);
  });

  it('produces balanced rows', () => {
    const html = buildPlatformRows(
      [{ name: 'ChatGPT', visibility: 1, mentionCount: 1, citationCount: 1, errorCount: 3 }],
      5
    );
    assert.equal((html.match(/<tr/g) || []).length, 1);
    assert.equal((html.match(/<\/tr>/g) || []).length, 1);
    assert.equal((html.match(/<td/g) || []).length, (html.match(/<\/td>/g) || []).length);
  });

  it('renders an error cell only when a platform errored', () => {
    const withErrors = buildPlatformRows([{ name: 'X', visibility: 0, mentionCount: 0, citationCount: 0, errorCount: 2 }], 4);
    const clean = buildPlatformRows([{ name: 'X', visibility: 0, mentionCount: 0, citationCount: 0, errorCount: 0 }], 4);
    assert.match(withErrors, /2 errors/);
    assert.doesNotMatch(clean, /error/);
  });

  it('singularises a single error', () => {
    const html = buildPlatformRows([{ name: 'X', visibility: 0, mentionCount: 0, citationCount: 0, errorCount: 1 }], 4);
    assert.match(html, /1 error</);
  });
});

describe('ordering and limits', () => {
  it('puts carry-forward prompts last, then sorts by mention rate', () => {
    const html = buildPromptRows([
      { prompt: 'CARRIED', platforms: [{ mentioned: true, cited: true }], _isCarryForward: true },
      { prompt: 'LOW', platforms: [{ mentioned: false, cited: false }] },
      { prompt: 'HIGH', platforms: [{ mentioned: true, cited: true }] },
    ]);
    assert.ok(html.indexOf('HIGH') < html.indexOf('LOW'), 'not sorted by mention rate');
    assert.ok(html.indexOf('LOW') < html.indexOf('CARRIED'), 'carry-forward not last');
  });

  it('caps competitors at 10 and actions at 5', () => {
    const comp = buildCompetitorRows(
      Array.from({ length: 25 }, (_, i) => ({ name: `c${i}`, mentions: 0, citations: 0, visibility: 0 }))
    );
    assert.equal((comp.match(/<tr/g) || []).length, 10);
    const acts = buildActionRows(
      Array.from({ length: 12 }, (_, i) => ({ priority: 'low', title: `t${i}`, description: '', impact: '' }))
    );
    assert.equal((acts.match(/<tr/g) || []).length, 5);
  });

  it('orders actions high → medium → low', () => {
    const html = buildActionRows([
      { priority: 'low', title: 'LOW', description: '', impact: '' },
      { priority: 'high', title: 'HIGH', description: '', impact: '' },
      { priority: 'medium', title: 'MED', description: '', impact: '' },
    ]);
    assert.ok(html.indexOf('HIGH') < html.indexOf('MED'));
    assert.ok(html.indexOf('MED') < html.indexOf('LOW'));
  });

  it('does not mutate the caller\'s array', () => {
    // The pre-extraction code sorted actionItems IN PLACE, reordering an array
    // the caller still held.
    const items = [
      { priority: 'low', title: 'a', description: '', impact: '' },
      { priority: 'high', title: 'b', description: '', impact: '' },
    ];
    buildActionRows(items);
    assert.equal(items[0].title, 'a', 'input array was reordered');
  });

  it('truncates a long prompt at 70 characters', () => {
    const long = 'x'.repeat(120);
    const html = buildPromptRows([{ prompt: long, platforms: [{ mentioned: true, cited: false }] }]);
    assert.match(html, /x{70}…/);
    assert.doesNotMatch(html, /x{71}/);
  });
});

describe('brand accent', () => {
  it('uses the resolved primaryColor on the impact column', () => {
    const html = buildActionRows([{ priority: 'high', title: 't', description: 'd', impact: '+5%' }], '#0F766E');
    assert.match(html, /color:#0F766E/);
  });

  it('falls back to the platform blue', () => {
    const html = buildActionRows([{ priority: 'high', title: 't', description: 'd', impact: '+5%' }]);
    assert.match(html, /color:#2B5BE8/);
  });
});

describe('empty input', () => {
  it('every builder returns an empty string rather than throwing', () => {
    assert.equal(buildPlatformRows(), '');
    assert.equal(buildPromptRows(), '');
    assert.equal(buildCompetitorRows(), '');
    assert.equal(buildActionRows(), '');
  });
});
