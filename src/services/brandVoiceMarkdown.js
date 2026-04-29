/**
 * Generate structured markdown system prompts from Brand Voice settings
 * and Avatar data. These markdown files are pushed to the Writing Engine
 * as context when testing brand voice or avatar writing.
 */

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function describeSlider(value, leftStrong, leftMild, balanced, rightMild, rightStrong) {
  if (value <= 25) return leftStrong;
  if (value <= 45) return leftMild;
  if (value <= 55) return balanced;
  if (value <= 75) return rightMild;
  return rightStrong;
}

const PERSPECTIVE_MAP = {
  you: 'Address the reader directly using "you" and "your". Make it personal.',
  we: 'Speak as a team using "we" and "our". Create shared ownership with the reader.',
  they: 'Use third-person perspective. Refer to users, teams, or organizations as "they".',
};

const SENTENCE_STYLE_MAP = {
  short: 'Keep sentences short and punchy. Max 15 words per sentence. Every word earns its place.',
  mixed: 'Mix short punchy sentences with longer contextual ones. Vary rhythm to keep the reader engaged.',
  detailed: 'Use longer, more detailed sentences. Provide thorough context and nuance in each point.',
};

const FORMATTING_LABELS = {
  'questions-as-headings': 'Use questions as headings to engage readers',
  'short-paragraphs': 'Keep paragraphs to 2-3 lines max',
  'numbered-lists': 'Prefer numbered lists over bullet points',
  'bold-openers': 'Bold the first sentence of each section',
  'no-intro-filler': 'Skip filler intros — get to the point immediately',
};

/* ── Brand Voice Markdown ─────────────────────────────────────────────────── */

/**
 * Generate brand_voice.md from settings object.
 * @param {Object} s - settings { formality, warmth, humor, technicality, perspective, sentenceStyle, formattingHabits, useWords, avoidWords }
 * @returns {string} Markdown content
 */
function generateBrandVoiceMarkdown(s) {
  const lines = [];
  lines.push('# Brand Voice Guide');
  lines.push('');

  // Tone
  lines.push('## Tone');
  lines.push(`- **Formality** (${s.formality}/100): ${describeSlider(
    s.formality,
    'Very casual. Write like you\'re texting a smart friend.',
    'Leaning casual. Conversational but still clear and structured.',
    'Balanced. Professional but approachable.',
    'Leaning formal. Structured, polished language.',
    'Very formal. Academic or corporate tone with precise language.',
  )}`);
  lines.push(`- **Warmth** (${s.warmth}/100): ${describeSlider(
    s.warmth,
    'Neutral and objective. Stick to facts, avoid emotional language.',
    'Slightly warm. Friendly but measured.',
    'Balanced warmth. Professional and personable.',
    'Warm. Connect with the reader emotionally. Use empathetic language.',
    'Very warm. Deeply empathetic, encouraging, and supportive.',
  )}`);
  lines.push(`- **Humor** (${s.humor}/100): ${describeSlider(
    s.humor,
    'Serious. No humor. Focus on clarity and authority.',
    'Mostly serious with occasional dry wit.',
    'Balanced. Light touches of humor where appropriate.',
    'Witty. Use clever observations and light humor regularly.',
    'Very witty. Humor is a core part of the voice.',
  )}`);
  lines.push(`- **Technicality** (${s.technicality}/100): ${describeSlider(
    s.technicality,
    'Very accessible. Explain everything simply. No jargon.',
    'Mostly accessible. Use simple language, define any technical terms.',
    'Balanced. Assume some familiarity but still explain key concepts.',
    'Leaning technical. Comfortable using industry terminology.',
    'Very technical. Expert-level language for specialist audiences.',
  )}`);
  lines.push('');

  // Perspective
  lines.push('## Perspective');
  lines.push(PERSPECTIVE_MAP[s.perspective] || PERSPECTIVE_MAP.you);
  lines.push('');

  // Sentence Style
  lines.push('## Sentence Style');
  lines.push(SENTENCE_STYLE_MAP[s.sentenceStyle] || SENTENCE_STYLE_MAP.mixed);
  lines.push('');

  // Formatting Habits
  if (s.formattingHabits && s.formattingHabits.length > 0) {
    lines.push('## Formatting Habits');
    for (const habit of s.formattingHabits) {
      const label = FORMATTING_LABELS[habit] || habit;
      lines.push(`- ${label}`);
    }
    lines.push('');
  }

  // Vocabulary Rules
  if ((s.useWords && s.useWords.length > 0) || (s.avoidWords && s.avoidWords.length > 0)) {
    lines.push('## Vocabulary Rules');
    if (s.useWords && s.useWords.length > 0) {
      lines.push('### Always Use');
      lines.push(s.useWords.map(w => `- "${w}"`).join('\n'));
      lines.push('');
    }
    if (s.avoidWords && s.avoidWords.length > 0) {
      lines.push('### Never Use');
      lines.push(s.avoidWords.map(w => `- "${w}"`).join('\n'));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/* ── Avatar Markdown ──────────────────────────────────────────────────────── */

/**
 * Generate avatar.md from avatar document (avatar-only, no brand voice embedded).
 * Brand voice content is combined at test time, not baked into the avatar markdown.
 * @param {Object} avatar - Full avatar document (lean object)
 * @returns {string} Markdown content
 */
function generateAvatarMarkdown(avatar) {
  const lines = [];
  lines.push(`# Writer Avatar: ${avatar.name}`);
  lines.push('');

  // Identity
  lines.push('## Identity');
  if (avatar.role) lines.push(`- **Role**: ${avatar.role}`);
  if (avatar.experience) lines.push(`- **Experience**: ${avatar.experience}`);
  if (avatar.tagline) lines.push(`- **Tagline**: ${avatar.tagline}`);
  lines.push('');

  // Personality Traits
  if (avatar.traits && avatar.traits.length > 0) {
    lines.push('## Personality Traits');
    lines.push(avatar.traits.join(', '));
    lines.push('');
  }

  // Writing Quirks
  if (avatar.writingQuirks) {
    lines.push('## Writing Quirks');
    lines.push(avatar.writingQuirks);
    lines.push('');
  }

  // Tone Overrides
  const overrides = avatar.toneOverrides || {};
  const hasOverrides = overrides.formality != null || overrides.warmth != null || overrides.humor != null;
  if (hasOverrides) {
    lines.push('## Tone Overrides');
    if (overrides.formality != null) {
      lines.push(`- **Formality**: ${describeSlider(overrides.formality,
        'Very casual', 'Leaning casual', 'Balanced', 'Leaning formal', 'Very formal'
      )} (${overrides.formality}/100)`);
    }
    if (overrides.warmth != null) {
      lines.push(`- **Warmth**: ${describeSlider(overrides.warmth,
        'Neutral', 'Slightly warm', 'Balanced', 'Warm', 'Very warm'
      )} (${overrides.warmth}/100)`);
    }
    if (overrides.humor != null) {
      lines.push(`- **Humor**: ${describeSlider(overrides.humor,
        'Serious', 'Mostly serious', 'Balanced', 'Witty', 'Very witty'
      )} (${overrides.humor}/100)`);
    }
    lines.push('');
  }

  // Vocabulary
  const vocab = avatar.vocabulary || {};
  if ((vocab.uses && vocab.uses.length > 0) || (vocab.avoids && vocab.avoids.length > 0)) {
    lines.push('## Vocabulary');
    if (vocab.uses && vocab.uses.length > 0) {
      lines.push(`### ${avatar.name} Always Uses`);
      lines.push(vocab.uses.map(w => `- "${w}"`).join('\n'));
      lines.push('');
    }
    if (vocab.avoids && vocab.avoids.length > 0) {
      lines.push(`### ${avatar.name} Never Uses`);
      lines.push(vocab.avoids.map(w => `- "${w}"`).join('\n'));
      lines.push('');
    }
  }

  // Opening Style
  if (avatar.openingStyle) {
    lines.push('## Opening Style');
    lines.push(avatar.openingStyle);
    lines.push('');
  }

  // Signature Sample
  if (avatar.sample) {
    lines.push('## Signature Writing Sample');
    lines.push(`> ${avatar.sample}`);
    lines.push('');
  }

  // Learned Writing Insights from uploads
  const learnedUploads = (avatar.uploads || []).filter(u => u.status === 'learned' && u.summary);
  if (learnedUploads.length > 0) {
    lines.push('## Learned Writing Insights');
    for (const upload of learnedUploads) {
      lines.push(`### From "${upload.originalName}"`);
      lines.push(upload.summary);
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = {
  generateBrandVoiceMarkdown,
  generateAvatarMarkdown,
};
