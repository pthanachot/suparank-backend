/**
 * READ-ONLY audit: report stored content whose block HTML could execute when
 * the editor renders it (QA Nov 2026: N1).
 *
 * Looks for `on<event>=`, `<script` and `javascript:` in every rendered text
 * field of live blocks AND version snapshots (a restore puts those back):
 * block.text, caption, faqItems[].question/answer, tableData headers/rows/
 * caption, toggleData summary/content, ctaData.buttonText.
 *
 * It NEVER writes. It prints one line per hit (workspace, content number, where,
 * a short escaped excerpt) and a summary; exit code 1 when anything was found so
 * it can gate a pipeline. The new save-path sanitizer (utils/sanitizeBlockHtml)
 * cleans a document the next time it is saved; this tells you which documents
 * hold something today.
 *
 * Usage (point it at the database deliberately; it reads MONGODB_URI/DB_NAME
 * like the app does):
 *   node src/scripts/auditStoredXss.js            # report
 *   node src/scripts/auditStoredXss.js --json     # machine-readable lines
 *
 * Expect some false positives: escaped text such as `&lt;img onerror=…&gt;`
 * matches the pattern but is inert. The excerpt shows which it is.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Content = require('../models/Content');
const { SUSPICIOUS_PATTERNS } = require('../utils/sanitizeBlockHtml');

// Coarse server-side prefilter (one regex over the fields that matter); the
// precise per-field check runs below.
const PREFILTER = /on[a-z]+\s*=|<\s*script|javascript\s*:/i;
const FIELDS = [
  'blocks.text', 'blocks.caption', 'blocks.faqItems.question', 'blocks.faqItems.answer',
  'blocks.tableData.headers', 'blocks.tableData.rows', 'blocks.tableData.caption',
  'blocks.toggleData.summary', 'blocks.toggleData.content', 'blocks.ctaData.buttonText',
  'versions.blocks.text', 'versions.blocks.caption', 'versions.blocks.faqItems.question',
  'versions.blocks.faqItems.answer', 'versions.blocks.tableData.headers',
  'versions.blocks.tableData.caption', 'versions.blocks.toggleData.summary',
  'versions.blocks.toggleData.content', 'versions.blocks.ctaData.buttonText',
];

function suspicious(v) {
  return typeof v === 'string' && SUSPICIOUS_PATTERNS.some((re) => re.test(v));
}

function excerpt(v) {
  const s = String(v);
  const re = SUSPICIOUS_PATTERNS.find((r) => r.test(s));
  const at = re ? Math.max(0, s.search(re) - 40) : 0;
  return JSON.stringify(s.slice(at, at + 140));
}

function* blockHits(block, where) {
  if (!block) return;
  const at = `${where} block=${block.id || '?'}(${block.type || '?'})`;
  if (suspicious(block.text)) yield [`${at} text`, block.text];
  if (suspicious(block.caption)) yield [`${at} caption`, block.caption];
  for (const [i, f] of (block.faqItems || []).entries()) {
    if (suspicious(f?.question)) yield [`${at} faq[${i}].question`, f.question];
    if (suspicious(f?.answer)) yield [`${at} faq[${i}].answer`, f.answer];
  }
  const t = block.tableData || {};
  for (const [i, h] of (t.headers || []).entries()) if (suspicious(h)) yield [`${at} table.header[${i}]`, h];
  for (const [r, row] of (t.rows || []).entries()) {
    for (const [c, cell] of (row || []).entries()) if (suspicious(cell)) yield [`${at} table[${r}][${c}]`, cell];
  }
  if (suspicious(t.caption)) yield [`${at} table.caption`, t.caption];
  if (suspicious(block.toggleData?.summary)) yield [`${at} toggle.summary`, block.toggleData.summary];
  if (suspicious(block.toggleData?.content)) yield [`${at} toggle.content`, block.toggleData.content];
  if (suspicious(block.ctaData?.buttonText)) yield [`${at} cta.buttonText`, block.ctaData.buttonText];
}

async function run() {
  const asJson = process.argv.includes('--json');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const dbName = process.env.DB_NAME || 'suparank';
  await mongoose.connect(uri, { dbName });
  if (!asJson) console.log(`Connected (db: ${dbName}). Read-only scan of content block HTML...\n`);

  const filter = { $or: FIELDS.map((f) => ({ [f]: PREFILTER })) };
  const cursor = Content.find(filter)
    .select('workspaceId contentNumber title blocks versions')
    .lean()
    .cursor();

  let docs = 0;
  let hits = 0;
  for await (const doc of cursor) {
    let docHits = 0;
    const report = (where, value) => {
      docHits++;
      hits++;
      const row = { workspaceId: String(doc.workspaceId), contentNumber: doc.contentNumber, where, excerpt: excerpt(value) };
      if (asJson) console.log(JSON.stringify(row));
      else console.log(`  ws=${row.workspaceId} content=${row.contentNumber} ${where}: ${row.excerpt}`);
    };
    for (const b of doc.blocks || []) for (const [w, v] of blockHits(b, 'live')) report(w, v);
    for (const ver of doc.versions || []) {
      for (const b of ver?.blocks || []) for (const [w, v] of blockHits(b, `version=${ver.id || '?'}`)) report(w, v);
    }
    if (docHits) docs++;
  }

  if (!asJson) {
    console.log(hits
      ? `\n${hits} suspicious field(s) in ${docs} document(s). Each is cleaned on its next save; review the excerpts above.`
      : '\nNo stored content matched.');
  }
  if (hits) process.exitCode = 1;
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => {
    console.error('auditStoredXss failed:', err.message);
    process.exitCode = 2;
    mongoose.disconnect().catch(() => {});
  });
}

module.exports = { blockHits, suspicious };
