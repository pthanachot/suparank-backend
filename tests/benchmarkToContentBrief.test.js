const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { benchmarkToContentBrief } = require('../src/services/benchmarkToContentBrief');

describe('benchmarkToContentBrief - section allocation (Phase 2 / Task #99)', () => {
  it('tags NLP terms with recommendedSection from topic clusters', () => {
    const content = {
      _id: 'x',
      targetKeywords: ['lighter packs'],
      benchmark: {
        keywords: ['lighter packs'],
        topNlpTerms: [
          { term: 'hikers', usageRange: { min: 1, max: 5 }, category: 'nlp' },
          { term: 'weight', usageRange: { min: 2, max: 6 }, category: 'nlp' },
          { term: 'standalone', usageRange: { min: 1, max: 3 }, category: 'nlp' },
        ],
        topicClusters: [
          { topic: 'Audience', terms: ['hikers', 'backpackers'] },
          { label: 'Core Concepts', terms: ['weight', 'pack'] },
        ],
      },
    };
    const brief = benchmarkToContentBrief(content);
    const bySomeTerm = Object.fromEntries(
      brief.nlpTerms.map((t) => [t.term, t.recommendedSection]),
    );
    assert.equal(bySomeTerm['hikers'], 'Audience');
    assert.equal(bySomeTerm['weight'], 'Core Concepts');
    assert.equal(bySomeTerm['standalone'], '');
  });

  it('handles missing topicClusters (degrades to all-empty recommendedSection)', () => {
    const content = {
      _id: 'x',
      targetKeywords: ['k'],
      benchmark: {
        keywords: ['k'],
        topNlpTerms: [{ term: 'foo', usageRange: { min: 1, max: 5 } }],
        // topicClusters omitted
      },
    };
    const brief = benchmarkToContentBrief(content);
    assert.equal(brief.nlpTerms.length, 1);
    assert.equal(brief.nlpTerms[0].recommendedSection, '');
  });

  it('case-insensitive cluster matching (term casing varies between sources)', () => {
    const content = {
      _id: 'x',
      targetKeywords: ['k'],
      benchmark: {
        keywords: ['k'],
        topNlpTerms: [{ term: 'Hikers', usageRange: { min: 1, max: 5 } }],
        topicClusters: [{ topic: 'Audience', terms: ['HIKERS'] }],
      },
    };
    const brief = benchmarkToContentBrief(content);
    assert.equal(brief.nlpTerms[0].recommendedSection, 'Audience');
  });

  it('first cluster wins when a term appears in multiple', () => {
    const content = {
      _id: 'x',
      targetKeywords: ['k'],
      benchmark: {
        keywords: ['k'],
        topNlpTerms: [{ term: 'weight', usageRange: { min: 1, max: 5 } }],
        topicClusters: [
          { topic: 'Core', terms: ['weight'] },
          { topic: 'Secondary', terms: ['weight'] },
        ],
      },
    };
    const brief = benchmarkToContentBrief(content);
    assert.equal(brief.nlpTerms[0].recommendedSection, 'Core');
  });

  it('skips clusters with empty label', () => {
    const content = {
      _id: 'x',
      targetKeywords: ['k'],
      benchmark: {
        keywords: ['k'],
        topNlpTerms: [{ term: 'foo', usageRange: { min: 1, max: 5 } }],
        topicClusters: [
          { topic: '', terms: ['foo'] }, // empty label, should be ignored
        ],
      },
    };
    const brief = benchmarkToContentBrief(content);
    assert.equal(brief.nlpTerms[0].recommendedSection, '');
  });
});

describe('benchmarkToContentBrief - applied GSC queries (Rec 15)', () => {
  const base = {
    _id: 'x',
    targetKeywords: ['best crm software', 'crm tools'],
    benchmark: { keywords: ['best crm software', 'crm tools'], topNlpTerms: [] },
  };

  it('absent appliedGscQueries → secondaryKeywords unchanged (regression)', () => {
    const brief = benchmarkToContentBrief({ ...base });
    assert.deepEqual(brief.secondaryKeywords, ['crm tools']);
  });

  it('merges applied queries into secondaryKeywords, deduped case-insensitively', () => {
    const brief = benchmarkToContentBrief({
      ...base,
      appliedGscQueries: ['crm pricing', 'CRM TOOLS', 'free crm'],
    });
    // 'CRM TOOLS' already present (case-insensitive) → not duplicated.
    assert.deepEqual(brief.secondaryKeywords, ['crm tools', 'crm pricing', 'free crm']);
  });

  it('caps applied additions at 5', () => {
    const brief = benchmarkToContentBrief({
      ...base,
      appliedGscQueries: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'],
    });
    // 1 existing secondary + 5 applied (q6/q7 dropped).
    assert.deepEqual(brief.secondaryKeywords, ['crm tools', 'q1', 'q2', 'q3', 'q4', 'q5']);
  });

  it('ignores empty/falsy applied entries', () => {
    const brief = benchmarkToContentBrief({ ...base, appliedGscQueries: ['', null, 'real q'] });
    assert.deepEqual(brief.secondaryKeywords, ['crm tools', 'real q']);
  });
});

describe('benchmarkToContentBrief - AI answer analysis (R5, AEO/citability)', () => {
  const base = { _id: 'x', targetKeywords: ['how to compost'], benchmark: {} };

  it('omits (null) when content has no aiAnswerAnalysis', () => {
    const brief = benchmarkToContentBrief({ ...base });
    assert.equal(brief.aiAnswerAnalysis, null);
  });

  it('carries aiAnswerAnalysis through verbatim, preserving snake_case inner keys', () => {
    const analysis = {
      query_groups: [
        {
          parent_prompt: 'How do I start composting?',
          parent_answer: 'Layer greens and browns.',
          fanouts: [{ query: 'what goes in compost', answer: 'scraps, leaves', engine: 'perplexity' }],
          nlp_phrases: [
            { phrase: 'browns and greens', type: 'definition', recurring: true, format: 'bold_definition' },
          ],
          answer_format: 'bold_definition',
        },
      ],
      recurring_concepts: [{ phrase: 'browns and greens', seen_in: 3, format: 'bold_definition' }],
      dominant_format: 'bold_definition',
    };
    const brief = benchmarkToContentBrief({ ...base, aiAnswerAnalysis: analysis });
    // Byte-equal passthrough — the engine's citability port and the frontend
    // ring both consume this exact shape, so no key transformation is allowed.
    assert.deepEqual(brief.aiAnswerAnalysis, analysis);
    // Guard the specific snake_case keys the port depends on.
    assert.equal(brief.aiAnswerAnalysis.query_groups[0].nlp_phrases[0].phrase, 'browns and greens');
    assert.equal(brief.aiAnswerAnalysis.recurring_concepts[0].seen_in, 3);
  });

  it('does not deep-copy — passes the same reference (no accidental transform)', () => {
    const analysis = { query_groups: [], recurring_concepts: [], dominant_format: 'plain' };
    const brief = benchmarkToContentBrief({ ...base, aiAnswerAnalysis: analysis });
    assert.equal(brief.aiAnswerAnalysis, analysis);
  });
});
