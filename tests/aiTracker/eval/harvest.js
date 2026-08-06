/**
 * Phase 6 — harvest REAL platform answers from the dev DB into the eval
 * corpus. STRICTLY READ-ONLY on the database; writes only the two corpus
 * files. Harvested rows land with draft:true labels — they carry NO ground
 * truth until the D1 labeling session reviews them.
 *
 * Usage: HARVEST=1 node tests/aiTracker/eval/harvest.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVAL_DIR = __dirname;
const BACKEND = path.resolve(EVAL_DIR, '../../..');

if (process.env.HARVEST !== '1') {
  console.error('[harvest] refusing to run: set HARVEST=1 (reads the dev DB configured in backend/.env)');
  process.exit(2);
}

const dotenv = require(path.join(BACKEND, 'node_modules/dotenv'));
dotenv.config({ path: path.join(BACKEND, '.env.local') });
dotenv.config({ path: path.join(BACKEND, '.env') });

const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));
const { extractBrand } = require(path.join(BACKEND, 'src/services/aiTrackerScanEngine'));

const MAX_ROWS = 30;
const MAX_ANSWER_CHARS = 6000;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.DB_NAME || 'suparank',
    serverSelectionTimeoutMS: 10_000,
  });
  const db = mongoose.connection.db;

  const trackers = new Map();
  for (const t of await db.collection('aitrackers').find({}).project({ domain: 1 }).toArray()) {
    trackers.set(t._id.toString(), t.domain);
  }

  const seenHashes = new Set();
  const rows = [];
  const cursor = db.collection('aitrackerscans')
    .find({ status: 'ready' })
    .project({ trackerId: 1, results: 1, completedAt: 1 })
    .sort({ completedAt: -1 });

  for await (const scan of cursor) {
    if (rows.length >= MAX_ROWS) break;
    const domain = trackers.get(scan.trackerId?.toString());
    if (!domain) continue;
    for (const r of scan.results || []) {
      if (rows.length >= MAX_ROWS) break;
      for (const p of r.platforms || []) {
        if (rows.length >= MAX_ROWS) break;
        const answer = (p.aiResponse || '').trim();
        if (answer.length < 80) continue;
        const hash = crypto.createHash('sha1').update(answer).digest('hex').slice(0, 12);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        rows.push({
          id: `harv-${String(rows.length + 1).padStart(2, '0')}`,
          source: 'harvested',
          provenance: { scanId: scan._id.toString().slice(-8), platformId: p.platformId, hash },
          query: r.prompt,
          targetBrand: extractBrand(domain),
          domain,
          answer: answer.slice(0, MAX_ANSWER_CHARS),
        });
      }
    }
  }

  fs.writeFileSync(
    path.join(EVAL_DIR, 'answers/harvested.json'),
    JSON.stringify(rows, null, 2) + '\n',
  );

  // NEVER clobber completed labeling work: merge with any existing file and
  // keep every entry a human has already flipped to draft:false (review fix —
  // a re-run after the D1 session would otherwise erase hours of labels).
  const labelsPath = path.join(EVAL_DIR, 'labels-harvested.json');
  const existing = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf8')) : {};
  const draftLabels = {
    _readme: 'DRAFT labels for harvested rows — D1 session: set mentioned/cited/sentiment/brands and flip draft to false. Draft rows are excluded from all scores.',
  };
  let preserved = 0;
  for (const row of rows) {
    if (existing[row.id] && existing[row.id].draft === false) {
      draftLabels[row.id] = existing[row.id];
      preserved++;
    } else {
      draftLabels[row.id] = { draft: true, mentioned: null, cited: null, sentiment: null, brands: [] };
    }
  }
  fs.writeFileSync(labelsPath, JSON.stringify(draftLabels, null, 2) + '\n');
  if (preserved > 0) console.error(`[harvest] preserved ${preserved} completed label(s)`);

  console.log(JSON.stringify({ harvested: rows.length, platforms: [...new Set(rows.map((r) => r.provenance.platformId))] }));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('[harvest] failed:', e.message);
  process.exit(1);
});
