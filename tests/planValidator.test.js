const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const v = require('../src/services/planValidator');

// ─── Completeness ─────────────────────────────────────────────────────

function completePlan(overrides = {}) {
  return {
    targetAudience: 'Early-stage SaaS founders evaluating onboarding tools',
    angle: 'Framework-agnostic comparison, not a vendor pitch',
    thesis: 'The right onboarding tool depends on company size and product type',
    alternatives: [
      { label: 'Lead with comparison table', pros: ['Quick scan'], cons: ['Less depth'], chosen: false, reason: '' },
      { label: 'Lead with use-case framing', pros: ['Reader-relevant'], cons: ['Slower to value'], chosen: true, reason: 'Audience is exploration-stage' },
    ],
    risks: [{ description: 'Competitor X covers this angle', mitigation: 'Differentiate via use cases', severity: 'medium' }],
    sections: [
      {
        id: 's1',
        heading: 'Introduction',
        headingLevel: 2,
        keyPoints: [{ text: 'Frame the problem', evidence: [{ path: '/keywords/primary.md', reason: 'target keyword' }] }],
        wordTarget: 200,
      },
      {
        id: 's2',
        heading: 'Comparison',
        headingLevel: 2,
        keyPoints: [{ text: 'Tool A vs B', evidence: [{ path: '/competitors/a.md', reason: 'competitor data' }] }],
        wordTarget: 600,
      },
      {
        id: 's3',
        heading: 'Recommendation',
        headingLevel: 2,
        keyPoints: [{ text: 'Pick by stage', evidence: [{ path: '/subtopics/stage.md', reason: 'stage data' }] }],
        wordTarget: 200,
      },
    ],
    ...overrides,
  };
}

describe('validateCompleteness', () => {
  it('passes a complete plan', () => {
    const result = v.validateCompleteness(completePlan(), { targetWordCount: 1000 });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  });

  it('rejects missing strategic fields', () => {
    const result = v.validateCompleteness(completePlan({ angle: '', thesis: '' }), { targetWordCount: 1000 });
    assert.equal(result.ok, false);
    const rules = result.failures.map((f) => f.rule);
    assert.ok(rules.includes('strategic.angle'));
    assert.ok(rules.includes('strategic.thesis'));
  });

  it('requires at least 2 alternatives', () => {
    const plan = completePlan({ alternatives: [{ label: 'Only one', chosen: true, reason: 'sole option' }] });
    const result = v.validateCompleteness(plan, { targetWordCount: 1000 });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.rule === 'alternatives.min'));
  });

  it('requires exactly one chosen alternative', () => {
    const plan = completePlan({
      alternatives: [
        { label: 'A', chosen: true, reason: 'one' },
        { label: 'B', chosen: true, reason: 'two' },
      ],
    });
    const result = v.validateCompleteness(plan, { targetWordCount: 1000 });
    assert.ok(result.failures.some((f) => f.rule === 'alternatives.chosen'));
  });

  it('requires a reason on the chosen alternative', () => {
    const plan = completePlan({
      alternatives: [
        { label: 'A', chosen: false, reason: '' },
        { label: 'B', chosen: true, reason: '' },
      ],
    });
    const result = v.validateCompleteness(plan, { targetWordCount: 1000 });
    assert.ok(result.failures.some((f) => f.rule.endsWith('.reason')));
  });

  it('requires at least one risk', () => {
    const plan = completePlan({ risks: [] });
    const result = v.validateCompleteness(plan, { targetWordCount: 1000 });
    assert.ok(result.failures.some((f) => f.rule === 'risks.min'));
  });

  it('enforces section count >= brief.subtopics.length', () => {
    const plan = completePlan(); // 3 sections
    const brief = { targetWordCount: 1000, subtopics: [{}, {}, {}, {}, {}] }; // 5 required
    const result = v.validateCompleteness(plan, brief);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.rule === 'sections.min'));
  });

  it('rejects a section without key points', () => {
    const plan = completePlan();
    plan.sections[1].keyPoints = [];
    const result = v.validateCompleteness(plan, { targetWordCount: 1000 });
    assert.ok(result.failures.some((f) => f.rule.includes('keyPoints')));
  });

  it('rejects a key point without evidence', () => {
    const plan = completePlan();
    plan.sections[1].keyPoints[0].evidence = [];
    const result = v.validateCompleteness(plan, { targetWordCount: 1000 });
    assert.ok(result.failures.some((f) => f.rule.includes('evidence')));
  });

  it('rejects when section word budget deviates >10% from brief target', () => {
    const plan = completePlan(); // sums to 200+600+200 = 1000
    const result = v.validateCompleteness(plan, { targetWordCount: 1500 }); // 33% off
    assert.ok(result.failures.some((f) => f.rule === 'wordBudget'));
  });

  it('accepts when section word budget is within 10%', () => {
    const plan = completePlan();
    const result = v.validateCompleteness(plan, { targetWordCount: 1050 }); // 5% off
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  });

  // The Go drift heuristic matches plan sections to doc sections by heading
  // slug. Two plan sections with the same heading would emit doubled
  // word-budget violations downstream. Catch the misconfig here.
  it('rejects duplicate section headings (case + whitespace insensitive)', () => {
    const plan = completePlan();
    plan.sections[0].heading = 'Intro';
    plan.sections[1].heading = '  intro  '; // same heading after normalization
    const result = v.validateCompleteness(plan);
    assert.ok(
      result.failures.some((f) => f.rule.endsWith('.heading.duplicate')),
      'duplicate headings should fire; got: ' + JSON.stringify(result.failures)
    );
  });

  it('does not flag empty headings as duplicates', () => {
    const plan = completePlan();
    plan.sections[0].heading = '';
    plan.sections[1].heading = '';
    const result = v.validateCompleteness(plan);
    const dupFailures = result.failures.filter((f) =>
      f.rule.endsWith('.heading.duplicate')
    );
    assert.equal(dupFailures.length, 0, JSON.stringify(dupFailures));
  });
});

// ─── JSON Patch ops whitelist ─────────────────────────────────────────

describe('validateOps', () => {
  it('accepts whitelisted paths', () => {
    const result = v.validateOps([
      { op: 'replace', path: '/angle', value: 'new angle' },
      { op: 'add', path: '/sections/-', value: { id: 's4', heading: 'X', headingLevel: 2 } },
      { op: 'replace', path: '/sections/0/heading', value: 'New heading' },
      { op: 'add', path: '/alternatives/-', value: { label: 'C', chosen: false } },
      { op: 'add', path: '/evidenceMap/s1', value: [{ path: '/keywords/primary.md', reason: 'test' }] },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  });

  it('rejects writes to status', () => {
    const result = v.validateOps([{ op: 'replace', path: '/status', value: 'approved' }]);
    assert.equal(result.ok, false);
  });

  it('rejects writes to version', () => {
    const result = v.validateOps([{ op: 'replace', path: '/version', value: 99 }]);
    assert.equal(result.ok, false);
  });

  it('rejects writes to contentId', () => {
    const result = v.validateOps([{ op: 'replace', path: '/contentId', value: 'x' }]);
    assert.equal(result.ok, false);
  });

  it('rejects unknown ops (move/copy/test)', () => {
    const result = v.validateOps([{ op: 'move', from: '/angle', path: '/thesis' }]);
    assert.equal(result.ok, false);
  });

  it('rejects malformed ops', () => {
    const r1 = v.validateOps([{ op: 'replace', path: 'angle', value: 'x' }]); // no leading /
    assert.equal(r1.ok, false);
    const r2 = v.validateOps([{ op: 'replace', path: '/angle' }]); // missing value
    assert.equal(r2.ok, false);
    const r3 = v.validateOps('not an array');
    assert.equal(r3.ok, false);
  });

  it('rejects writes through unknown evidenceMap key shapes', () => {
    // Map key with spaces is rejected by our [A-Za-z0-9_-]+ regex
    const result = v.validateOps([{ op: 'add', path: '/evidenceMap/with spaces', value: [] }]);
    assert.equal(result.ok, false);
  });
});

// ─── Citation match policy ────────────────────────────────────────────

describe('normalizeForQuoteMatch', () => {
  it('collapses runs of whitespace', () => {
    assert.equal(v.normalizeForQuoteMatch('a   b\t\tc'), 'a b c');
  });
  it('trims ends', () => {
    assert.equal(v.normalizeForQuoteMatch('  hello  '), 'hello');
  });
  it('preserves case', () => {
    assert.equal(v.normalizeForQuoteMatch('Hello World'), 'Hello World');
  });
});

describe('matchQuote', () => {
  it('matches exact substring after normalization', () => {
    assert.equal(v.matchQuote('the agent reads', 'In plan mode, the agent reads files.'), true);
  });
  it('matches across whitespace differences', () => {
    assert.equal(v.matchQuote('the agent reads', 'In plan mode, the   agent\n  reads files.'), true);
  });
  it('rejects case mismatches', () => {
    assert.equal(v.matchQuote('The Agent', 'the agent reads'), false);
  });
  it('rejects when quote is absent', () => {
    assert.equal(v.matchQuote('the agent writes', 'the agent reads'), false);
  });
  it('rejects empty quote or body', () => {
    assert.equal(v.matchQuote('', 'anything'), false);
    assert.equal(v.matchQuote('something', ''), false);
  });
});

describe('matchAnchor', () => {
  const fm = { anchors_version: 2, anchors: [{ id: 'headings' }, { id: 'key-claims' }] };
  it('matches when anchor id and anchors_version both match', () => {
    assert.equal(v.matchAnchor('headings', 2, fm), true);
  });
  it('rejects when anchors_version mismatches', () => {
    assert.equal(v.matchAnchor('headings', 1, fm), false);
  });
  it('rejects when anchor id is absent', () => {
    assert.equal(v.matchAnchor('nope', 2, fm), false);
  });
  it('rejects when frontmatter has no anchors', () => {
    assert.equal(v.matchAnchor('headings', 2, { anchors_version: 2 }), false);
  });
});

describe('resolveRef', () => {
  const file = {
    frontmatter: { anchors_version: 2, anchors: [{ id: 'pricing' }] },
    body: 'Notion charges per seat after the free tier.',
  };
  it('resolves via anchor when anchor matches', () => {
    const result = v.resolveRef({ anchor: 'pricing', anchorsVersion: 2, reason: 'r' }, file);
    assert.equal(result.ok, true);
  });
  it('resolves via quote when quote matches', () => {
    const result = v.resolveRef({ quote: 'charges per seat', reason: 'r' }, file);
    assert.equal(result.ok, true);
  });
  it('resolves when EITHER anchor or quote matches (quote falls back when anchor fails)', () => {
    const result = v.resolveRef(
      { anchor: 'nope', anchorsVersion: 2, quote: 'charges per seat', reason: 'r' },
      file
    );
    assert.equal(result.ok, true);
  });
  it('fails when neither matches', () => {
    const result = v.resolveRef({ anchor: 'nope', anchorsVersion: 2, quote: 'absent text', reason: 'r' }, file);
    assert.equal(result.ok, false);
  });
  it('fails when ref has neither anchor nor quote', () => {
    const result = v.resolveRef({ reason: 'r' }, file);
    assert.equal(result.ok, false);
  });
});
