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
