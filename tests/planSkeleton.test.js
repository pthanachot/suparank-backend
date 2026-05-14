const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildSkeleton, buildValidatorBrief, deepClone } = require('../src/services/planSkeleton');

const fakeContent = {
  _id: 'content-id',
  workspaceId: 'ws-id',
  contentNumber: 42,
  targetWordCount: 1500,
};

describe('buildSkeleton — basic', () => {
  it('produces a draft at the requested version with content scoping', () => {
    const s = buildSkeleton({ content: fakeContent, version: 3 });
    assert.equal(s.contentId, 'content-id');
    assert.equal(s.workspaceId, 'ws-id');
    assert.equal(s.contentNumber, 42);
    assert.equal(s.version, 3);
    assert.equal(s.parentVersion, null);
    assert.equal(s.status, 'draft');
    assert.equal(s.wordBudget, 1500);
    assert.deepEqual(s.sections, []);
    assert.deepEqual(s.evidenceMap, {});
    assert.deepEqual(s.alternatives, []);
    assert.deepEqual(s.risks, []);
    assert.deepEqual(s.openQuestions, []);
  });

  it('records parentVersion when given', () => {
    const s = buildSkeleton({ content: fakeContent, version: 4, parentVersion: 3 });
    assert.equal(s.parentVersion, 3);
  });

  it('defaults wordBudget to 0 when content has no targetWordCount', () => {
    const s = buildSkeleton({ content: { _id: 'c', workspaceId: 'w', contentNumber: 1 }, version: 1 });
    assert.equal(s.wordBudget, 0);
  });
});

describe('buildSkeleton — carry-forward (Bug 2 fix)', () => {
  const prior = {
    targetAudience: 'Early-stage SaaS founders',
    angle: 'Framework-agnostic comparison',
    thesis: 'Choose by company stage',
    differentiation: [
      { competitorPath: '/competitors/notion.com.md', gap: 'No pricing depth', ourMove: 'Add pricing tier table' },
    ],
    sections: [
      {
        id: 'intro',
        heading: 'Introduction',
        headingLevel: 2,
        keyPoints: [{ text: 'Frame problem', evidence: [{ path: '/keywords/primary.md', reason: 'target' }] }],
        wordTarget: 200,
      },
    ],
    wordBudget: 1500,
    evidenceMap: {
      intro: [{ path: '/keywords/primary.md', anchor: 'primary', anchorsVersion: 2, reason: 'target keyword' }],
    },
    alternatives: [
      { label: 'Lead with comparison', pros: ['fast'], cons: ['shallow'], chosen: false, reason: '' },
      { label: 'Lead with use cases', pros: ['relevant'], cons: ['slower'], chosen: true, reason: 'audience' },
    ],
    risks: [{ description: 'competitor X overlaps', mitigation: 'differentiate via UC', severity: 'medium' }],
    openQuestions: [{ id: 'q1', question: 'target country?', blocking: true, answer: '' }],
    sources: [{ url: 'https://example.com', title: 'Source', snippet: 's', stance: 'supports' }],
  };

  it('preserves strategic frame', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, parentVersion: 1, carryFrom: prior });
    assert.equal(s.targetAudience, prior.targetAudience);
    assert.equal(s.angle, prior.angle);
    assert.equal(s.thesis, prior.thesis);
  });

  it('preserves differentiation with detached clones', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, carryFrom: prior });
    assert.equal(s.differentiation.length, 1);
    assert.equal(s.differentiation[0].competitorPath, prior.differentiation[0].competitorPath);
    // Edits to the new plan should not bleed back
    s.differentiation[0].gap = 'CHANGED';
    assert.equal(prior.differentiation[0].gap, 'No pricing depth');
  });

  it('preserves sections + word target', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, carryFrom: prior });
    assert.equal(s.sections.length, 1);
    assert.equal(s.sections[0].id, 'intro');
    assert.equal(s.sections[0].wordTarget, 200);
  });

  it('preserves evidenceMap (Bug 2 — the regression case)', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, carryFrom: prior });
    assert.deepEqual(s.evidenceMap, prior.evidenceMap);
    // Detached: mutating new shouldn't affect prior
    s.evidenceMap.intro.push({ path: '/x.md', reason: 'new' });
    assert.equal(prior.evidenceMap.intro.length, 1);
  });

  it('preserves alternatives (with chosen + reason)', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, carryFrom: prior });
    assert.equal(s.alternatives.length, 2);
    const chosen = s.alternatives.find((a) => a.chosen);
    assert.ok(chosen);
    assert.equal(chosen.reason, 'audience');
  });

  it('preserves risks and open questions', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, carryFrom: prior });
    assert.equal(s.risks.length, 1);
    assert.equal(s.openQuestions.length, 1);
    assert.equal(s.openQuestions[0].id, 'q1');
  });

  it('preserves sources', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, carryFrom: prior });
    assert.equal(s.sources.length, 1);
    assert.equal(s.sources[0].url, 'https://example.com');
  });

  it('without carryFrom, all deliberative + evidentiary fields are empty (clean-slate)', () => {
    const s = buildSkeleton({ content: fakeContent, version: 2, parentVersion: 1, carryFrom: null });
    assert.equal(s.targetAudience, '');
    assert.equal(s.angle, '');
    assert.equal(s.thesis, '');
    assert.deepEqual(s.differentiation, []);
    assert.deepEqual(s.sections, []);
    assert.deepEqual(s.evidenceMap, {});
    assert.deepEqual(s.alternatives, []);
    assert.deepEqual(s.risks, []);
    assert.deepEqual(s.openQuestions, []);
    assert.deepEqual(s.sources, []);
  });
});

describe('buildValidatorBrief (Bug #3 fix)', () => {
  it('returns null for null content', () => {
    assert.equal(buildValidatorBrief(null), null);
  });
  it('pulls targetWordCount from Content top-level (not contentBrief)', () => {
    const content = {
      targetWordCount: 1500,
      benchmark: { subtopics: [{ label: 'pricing' }, { label: 'features' }] },
      contentBrief: { keyword: 'irrelevant', archetype: 'guide' }, // wrong shape
    };
    const brief = buildValidatorBrief(content);
    assert.equal(brief.targetWordCount, 1500);
    assert.equal(brief.subtopics.length, 2);
  });
  it('defaults targetWordCount to 0 when missing', () => {
    const brief = buildValidatorBrief({ benchmark: {} });
    assert.equal(brief.targetWordCount, 0);
  });
  it('defaults subtopics to empty array when missing', () => {
    const brief = buildValidatorBrief({ targetWordCount: 1000 });
    assert.deepEqual(brief.subtopics, []);
  });
  it('handles non-array subtopics defensively', () => {
    const brief = buildValidatorBrief({
      targetWordCount: 1000,
      benchmark: { subtopics: 'not an array' },
    });
    assert.deepEqual(brief.subtopics, []);
  });
});

describe('buildValidatorBrief end-to-end with validateCompleteness (Bug #3 regression test)', () => {
  // This is the contract that bug #3 violated: a plan with sections summing
  // to a wildly different word count from content.targetWordCount must FAIL
  // the validator. Before fix #3, validator was fed content.contentBrief
  // (which has no targetWordCount field) and the word-budget rule never fired.
  const planValidator = require('../src/services/planValidator');

  function planWith3Sections(wordTargets) {
    return {
      targetAudience: 'a',
      angle: 'b',
      thesis: 'c',
      alternatives: [
        { label: 'A', chosen: false, reason: '' },
        { label: 'B', chosen: true, reason: 'because' },
      ],
      risks: [{ description: 'r', mitigation: 'm', severity: 'low' }],
      sections: wordTargets.map((wt, i) => ({
        id: `s${i + 1}`,
        heading: `Section ${i + 1}`,
        headingLevel: 2,
        keyPoints: [{ text: 'kp', evidence: [{ path: '/k.md', reason: 'r' }] }],
        wordTarget: wt,
      })),
    };
  }

  it('FAILS approval when section budgets are wildly off from content target', () => {
    const content = { targetWordCount: 1500, benchmark: {} };
    const brief = buildValidatorBrief(content);
    // 3 sections of 5000 each = 15000, vs target 1500 (10x off)
    const plan = planWith3Sections([5000, 5000, 5000]);
    const result = planValidator.validateCompleteness(plan, brief);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.rule === 'wordBudget'),
      'Expected wordBudget failure, got: ' + JSON.stringify(result.failures));
  });

  it('PASSES when section budgets are within 10% of content target', () => {
    const content = { targetWordCount: 1500, benchmark: {} };
    const brief = buildValidatorBrief(content);
    const plan = planWith3Sections([500, 500, 500]); // sums to 1500
    const result = planValidator.validateCompleteness(plan, brief);
    assert.equal(result.ok, true, JSON.stringify(result.failures));
  });

  it('demonstrates the bug: feeding content.contentBrief (wrong shape) bypasses word-budget check', () => {
    // This is the EXACT bug that #3 fixes. Without buildValidatorBrief, the
    // controller passed content.contentBrief which doesn't have targetWordCount.
    const wrongBrief = { keyword: 'x', archetype: 'guide', terms: [] }; // curateContentBrief shape
    const plan = planWith3Sections([5000, 5000, 5000]); // way off target
    const result = planValidator.validateCompleteness(plan, wrongBrief);
    // Without targetWordCount in brief, wordBudget check is skipped — bug.
    const hasWordBudgetFailure = result.failures.some((f) => f.rule === 'wordBudget');
    assert.equal(hasWordBudgetFailure, false,
      'This test documents the buggy behavior: word-budget check is silently skipped when brief lacks targetWordCount');
  });
});

describe('deepClone', () => {
  it('clones POJOs', () => {
    const src = { a: 1, nested: { b: 2 } };
    const out = deepClone(src);
    out.nested.b = 99;
    assert.equal(src.nested.b, 2);
  });
  it('returns null/undefined unchanged', () => {
    assert.equal(deepClone(null), null);
    assert.equal(deepClone(undefined), undefined);
  });
  it('uses toObject() when present (Mongoose subdoc-style)', () => {
    const src = { toObject: () => ({ a: 1 }) };
    const out = deepClone(src);
    assert.deepEqual(out, { a: 1 });
    assert.equal(typeof out.toObject, 'undefined');
  });
});
