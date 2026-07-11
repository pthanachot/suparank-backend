/**
 * Rec 13 Phase A — scoring parity fixture generator.
 *
 * One section-DSL per draft, rendered into every representation the four
 * scorers consume — html (backend scorer.js), markdown (writing-engine
 * Score), blocks (frontend scoreContent.ts), text (engine /api/score) — so
 * cross-runtime deltas measure SCORER divergence, not fixture divergence.
 *
 * Deliberate divergence traps (plan step 4):
 *   - inflected forms      ("automations"/"automated" vs term "automation")
 *   - short-term matching  ("ai" inside "maintain"/"airline")
 *   - Unicode headings     (accents, emoji, CJK)
 *   - tables               (markdown pipe-tables vs <table> counting)
 *
 * Run:  node backend/tests/fixtures/scoring/generate.js
 * Output (committed): benchmark.json, drafts.json
 */

const fs = require('fs');
const path = require('path');

// ─── Shared benchmark / terms ───────────────────────────────────────────────

const KEYWORD = 'email automation';

const BENCHMARK = {
  keywords: [KEYWORD],
  pageCount: 10,
  avgWordCount: 1200,
  minWordCount: 800,
  maxWordCount: 2000,
  avgH2Count: 6,
  avgH3Count: 4,
  avgImages: 3,
  avgInternalLinks: 4,
  avgExternalLinks: 3,
  avgListCount: 2,
  avgTableCount: 1,
  avgFaqCount: 1,
  avgParagraphs: 18,
  avgSentenceLength: 16,
  avgReadingLevel: 9,
  avgKeywordDensity: 1.2,
  keywordInH2Rate: 0.7,
  keywordInFirst100Rate: 0.8,
  topNlpTerms: [
    { term: 'email automation', category: 'headings', count: 40, docFrequency: 9, prominence: 'heading', usageRange: { min: 3, recommended: 6, max: 12 } },
    { term: 'automation workflow', category: 'nlp', count: 20, docFrequency: 7, prominence: 'body', usageRange: { min: 2, recommended: 4, max: 8 } },
    { term: 'drip campaign', category: 'nlp', count: 18, docFrequency: 7, prominence: 'body', usageRange: { min: 2, recommended: 3, max: 6 } },
    // Short-term trap: must not match inside "maintain", "airline", "brainstorm".
    { term: 'ai', category: 'nlp', count: 15, docFrequency: 6, prominence: 'body', usageRange: { min: 2, recommended: 4, max: 9 } },
    // Inflection trap: drafts use "automations"/"automated"/"automating".
    { term: 'automate', category: 'nlp', count: 14, docFrequency: 6, prominence: 'body', usageRange: { min: 2, recommended: 4, max: 8 } },
    { term: 'subscriber segmentation', category: 'nlp', count: 10, docFrequency: 5, prominence: 'body', usageRange: { min: 1, recommended: 2, max: 5 } },
    { term: 'open rate', category: 'nlp', count: 12, docFrequency: 6, prominence: 'body', usageRange: { min: 1, recommended: 3, max: 6 } },
    { term: 'unsubscribe', category: 'nlp', count: 8, docFrequency: 4, prominence: 'body', usageRange: { min: 1, recommended: 2, max: 4 } },
  ],
  topicClusters: [
    { topic: 'Setup', terms: ['automation workflow', 'drip campaign'], importance: 1, docFrequency: 7 },
    { topic: 'Metrics', terms: ['open rate', 'unsubscribe'], importance: 0.8, docFrequency: 6 },
    { topic: 'Audience', terms: ['subscriber segmentation'], importance: 0.6, docFrequency: 5 },
  ],
  subtopics: [
    { label: 'deliverability', stemmedForm: 'deliver', variants: ['email deliverability'], docFrequency: 5, docPercent: 50 },
    { label: 'welcome series', stemmedForm: 'welcom seri', variants: ['welcome sequence'], docFrequency: 4, docPercent: 40 },
  ],
};

// ─── Section DSL → renderers ────────────────────────────────────────────────
// section: {t: 'h1'|'h2'|'h3'|'p'|'ul'|'table'|'faq'|'img'|'links', ...}

function esc(s) { return s; } // fixtures are trusted authored text

// NOTE: no <title> tag — the production editor's htmlContent (blocksToHtml)
// carries no <title>, and embedding one here skewed term counts vs the text
// representation (the engine leg) by +1 per title term. The `title` field
// stays available separately for the writing-engine leg's Score(title=...).
function renderHtml(sections) {
  const parts = [];
  for (const s of sections) {
    switch (s.t) {
      case 'h1': parts.push(`<h1>${esc(s.text)}</h1>`); break;
      case 'h2': parts.push(`<h2>${esc(s.text)}</h2>`); break;
      case 'h3': parts.push(`<h3>${esc(s.text)}</h3>`); break;
      case 'p': parts.push(`<p>${esc(s.text)}</p>`); break;
      case 'ul': parts.push(`<ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`); break;
      case 'table': parts.push(`<table><tr>${s.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${s.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`); break;
      case 'faq': parts.push(s.items.map((q) => `<h3>${esc(q.q)}</h3><p>${esc(q.a)}</p>`).join('')); break;
      case 'img': parts.push(`<img src="${s.src}" alt="${esc(s.alt)}">`); break;
      case 'links': parts.push(`<p>${s.links.map((l) => `<a href="${l.href}">${esc(l.text)}</a>`).join(' and ')}</p>`); break;
      default: throw new Error(`unknown section ${s.t}`);
    }
  }
  return parts.join('\n');
}

function renderMarkdown(sections, title) {
  const parts = [];
  for (const s of sections) {
    switch (s.t) {
      case 'h1': parts.push(`# ${s.text}`); break;
      case 'h2': parts.push(`## ${s.text}`); break;
      case 'h3': parts.push(`### ${s.text}`); break;
      case 'p': parts.push(s.text); break;
      case 'ul': parts.push(s.items.map((i) => `- ${i}`).join('\n')); break;
      case 'table': parts.push([
        `| ${s.headers.join(' | ')} |`,
        `| ${s.headers.map(() => '---').join(' | ')} |`,
        ...s.rows.map((r) => `| ${r.join(' | ')} |`),
      ].join('\n')); break;
      case 'faq': parts.push(s.items.map((q) => `### ${q.q}\n\n${q.a}`).join('\n\n')); break;
      case 'img': parts.push(`![${s.alt}](${s.src})`); break;
      case 'links': parts.push(s.links.map((l) => `[${l.text}](${l.href})`).join(' and ')); break;
      default: throw new Error(`unknown section ${s.t}`);
    }
  }
  return parts.join('\n\n');
}

let blockId = 0;
function renderBlocks(sections) {
  const blocks = [];
  const push = (type, text, extra = {}) => blocks.push({ id: `b${blockId++}`, type, text, ...extra });
  for (const s of sections) {
    switch (s.t) {
      case 'h1': case 'h2': case 'h3': push(s.t, s.text); break;
      case 'p': push('p', s.text); break;
      case 'ul': for (const i of s.items) push('li', i); break;
      case 'table': push('table', '', { tableData: { headers: s.headers, rows: s.rows } }); break;
      case 'faq': push('faq', '', { faqItems: s.items.map((q) => ({ question: q.q, answer: q.a })) }); break;
      case 'img': push('img', '', { src: s.src, alt: s.alt }); break;
      case 'links': push('p', s.links.map((l) => `<a href="${l.href}">${l.text}</a>`).join(' and ')); break;
      default: throw new Error(`unknown section ${s.t}`);
    }
  }
  return blocks;
}

function renderText(sections) {
  const parts = [];
  for (const s of sections) {
    switch (s.t) {
      case 'h1': case 'h2': case 'h3': case 'p': parts.push(s.text); break;
      case 'ul': parts.push(s.items.join('\n')); break;
      case 'table': parts.push([s.headers.join(' '), ...s.rows.map((r) => r.join(' '))].join('\n')); break;
      case 'faq': parts.push(s.items.map((q) => `${q.q}\n${q.a}`).join('\n')); break;
      case 'img': break;
      case 'links': parts.push(s.links.map((l) => l.text).join(' and ')); break;
      default: throw new Error(`unknown section ${s.t}`);
    }
  }
  return parts.join('\n\n');
}

// ─── Prose helpers ──────────────────────────────────────────────────────────

const FILLER = [
  'Marketing teams keep asking how to reach subscribers at the right moment without manual effort.',
  'A well designed sequence delivers the right message while the team focuses on strategy.',
  'Measuring engagement over several weeks reveals which messages resonate with each audience segment.',
  'Consistent testing separates guesswork from evidence and compounds small wins into real growth.',
  'The best programs start simple, prove value quickly, and expand coverage step by step.',
];
const filler = (n) => Array.from({ length: n }, (_, i) => FILLER[i % FILLER.length]).join(' ');

// ─── The 10 drafts ──────────────────────────────────────────────────────────

const DRAFTS = [
  {
    name: 'empty-short',
    title: 'Untitled draft',
    sections: [
      { t: 'p', text: 'A very short note about sending messages to customers. ' + filler(1) },
    ],
  },
  {
    name: 'balanced-long',
    title: 'Email Automation: The Complete Guide',
    sections: [
      { t: 'h1', text: 'Email Automation: The Complete Guide' },
      { t: 'p', text: `Email automation lets you automate campaigns end to end. This guide to email automation covers every automation workflow, from your first drip campaign to advanced ai assistance. ${filler(2)}` },
      { t: 'h2', text: 'Why email automation matters' },
      { t: 'p', text: `Teams that automate follow-ups see better open rate numbers and fewer unsubscribe events. ${filler(3)}` },
      { t: 'h2', text: 'Building your first automation workflow' },
      { t: 'p', text: `Start your automation workflow with a welcome series. A drip campaign warms up new signups gradually. ${filler(3)}` },
      { t: 'h3', text: 'Drip campaign timing' },
      { t: 'p', text: `Space each drip campaign message three days apart, then automate the cadence. ${filler(2)}` },
      { t: 'h2', text: 'Subscriber segmentation strategies' },
      { t: 'p', text: `Subscriber segmentation splits your list by behavior. Good subscriber segmentation improves every open rate you track. ${filler(3)}` },
      { t: 'ul', items: ['Segment by signup source', 'Segment by purchase history', 'Automate re-engagement for cold subscribers'] },
      { t: 'h2', text: 'Using ai to optimize send times' },
      { t: 'p', text: `Modern ai models predict the best hour to send. Let ai adjust timing per subscriber while you automate the rest. ${filler(3)}` },
      { t: 'h2', text: 'Email deliverability and welcome series' },
      { t: 'p', text: `Deliverability keeps your email automation out of spam. A welcome sequence builds sender reputation early. ${filler(3)}` },
      { t: 'table', headers: ['Metric', 'Target'], rows: [['Open rate', '25%'], ['Unsubscribe', '<0.5%']] },
      { t: 'h2', text: 'Measuring open rate and unsubscribe trends' },
      { t: 'p', text: `Watch open rate weekly; a rising unsubscribe count means fatigue. ${filler(3)}` },
      { t: 'img', src: 'https://example.com/dashboard.png', alt: 'email automation dashboard' },
      { t: 'img', src: 'https://example.com/flow.png', alt: 'automation workflow chart' },
      { t: 'img', src: 'https://example.com/report.png', alt: 'open rate report' },
      { t: 'links', links: [
        { href: '/blog/welcome-series', text: 'welcome series guide' },
        { href: '/blog/segmentation', text: 'segmentation playbook' },
        { href: '/blog/deliverability', text: 'deliverability basics' },
        { href: '/pricing', text: 'pricing' },
        { href: 'https://mailchimp.com/resources', text: 'Mailchimp resources' },
        { href: 'https://hubspot.com/research', text: 'HubSpot research' },
        { href: 'https://litmus.com/blog', text: 'Litmus blog' },
      ] },
      { t: 'faq', items: [
        { q: 'What is email automation?', a: 'Email automation sends the right message automatically based on subscriber behavior.' },
      ] },
      { t: 'p', text: filler(4) },
    ],
  },
  {
    name: 'inflected-forms',
    title: 'Automations for modern teams',
    sections: [
      { t: 'h1', text: 'Automations for modern teams' },
      { t: 'p', text: `Automations changed how we message customers. Automated sequences and automating routine sends free up hours. Our automations handle email automation basics without effort. ${filler(2)}` },
      { t: 'h2', text: 'Automated drip campaigns' },
      { t: 'p', text: `We automated our drip campaign last year. Automating the second drip campaign doubled replies. ${filler(2)}` },
      { t: 'h2', text: 'Automating subscriber segmentation' },
      { t: 'p', text: `Automated subscriber segmentation beats manual tagging. ${filler(2)}` },
    ],
  },
  {
    name: 'short-term-trap',
    title: 'Maintain your list like an airline maintains planes',
    sections: [
      { t: 'h1', text: 'Maintain your list like an airline maintains planes' },
      { t: 'p', text: `To maintain deliverability you must maintain hygiene. Airlines maintain aircraft on strict schedules; likewise, maintain your list monthly. Brainstorm the maintenance plan with your team, maintain focus, and remain patient. ${filler(2)}` },
      { t: 'h2', text: 'Where ai actually helps' },
      { t: 'p', text: `Real ai helps score engagement. Use ai sparingly. A third mention: ai. ${filler(2)}` },
      { t: 'p', text: `Maintain momentum. The airline metaphor remains apt: maintained lists retain and sustain engagement. ${filler(2)}` },
    ],
  },
  {
    name: 'unicode-headings',
    title: 'Guía de email automation 🚀',
    sections: [
      { t: 'h1', text: 'Guía de email automation 🚀' },
      { t: 'p', text: `La email automation moderna incluye flujos avanzados. メール自動化 (email automation) は重要です。 ${filler(2)}` },
      { t: 'h2', text: 'Séquences détaillées — drip campaign' },
      { t: 'p', text: `Une drip campaign bien conçue améliore l'open rate. ${filler(2)}` },
      { t: 'h2', text: '購読者のsubscriber segmentation' },
      { t: 'p', text: `Subscriber segmentation works in every language. ${filler(2)}` },
    ],
  },
  {
    name: 'tables-heavy',
    title: 'Email automation benchmarks in tables',
    sections: [
      { t: 'h1', text: 'Email automation benchmarks in tables' },
      { t: 'p', text: `Email automation results, tabulated. ${filler(1)}` },
      { t: 'table', headers: ['Automation workflow', 'Open rate', 'Unsubscribe'], rows: [['Welcome', '32%', '0.2%'], ['Drip campaign', '27%', '0.3%'], ['Win-back', '19%', '0.6%']] },
      { t: 'p', text: filler(2) },
      { t: 'table', headers: ['Tool', 'ai features'], rows: [['Tool A', 'send-time ai'], ['Tool B', 'subject-line ai']] },
      { t: 'p', text: filler(2) },
    ],
  },
  {
    name: 'faq-heavy',
    title: 'Email automation FAQ',
    sections: [
      { t: 'h1', text: 'Email automation FAQ' },
      { t: 'p', text: `Everything people ask about email automation. ${filler(1)}` },
      { t: 'faq', items: [
        { q: 'What is email automation?', a: 'Sending messages automatically based on triggers and schedules.' },
        { q: 'How do I start an automation workflow?', a: 'Begin with a welcome series, then add a drip campaign.' },
        { q: 'Does subscriber segmentation matter?', a: 'Yes — segmented sends lift open rate significantly.' },
        { q: 'How does ai fit in?', a: 'ai predicts send times and drafts subject lines.' },
        { q: 'How do I reduce unsubscribe rates?', a: 'Send less, target better, and automate preference centers.' },
      ] },
    ],
  },
  {
    name: 'keyword-stuffed',
    title: 'email automation email automation email automation',
    sections: [
      { t: 'h1', text: 'Email automation email automation guide to email automation' },
      { t: 'p', text: `Email automation email automation email automation. Best email automation for email automation users who love email automation. Email automation with email automation on top. ${filler(1)}` },
      { t: 'h2', text: 'More email automation' },
      { t: 'p', text: `Email automation, email automation, and yet more email automation. Try email automation today with email automation experts. ${filler(1)}` },
    ],
  },
  {
    name: 'overused-terms',
    title: 'Drip campaign obsession',
    sections: [
      { t: 'h1', text: 'Drip campaign obsession' },
      { t: 'p', text: `Drip campaign one. Drip campaign two. Drip campaign three. Drip campaign four. Drip campaign five. Drip campaign six. Drip campaign seven. Drip campaign eight. A drip campaign for every drip campaign. ${filler(2)}` },
      { t: 'h2', text: 'Email automation appears once' },
      { t: 'p', text: filler(3) },
    ],
  },
  {
    name: 'links-images',
    title: 'Email automation resources',
    sections: [
      { t: 'h1', text: 'Email automation resources' },
      { t: 'p', text: `A resource list for email automation and automation workflow fans. ${filler(2)}` },
      { t: 'img', src: 'https://example.com/a.png', alt: 'automation chart' },
      { t: 'img', src: 'https://example.com/b.png', alt: 'workflow' },
      { t: 'img', src: 'https://example.com/c.png', alt: 'metrics' },
      { t: 'img', src: 'https://example.com/d.png', alt: 'extra' },
      { t: 'links', links: [
        { href: '/guides/one', text: 'guide one' },
        { href: '/guides/two', text: 'guide two' },
        { href: '/guides/three', text: 'guide three' },
        { href: '/guides/four', text: 'guide four' },
        { href: '/guides/five', text: 'guide five' },
        { href: 'https://external-one.com', text: 'external one' },
        { href: 'https://external-two.com', text: 'external two' },
      ] },
      { t: 'p', text: `Open rate and unsubscribe metrics belong in every report. ${filler(2)}` },
    ],
  },
];

// ─── Emit ───────────────────────────────────────────────────────────────────

const out = DRAFTS.map((d) => {
  blockId = 0;
  return {
    name: d.name,
    title: d.title,
    html: renderHtml(d.sections),
    markdown: renderMarkdown(d.sections, d.title),
    blocks: renderBlocks(d.sections),
    text: renderText(d.sections),
  };
});

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'benchmark.json'), JSON.stringify({ keyword: KEYWORD, benchmark: BENCHMARK }, null, 2));
fs.writeFileSync(path.join(dir, 'drafts.json'), JSON.stringify(out, null, 2));
console.log(`wrote benchmark.json + drafts.json (${out.length} drafts)`);
