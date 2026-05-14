const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const contextFs = require('../src/services/contextFs');
const router = require('../src/services/contextFs/router');
const slug = require('../src/services/contextFs/slug');

// ─── Fixtures ────────────────────────────────────────────────────────

function makeContent(overrides = {}) {
  return {
    _id: 'cid',
    workspaceId: 'wid',
    contentNumber: 42,
    title: 'Best SaaS Onboarding Tools 2026',
    description: 'How to pick the right onboarding platform',
    targetKeywords: ['saas onboarding tools', 'user activation', 'product tours'],
    country: 'US',
    device: 'desktop',
    targetWordCount: 1800,
    wordCount: 0,
    score: 0,
    blocks: [],
    competitors: [
      { url: 'https://notion.com/blog/onboarding', title: 'Notion onboarding', position: 1, selected: true, keywords: ['onboarding', 'saas'] },
      { url: 'https://intercom.com/onboarding', title: 'Intercom guide', position: 3, selected: true, keywords: ['intercom', 'in-app'] },
    ],
    benchmark: {
      avgKeywordDensity: 0.012,
      subtopics: [
        { label: 'pricing tiers', docFrequency: 7, docPercent: 0.875 },
        { label: 'in-app guides', docFrequency: 5, docPercent: 0.625 },
        { label: 'video walkthroughs', docFrequency: 2, docPercent: 0.25 },
      ],
      topNlpTerms: [
        { term: 'onboarding flow', category: 'headings', count: 12, usageRange: { min: 1, recommended: 2, max: 4 } },
        { term: 'activation rate', category: 'nlp', count: 8, usageRange: { min: 2, recommended: 4, max: 6 } },
      ],
    },
    audits: [],
    peopleAlsoAsk: [{ question: 'What is SaaS onboarding?' }],
    mode: 'chat',
    activePlanId: null,
    ...overrides,
  };
}

const emptyPlanContext = { draft: null, proposed: null, approved: null, activePlan: null, history: [], historyCount: 0 };

// ─── slug ────────────────────────────────────────────────────────────

describe('slug helpers', () => {
  it('slugify lowercases + dashifies + strips junk', () => {
    assert.equal(slug.slugify('Hello World!'), 'hello-world');
    assert.equal(slug.slugify('  Spaces  Trimmed  '), 'spaces-trimmed');
  });
  it('competitorSlug uses host without www', () => {
    assert.equal(slug.competitorSlug({ url: 'https://www.notion.com/x' }), 'notion.com');
    assert.equal(slug.competitorSlug({ url: 'https://example.io/page' }), 'example.io');
  });
  it('competitorSlug falls back to title slug if URL invalid', () => {
    assert.equal(slug.competitorSlug({ url: 'not a url', title: 'My Competitor' }), 'my-competitor');
  });
  it('subtopicSlug uses label', () => {
    assert.equal(slug.subtopicSlug({ label: 'Pricing Tiers' }), 'pricing-tiers');
  });
});

// ─── slug collisions (Bug 9 fix) ─────────────────────────────────────

describe('slug.assignUniqueSlugs', () => {
  it('keeps base slug for first occurrence and suffixes subsequent', () => {
    const items = [{ x: 'a' }, { x: 'a' }, { x: 'a' }, { x: 'b' }];
    const out = slug.assignUniqueSlugs(items, (i) => i.x);
    assert.deepEqual(out.map((e) => e.slug), ['a', 'a-2', 'a-3', 'b']);
  });
  it('preserves item order', () => {
    const items = [{ id: 1, x: 'a' }, { id: 2, x: 'a' }];
    const out = slug.assignUniqueSlugs(items, (i) => i.x);
    assert.equal(out[0].item.id, 1);
    assert.equal(out[1].item.id, 2);
  });
  it('returns null slug for items whose slugFn returns falsy', () => {
    const out = slug.assignUniqueSlugs([{ x: '' }, { x: 'a' }], (i) => i.x);
    assert.equal(out[0].slug, null);
    assert.equal(out[1].slug, 'a');
  });
  it('returns [] for non-array input', () => {
    assert.deepEqual(slug.assignUniqueSlugs(null, () => 'x'), []);
  });

  // Bug 1 from M2 second-round review: the count-based algorithm produced
  // `[notion, notion-2, notion-2]` for input `[notion, notion, notion-2]`
  // because the synthesized -2 collided with a naturally-occurring slug.
  it('does not collide synthesized suffix with naturally-occurring slug', () => {
    const items = [{ x: 'notion' }, { x: 'notion' }, { x: 'notion-2' }];
    const out = slug.assignUniqueSlugs(items, (i) => i.x);
    const slugs = out.map((e) => e.slug);
    assert.equal(new Set(slugs).size, 3, 'all slugs must be distinct: ' + JSON.stringify(slugs));
    assert.deepEqual(slugs, ['notion', 'notion-2', 'notion-2-2']);
  });

  it('handles chains of naturally-suffixed collisions', () => {
    const items = [
      { x: 'foo' },     // 'foo'
      { x: 'foo-2' },   // 'foo-2' would conflict with next iteration's synthesized
      { x: 'foo' },     // wants 'foo-2' but taken, gets 'foo-3'
      { x: 'foo-3' },   // wants 'foo-3' but taken, gets 'foo-3-2'
    ];
    const out = slug.assignUniqueSlugs(items, (i) => i.x);
    const slugs = out.map((e) => e.slug);
    assert.equal(new Set(slugs).size, 4);
  });
});

describe('Bug 9: slug collisions in CFS paths', () => {
  it('two competitors sharing a hostname both reachable', () => {
    const content = makeContent({
      competitors: [
        { url: 'https://notion.com/a', title: 'Notion A', selected: true, keywords: [] },
        { url: 'https://notion.com/b', title: 'Notion B', selected: true, keywords: [] },
      ],
    });
    const entries = contextFs.list(content, emptyPlanContext, '/competitors');
    const paths = entries.map((e) => e.path);
    assert.ok(paths.includes('/competitors/notion.com.md'));
    assert.ok(paths.includes('/competitors/notion.com-2.md'),
      'Second competitor with same host must get a suffixed slug — paths: ' + paths.join(', '));

    const r1 = contextFs.read(content, emptyPlanContext, '/competitors/notion.com.md');
    assert.ok(r1.body.includes('Notion A'));
    const r2 = contextFs.read(content, emptyPlanContext, '/competitors/notion.com-2.md');
    assert.ok(r2.body.includes('Notion B'),
      'Second competitor must be readable at the suffixed path');
  });

  // Bug 2 from M2 second-round review: the path was disambiguated but the
  // frontmatter id field still used the base slug — collided competitors
  // ended up with the same id, breaking citation-by-id resolution.
  it('two competitors sharing a hostname have DISTINCT frontmatter ids', () => {
    const content = makeContent({
      competitors: [
        { url: 'https://notion.com/a', title: 'Notion A', selected: true, keywords: [] },
        { url: 'https://notion.com/b', title: 'Notion B', selected: true, keywords: [] },
      ],
    });
    const r1 = contextFs.read(content, emptyPlanContext, '/competitors/notion.com.md');
    const r2 = contextFs.read(content, emptyPlanContext, '/competitors/notion.com-2.md');
    assert.notEqual(r1.frontmatter.id, r2.frontmatter.id,
      'Collided competitors must have distinct frontmatter ids; got: ' + r1.frontmatter.id + ' and ' + r2.frontmatter.id);
    assert.equal(r1.frontmatter.id, 'competitor-notion.com');
    assert.equal(r2.frontmatter.id, 'competitor-notion.com-2');
  });

  it('two subtopics sharing a label have distinct frontmatter ids', () => {
    const content = makeContent({
      benchmark: {
        subtopics: [
          { label: 'Pricing Tiers', docFrequency: 5, docPercent: 0.5 },
          { label: 'Pricing Tiers', docFrequency: 3, docPercent: 0.3 },
        ],
      },
    });
    const r1 = contextFs.read(content, emptyPlanContext, '/subtopics/pricing-tiers.md');
    const r2 = contextFs.read(content, emptyPlanContext, '/subtopics/pricing-tiers-2.md');
    assert.notEqual(r1.frontmatter.id, r2.frontmatter.id);
  });

  it('two draft sections with identical heading text have distinct frontmatter ids', () => {
    const content = makeContent({
      blocks: [
        { id: 'b1', type: 'h2', text: 'Conclusion' },
        { id: 'b2', type: 'p', text: 'first conclusion' },
        { id: 'b3', type: 'h2', text: 'Conclusion' },
        { id: 'b4', type: 'p', text: 'second conclusion' },
      ],
    });
    const r1 = contextFs.read(content, emptyPlanContext, '/draft/sections/conclusion.md');
    const r2 = contextFs.read(content, emptyPlanContext, '/draft/sections/conclusion-2.md');
    assert.ok(r1, 'first conclusion section should be readable');
    assert.ok(r2, 'second conclusion section should be readable');
    assert.notEqual(r1.frontmatter.id, r2.frontmatter.id);
  });

  it('two subtopics with same label both reachable', () => {
    const content = makeContent({
      benchmark: {
        subtopics: [
          { label: 'Pricing Tiers', docFrequency: 5, docPercent: 0.5 },
          { label: 'Pricing Tiers', docFrequency: 3, docPercent: 0.3 },
        ],
      },
    });
    const entries = contextFs.list(content, emptyPlanContext, '/subtopics');
    const paths = entries.map((e) => e.path);
    assert.ok(paths.includes('/subtopics/pricing-tiers.md'));
    assert.ok(paths.includes('/subtopics/pricing-tiers-2.md'));
  });
});

// ─── h1/h3 section splitting (Spec #6 fix) ──────────────────────────

describe('Spec #6: section splitting respects h1/h2/h3', () => {
  const { splitIntoSections } = require('../src/services/contextFs/generators');

  it('starts a section on h1', () => {
    const sections = splitIntoSections([
      { id: 'b1', type: 'h1', text: 'Title' },
      { id: 'b2', type: 'p', text: 'Intro paragraph' },
    ]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, 'Title');
    assert.equal(sections[0].level, 1);
  });

  it('starts a section on h2', () => {
    const sections = splitIntoSections([
      { id: 'b1', type: 'h2', text: 'Subsection' },
      { id: 'b2', type: 'p', text: 'Body' },
    ]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].level, 2);
  });

  it('starts a section on h3', () => {
    const sections = splitIntoSections([
      { id: 'b1', type: 'h3', text: 'Sub-sub' },
      { id: 'b2', type: 'p', text: 'Body' },
    ]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].level, 3);
  });

  it('document with h1 then h3-only still produces sections', () => {
    // Regression: previously h2-only splitting produced 0 sections here
    const sections = splitIntoSections([
      { id: 'b1', type: 'h1', text: 'Main' },
      { id: 'b2', type: 'p', text: 'intro' },
      { id: 'b3', type: 'h3', text: 'A' },
      { id: 'b4', type: 'p', text: 'a-body' },
      { id: 'b5', type: 'h3', text: 'B' },
      { id: 'b6', type: 'p', text: 'b-body' },
    ]);
    assert.equal(sections.length, 3);
    assert.deepEqual(sections.map((s) => s.heading), ['Main', 'A', 'B']);
  });

  it('h4+ does not start a new section', () => {
    const sections = splitIntoSections([
      { id: 'b1', type: 'h2', text: 'Section' },
      { id: 'b2', type: 'h4', text: 'Deep' },
      { id: 'b3', type: 'p', text: 'body' },
    ]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].blocks.length, 2); // h4 + p both inside section
  });
});

// ─── INDEX prior-plan uses max version, not count (Bug 2 fix) ───────

describe('Bug 2: INDEX prior-plan link uses max version', () => {
  it('points at /plans/history/v-{latestHistoricalVersion}.md', () => {
    const planCtx = {
      ...emptyPlanContext,
      historyCount: 2,
      latestHistoricalVersion: 5,  // sparse — versions 1 and 5, not 1 and 2
      history: [{ version: 5 }, { version: 1 }],
    };
    const idx = contextFs.read(makeContent(), planCtx, '/INDEX.md');
    assert.ok(idx.body.includes('/plans/history/v-5.md'),
      'INDEX should link to v-5, not v-' + planCtx.historyCount);
    assert.ok(!idx.body.includes('/plans/history/v-2.md'),
      'INDEX must NOT mistakenly link to v-' + planCtx.historyCount);
  });

  it('falls back gracefully when no history exists', () => {
    const idx = contextFs.read(makeContent(), emptyPlanContext, '/INDEX.md');
    assert.ok(!idx.body.includes('/plans/history/'),
      'No prior-plan link when historyCount = 0');
  });
});

// ─── grep truncation (Spec #5 fix) ──────────────────────────────────

describe('Spec #5: grep returns truncated indicator', () => {
  it('returns {results, truncated: false} on normal scan', () => {
    const out = contextFs.grep(makeContent(), emptyPlanContext, 'onboarding');
    assert.ok(Array.isArray(out.results));
    assert.equal(out.truncated, false);
  });
  it('returns {results: [], truncated: false} for empty pattern', () => {
    const out = contextFs.grep(makeContent(), emptyPlanContext, '');
    assert.deepEqual(out.results, []);
    assert.equal(out.truncated, false);
  });
});

// ─── router.resolve ─────────────────────────────────────────────────

describe('router.resolve', () => {
  it('resolves exact paths', () => {
    assert.ok(router.resolve('/INDEX.md'));
    assert.ok(router.resolve('/keywords/primary.md'));
    assert.ok(router.resolve('/draft/outline.md'));
    assert.ok(router.resolve('/plans/active.md'));
  });
  it('resolves glob paths with params', () => {
    const r = router.resolve('/competitors/notion.com.md');
    assert.ok(r);
    assert.equal(r.params.slug, 'notion.com');
  });
  it('resolves plan history with version param', () => {
    const r = router.resolve('/plans/history/v-3.md');
    assert.ok(r);
    assert.equal(r.params.version, 'v-3');
  });
  it('returns null for unknown paths', () => {
    assert.equal(router.resolve('/garbage'), null);
    assert.equal(router.resolve('/competitors/'), null);
    assert.equal(router.resolve('foo'), null);
    assert.equal(router.resolve(''), null);
  });
});

// ─── router.list ─────────────────────────────────────────────────────

describe('router.list', () => {
  it('returns root entries for empty prefix', () => {
    const entries = contextFs.list(makeContent(), emptyPlanContext);
    assert.ok(entries.length > 5);
    const paths = entries.map((e) => e.path);
    assert.ok(paths.includes('/INDEX.md'));
    assert.ok(paths.includes('/keywords/primary.md'));
    assert.ok(paths.includes('/plans/active.md'));
  });
  it('lists secondary keywords for each non-primary target', () => {
    const entries = contextFs.list(makeContent(), emptyPlanContext);
    const secondary = entries.filter((e) => e.path.startsWith('/keywords/secondary/'));
    assert.equal(secondary.length, 2);
  });
  it('lists each competitor', () => {
    const entries = contextFs.list(makeContent(), emptyPlanContext);
    const competitors = entries.filter((e) => e.path.startsWith('/competitors/'));
    assert.equal(competitors.length, 2);
    assert.ok(competitors.some((e) => e.path === '/competitors/notion.com.md'));
  });
  it('lists each subtopic', () => {
    const entries = contextFs.list(makeContent(), emptyPlanContext);
    const subtopics = entries.filter((e) => e.path.startsWith('/subtopics/'));
    assert.equal(subtopics.length, 3);
  });
  it('filters by prefix', () => {
    const entries = contextFs.list(makeContent(), emptyPlanContext, '/competitors');
    assert.ok(entries.every((e) => e.path.startsWith('/competitors/')));
  });
  it('sorts deterministically by priority then path', () => {
    const entries = contextFs.list(makeContent(), emptyPlanContext);
    // INDEX (priority 0) always first
    assert.equal(entries[0].path, '/INDEX.md');
  });
});

// ─── INDEX.md is context-aware ──────────────────────────────────────

describe('INDEX.md adapts to state', () => {
  it('first reading-order item is keywords when no prior plan and no draft', () => {
    const idx = contextFs.read(makeContent(), emptyPlanContext, '/INDEX.md');
    const ordering = idx.body.split('Suggested reading order')[1] || '';
    const firstNum = ordering.split('\n').find((l) => /^\d+\./.test(l.trim())) || '';
    assert.ok(firstNum.includes('/keywords/'));
  });
  it('puts prior plan first when latestHistoricalVersion > 0', () => {
    const planCtx = {
      ...emptyPlanContext,
      historyCount: 2,
      latestHistoricalVersion: 2,
      history: [{ version: 1 }, { version: 2 }],
    };
    const idx = contextFs.read(makeContent(), planCtx, '/INDEX.md');
    const ordering = idx.body.split('Suggested reading order')[1] || '';
    const firstNum = ordering.split('\n').find((l) => /^\d+\./.test(l.trim())) || '';
    assert.ok(firstNum.includes('/plans/history/'));
  });
  it('puts draft first when content has draft blocks', () => {
    const content = makeContent({
      blocks: [
        { id: 'b1', type: 'h1', text: 'Title' },
        { id: 'b2', type: 'h2', text: 'Intro' },
        { id: 'b3', type: 'p', text: 'First paragraph.' },
      ],
      wordCount: 50,
    });
    const idx = contextFs.read(content, emptyPlanContext, '/INDEX.md');
    const ordering = idx.body.split('Suggested reading order')[1] || '';
    const firstNum = ordering.split('\n').find((l) => /^\d+\./.test(l.trim())) || '';
    assert.ok(firstNum.includes('/draft/'));
  });
});

// ─── read ────────────────────────────────────────────────────────────

describe('contextFs.read', () => {
  it('returns null for unknown path', () => {
    assert.equal(contextFs.read(makeContent(), emptyPlanContext, '/nope.md'), null);
  });

  it('returns frontmatter + body + raw for a known path', () => {
    const r = contextFs.read(makeContent(), emptyPlanContext, '/INDEX.md');
    assert.ok(r);
    assert.equal(r.frontmatter.type, 'index');
    assert.equal(r.frontmatter.anchors_version, 1);
    assert.ok(Array.isArray(r.frontmatter.anchors));
    assert.ok(r.body.length > 0);
    assert.ok(r.raw.startsWith('---\n'));
  });

  it('reads a competitor file', () => {
    const r = contextFs.read(makeContent(), emptyPlanContext, '/competitors/notion.com.md');
    assert.ok(r);
    assert.equal(r.frontmatter.type, 'competitor');
    assert.ok(r.body.includes('Notion onboarding'));
  });

  it('respects offset + limit', () => {
    const full = contextFs.read(makeContent(), emptyPlanContext, '/INDEX.md', { offset: 0, limit: 100000 });
    const sliced = contextFs.read(makeContent(), emptyPlanContext, '/INDEX.md', { offset: 0, limit: 3 });
    assert.ok(sliced.body.split('\n').length <= 3);
    assert.equal(sliced.truncated, true);
    assert.notEqual(full.body, sliced.body);
  });

  it('respects anchor — returns just the named slice', () => {
    const r = contextFs.read(makeContent(), emptyPlanContext, '/INDEX.md', { anchor: 'summary' });
    assert.ok(r.body.includes('## Workspace summary'));
    assert.ok(!r.body.includes('## Suggested reading order'));
  });

  it('returns error inline for unknown anchor', () => {
    const r = contextFs.read(makeContent(), emptyPlanContext, '/INDEX.md', { anchor: 'does-not-exist' });
    assert.ok(r.error);
    assert.equal(r.body, '');
  });

  it('reads /keywords/primary.md', () => {
    const r = contextFs.read(makeContent(), emptyPlanContext, '/keywords/primary.md');
    assert.ok(r.body.includes('saas onboarding tools'));
    assert.equal(r.frontmatter.id, 'keyword-saas-onboarding-tools');
  });

  it('reads /keywords/secondary/{slug}.md and 404s on unknown slug', () => {
    const r = contextFs.read(makeContent(), emptyPlanContext, '/keywords/secondary/user-activation.md');
    assert.ok(r);
    assert.equal(r.frontmatter.id, 'keyword-user-activation');
    assert.equal(contextFs.read(makeContent(), emptyPlanContext, '/keywords/secondary/unknown.md'), null);
  });

  it('reads /subtopics/{slug}.md and tags priority by coverage', () => {
    const r = contextFs.read(makeContent(), emptyPlanContext, '/subtopics/pricing-tiers.md');
    assert.equal(r.frontmatter.priority, 1); // 88% coverage → priority 1
    const lowCov = contextFs.read(makeContent(), emptyPlanContext, '/subtopics/video-walkthroughs.md');
    assert.equal(lowCov.frontmatter.priority, 3); // 25% → priority 3
  });
});

// ─── /plans/active.md projection (evidence rendering) ───────────────

describe('/plans/active.md renders evidence refs', () => {
  function planFixture() {
    return {
      _id: 'p1',
      version: 1,
      status: 'draft',
      targetAudience: 'a',
      angle: 'b',
      thesis: 'c',
      wordBudget: 1000,
      sections: [
        {
          id: 'intro',
          heading: 'Introduction',
          headingLevel: 2,
          wordTarget: 200,
          keyPoints: [
            { text: 'Frame the problem', evidence: [{ path: '/keywords/primary.md', anchor: 'overview', anchorsVersion: 1, reason: 'target keyword' }] },
            { text: 'No-evidence keypoint', evidence: [] },
          ],
        },
      ],
      evidenceMap: {
        intro: [
          { path: '/keywords/primary.md', anchor: 'overview', anchorsVersion: 1, reason: 'target keyword' },
          { path: '/competitors/notion.com.md', quote: 'Notion onboarding', reason: 'competitor name' },
        ],
      },
      sources: [
        { url: 'https://example.com/article', title: 'Example study', stance: 'supports' },
      ],
      alternatives: [],
      risks: [],
      openQuestions: [],
    };
  }

  it('renders inline evidence under each key point that has refs', () => {
    const ctx = { ...emptyPlanContext, draft: planFixture() };
    const r = contextFs.read(makeContent(), ctx, '/plans/active.md');
    assert.ok(r.body.includes('Frame the problem'),
      'key point text must appear');
    assert.ok(r.body.includes('evidence:') && r.body.includes('/keywords/primary.md#overview'),
      'inline evidence must surface anchor-style refs; body: ' + r.body.slice(0, 500));
  });

  it('omits evidence line for key points without refs', () => {
    const ctx = { ...emptyPlanContext, draft: planFixture() };
    const r = contextFs.read(makeContent(), ctx, '/plans/active.md');
    // The "No-evidence keypoint" line should NOT be followed by an evidence: line.
    const lines = r.body.split('\n');
    const idx = lines.findIndex((l) => l.includes('No-evidence keypoint'));
    assert.ok(idx >= 0, 'expected key point line to appear');
    const next = lines[idx + 1] || '';
    assert.ok(!next.trim().startsWith('evidence:'),
      'no-evidence key point must not emit an evidence line');
  });

  it('renders the Evidence map section by section id', () => {
    const ctx = { ...emptyPlanContext, draft: planFixture() };
    const r = contextFs.read(makeContent(), ctx, '/plans/active.md');
    assert.ok(r.body.includes('## Evidence map'),
      'Evidence map anchor must be present');
    assert.ok(r.body.includes('**intro**:'),
      'evidence keys (section ids) must appear');
    assert.ok(r.body.includes('/competitors/notion.com.md'),
      'quote-style refs must render their path');
  });

  it('shows empty placeholder when evidenceMap is empty', () => {
    const plan = planFixture();
    plan.evidenceMap = {};
    const ctx = { ...emptyPlanContext, draft: plan };
    const r = contextFs.read(makeContent(), ctx, '/plans/active.md');
    assert.ok(r.body.includes('No evidence attached'),
      'empty evidenceMap must show placeholder');
  });

  it('renders sources list with stance', () => {
    const ctx = { ...emptyPlanContext, draft: planFixture() };
    const r = contextFs.read(makeContent(), ctx, '/plans/active.md');
    assert.ok(r.body.includes('## Sources'));
    assert.ok(r.body.includes('Example study'));
    assert.ok(r.body.includes('[supports]'));
  });

  it('exposes evidence-map and sources as named anchors in frontmatter', () => {
    const ctx = { ...emptyPlanContext, draft: planFixture() };
    const r = contextFs.read(makeContent(), ctx, '/plans/active.md');
    const ids = r.frontmatter.anchors.map((a) => a.id);
    assert.ok(ids.includes('evidence-map'));
    assert.ok(ids.includes('sources'));
  });
});

// ─── grep ────────────────────────────────────────────────────────────

describe('contextFs.grep', () => {
  it('returns matches across files with line numbers', () => {
    const { results } = contextFs.grep(makeContent(), emptyPlanContext, 'onboarding');
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(typeof r.line === 'number' && r.line > 0);
      assert.ok(r.snippet.toLowerCase().includes('onboarding'));
    }
  });
  it('respects prefix', () => {
    const { results } = contextFs.grep(makeContent(), emptyPlanContext, 'Notion', '/competitors');
    assert.ok(results.every((r) => r.path.startsWith('/competitors/')));
  });
  it('returns empty results for missing pattern', () => {
    const { results, truncated } = contextFs.grep(makeContent(), emptyPlanContext, '');
    assert.deepEqual(results, []);
    assert.equal(truncated, false);
  });
  it('returns truncated:false on small workspace', () => {
    const { truncated } = contextFs.grep(makeContent(), emptyPlanContext, 'onboarding');
    assert.equal(truncated, false);
  });
});

// ─── verify ──────────────────────────────────────────────────────────

describe('contextFs.verify', () => {
  it('resolves an anchor ref against current frontmatter', () => {
    const content = makeContent();
    // First read INDEX to learn its anchors_version + anchor ids
    const idx = contextFs.read(content, emptyPlanContext, '/INDEX.md');
    const anchorId = idx.frontmatter.anchors[0].id;
    const ref = {
      path: '/INDEX.md',
      anchor: anchorId,
      anchorsVersion: idx.frontmatter.anchors_version,
      reason: 'test',
    };
    const [result] = contextFs.verify(content, emptyPlanContext, [ref]);
    assert.equal(result.ok, true);
  });

  it('rejects an anchor ref with stale anchors_version', () => {
    const content = makeContent();
    const idx = contextFs.read(content, emptyPlanContext, '/INDEX.md');
    const ref = {
      path: '/INDEX.md',
      anchor: idx.frontmatter.anchors[0].id,
      anchorsVersion: idx.frontmatter.anchors_version - 1,  // wrong version
      reason: 'test',
    };
    const [result] = contextFs.verify(content, emptyPlanContext, [ref]);
    assert.equal(result.ok, false);
  });

  it('resolves a quote ref via whitespace-normalized substring match', () => {
    const content = makeContent();
    const ref = { path: '/competitors/notion.com.md', quote: 'Notion onboarding', reason: 'name' };
    const [result] = contextFs.verify(content, emptyPlanContext, [ref]);
    assert.equal(result.ok, true);
  });

  it('rejects a ref against an unknown path', () => {
    const content = makeContent();
    const ref = { path: '/nope.md', quote: 'anything', reason: 'r' };
    const [result] = contextFs.verify(content, emptyPlanContext, [ref]);
    assert.equal(result.ok, false);
    assert.ok(result.reason && result.reason.includes('not found'));
  });

  it('reuses one file load across multiple refs to same path (cache)', () => {
    const content = makeContent();
    const refs = [
      { path: '/competitors/notion.com.md', quote: 'Notion onboarding', reason: 'a' },
      { path: '/competitors/notion.com.md', quote: 'Notion onboarding', reason: 'b' },
    ];
    const results = contextFs.verify(content, emptyPlanContext, refs);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
  });
});
