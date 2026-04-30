/**
 * Tests for brandVoiceMarkdown.js — avatar and brand voice markdown generation.
 */

const { generateAvatarMarkdown, generateBrandVoiceMarkdown } = require('../src/services/brandVoiceMarkdown');

describe('generateAvatarMarkdown', () => {
  const baseAvatar = {
    name: 'Sarah',
    emoji: '✍️',
    role: 'Content Strategist',
    experience: '10 years',
    tagline: 'Makes complex ideas simple',
    traits: ['witty', 'concise'],
    writingQuirks: 'Uses short paragraphs and analogies',
    toneOverrides: { formality: 30, warmth: 80, humor: null },
    vocabulary: { uses: ['leverage', 'dive in'], avoids: ['synergy', 'circle back'] },
    openingStyle: 'contrarian',
    sample: 'Here is what nobody tells you about writing: less is more.',
    background: 'Former editor at TechCrunch, now freelance.',
    uploads: [],
  };

  test('includes avatar name in heading', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('# Writer Avatar: Sarah');
  });

  test('includes role and experience', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('Content Strategist');
    expect(md).toContain('10 years');
  });

  test('includes personality traits', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('## Personality Traits');
    expect(md).toContain('witty');
    expect(md).toContain('concise');
  });

  test('includes writing quirks', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('## Writing Quirks');
    expect(md).toContain('Uses short paragraphs and analogies');
  });

  test('includes tone overrides with descriptions', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('## Tone Overrides');
    expect(md).toContain('Formality');
    expect(md).toContain('Warmth');
    // humor is null, should not appear
    expect(md).not.toContain('Humor');
  });

  test('includes vocabulary uses and avoids', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('Sarah Always Uses');
    expect(md).toContain('"leverage"');
    expect(md).toContain('Sarah Never Uses');
    expect(md).toContain('"synergy"');
  });

  test('includes opening style', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('## Opening Style');
    expect(md).toContain('contrarian');
  });

  test('includes signature writing sample', () => {
    const md = generateAvatarMarkdown(baseAvatar);
    expect(md).toContain('## Signature Writing Sample');
    expect(md).toContain('less is more');
  });

  test('includes learned writing insights from uploads', () => {
    const avatar = {
      ...baseAvatar,
      uploads: [
        { status: 'learned', summary: 'Prefers short sentences.', originalName: 'blog-post.pdf' },
        { status: 'learning', summary: '', originalName: 'draft.txt' },
        { status: 'learned', summary: 'Uses active voice consistently.', originalName: 'newsletter.docx' },
      ],
    };
    const md = generateAvatarMarkdown(avatar);
    expect(md).toContain('## Learned Writing Insights');
    expect(md).toContain('From "blog-post.pdf"');
    expect(md).toContain('Prefers short sentences.');
    expect(md).toContain('From "newsletter.docx"');
    // "learning" upload should NOT appear
    expect(md).not.toContain('draft.txt');
  });

  test('omits sections for empty/null fields', () => {
    const minimal = { name: 'Minimal', uploads: [] };
    const md = generateAvatarMarkdown(minimal);
    expect(md).toContain('# Writer Avatar: Minimal');
    expect(md).not.toContain('## Personality Traits');
    expect(md).not.toContain('## Writing Quirks');
    expect(md).not.toContain('## Tone Overrides');
    expect(md).not.toContain('## Vocabulary');
    expect(md).not.toContain('## Opening Style');
    expect(md).not.toContain('## Signature Writing Sample');
  });
});

describe('generateBrandVoiceMarkdown', () => {
  test('generates markdown with tone settings', () => {
    const settings = {
      formality: 60,
      warmth: 40,
      humor: 20,
      technicality: 80,
    };
    const md = generateBrandVoiceMarkdown(settings);
    expect(md).toContain('Formality');
    expect(md).toContain('Warmth');
  });

  test('handles empty settings', () => {
    const md = generateBrandVoiceMarkdown({});
    expect(typeof md).toBe('string');
  });
});
