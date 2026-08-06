/**
 * Phase 6 — analyzer golden-eval runner.
 *
 * Modes:
 *   node tests/aiTracker/eval/run.js                   mocked: replays recorded
 *       Kimi outputs (recorded/kimi.json) through a fetch stub → deterministic
 *       CI scoring of the parse+extraction pipeline against ground truth.
 *   node tests/aiTracker/eval/run.js --live            real OpenRouter calls
 *       (loads backend/.env.local then .env — LOCAL FIRST: .env carries an
 *       empty OPENROUTER_API_KEY which would otherwise block the real one).
 *   node tests/aiTracker/eval/run.js --live --record   also saves raw Kimi
 *       responses per row → the CI replay corpus.
 *   node tests/aiTracker/eval/run.js --fallback        scores the no-key regex
 *       path — the degradation reference the gate uses to prove it can fail.
 *   Add --write-baseline to persist the report to eval/baseline.json.
 *
 * Scoring (rows with non-draft labels only; knownLimitation rows are run and
 * reported but EXCLUDED from floors):
 *   mentionedAcc / citedAcc  — exact boolean accuracy
 *   sentimentAcc             — over rows whose label sentiment ≠ null; a null
 *                              prediction counts as a miss (couples to mention)
 *   brandPrecision/Recall    — micro-averaged greedy matching via the engine's
 *                              own isSameBrand (semantic identity, not strings)
 *   positionPresent          — position ≠ null rate on true-mentioned rows
 */

const fs = require('fs');
const path = require('path');

const EVAL_DIR = __dirname;
const BACKEND = path.resolve(EVAL_DIR, '../../..');
const RECORDED_FILE = path.join(EVAL_DIR, 'recorded/kimi.json');
const BASELINE_FILE = path.join(EVAL_DIR, 'baseline.json');

const engine = require(path.join(BACKEND, 'src/services/aiTrackerScanEngine'));
const { analyzeResponse, isSameBrand } = engine;

function loadRows() {
  const rows = [];
  for (const f of ['synthetic.json', 'adversarial.json', 'harvested.json']) {
    const p = path.join(EVAL_DIR, 'answers', f);
    if (fs.existsSync(p)) rows.push(...JSON.parse(fs.readFileSync(p, 'utf8')));
  }
  return rows;
}

function loadLabels() {
  const labels = {};
  for (const f of ['labels.json', 'labels-harvested.json']) {
    const p = path.join(EVAL_DIR, f);
    if (!fs.existsSync(p)) continue;
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(p, 'utf8')))) {
      if (k.startsWith('_')) continue;
      labels[k] = v;
    }
  }
  return labels;
}

/** Greedy semantic matching between predicted and labeled brand sets. */
function matchBrands(predicted, labeled) {
  const usedPred = new Set();
  let matched = 0;
  for (const want of labeled) {
    const idx = predicted.findIndex((p, i) => !usedPred.has(i) && isSameBrand(p, want));
    if (idx >= 0) {
      usedPred.add(idx);
      matched++;
    }
  }
  return matched;
}

async function runEval({ mode = 'mocked', record = false, onProgress = null } = {}) {
  const rows = loadRows();
  const labels = loadLabels();
  const recorded = fs.existsSync(RECORDED_FILE) ? JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8')) : {};
  const newRecordings = { ...recorded };

  const origFetch = global.fetch;
  const origKey = process.env.OPENROUTER_API_KEY;
  // The engine logs its happy path via console.log — reroute to stderr for
  // the duration so the runner's stdout stays pure JSON.
  const origConsoleLog = console.log;
  console.log = (...a) => process.stderr.write(a.join(' ') + '\n');

  if (mode === 'live') {
    // .env.local FIRST: backend/.env defines OPENROUTER_API_KEY= (empty), and
    // dotenv never overrides an existing var — loading .env first would lock
    // in the empty string and silently push every row to the regex fallback.
    const dotenv = require(path.join(BACKEND, 'node_modules/dotenv'));
    dotenv.config({ path: path.join(BACKEND, '.env.local') });
    dotenv.config({ path: path.join(BACKEND, '.env') });
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('--live requires OPENROUTER_API_KEY (backend/.env.local)');
    }
  } else if (mode === 'fallback') {
    delete process.env.OPENROUTER_API_KEY; // forces _fallbackAnalysis
  } else {
    process.env.OPENROUTER_API_KEY = 'eval-mock-key';
  }

  const report = {
    mode,
    generatedAt: new Date().toISOString(),
    scored: 0,
    skippedNoLabel: 0,
    skippedDraft: 0,
    skippedNoRecording: 0,
    knownLimitations: [],
    failures: [],
  };

  const agg = {
    mentioned: { hit: 0, total: 0 },
    cited: { hit: 0, total: 0 },
    sentiment: { hit: 0, total: 0 },
    brands: { matched: 0, labeled: 0, predicted: 0 },
    position: { present: 0, total: 0 },
  };

  try {
    for (const row of rows) {
      const label = labels[row.id];
      if (!label) { report.skippedNoLabel++; continue; }
      if (label.draft) { report.skippedDraft++; continue; }

      // Known-limitation rows (e.g. adv-05 slice-8000) are live-mode probes:
      // in mocked mode they carry no recording BY DESIGN and must not count
      // as anomalies; in live mode they run and get reported below.
      const excluded = label.knownLimitation || row.knownLimitation;
      if (excluded && mode === 'mocked') {
        report.knownLimitations.push({ id: row.id, limitation: excluded, note: 'not exercisable in mocked mode' });
        continue;
      }

      if (mode === 'mocked') {
        if (!recorded[row.id]) { report.skippedNoRecording++; continue; }
        global.fetch = async (url) => {
          if (!String(url).includes('openrouter.ai')) {
            throw new Error(`eval mock: unexpected fetch to ${url}`);
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => recorded[row.id],
            text: async () => JSON.stringify(recorded[row.id]),
          };
        };
      } else if (mode === 'live' && record) {
        // Capture the raw OpenRouter body while passing it through.
        const realFetch = origFetch;
        global.fetch = async (url, init) => {
          const res = await realFetch(url, init);
          if (String(url).includes('openrouter.ai') && res.ok) {
            const body = await res.json();
            newRecordings[row.id] = body;
            return {
              ok: true,
              status: res.status,
              headers: res.headers,
              json: async () => body,
              text: async () => JSON.stringify(body),
            };
          }
          return res;
        };
      }

      const result = await analyzeResponse(row.answer, row.query, row.targetBrand, row.domain, null);
      if (onProgress) onProgress(row.id, result);

      const rowFailures = [];
      const check = (field, expected, got) => {
        if (expected !== got) rowFailures.push({ id: row.id, field, expected, got });
      };

      if (excluded) {
        report.knownLimitations.push({
          id: row.id,
          limitation: excluded,
          mentionedGot: result.mentioned,
          mentionedExpected: label.mentioned,
        });
        continue;
      }

      report.scored++;

      agg.mentioned.total++;
      if (result.mentioned === label.mentioned) agg.mentioned.hit++;
      else check('mentioned', label.mentioned, result.mentioned);

      agg.cited.total++;
      if (result.cited === label.cited) agg.cited.hit++;
      else check('cited', label.cited, result.cited);

      if (label.sentiment !== null) {
        agg.sentiment.total++;
        if (result.sentiment === label.sentiment) agg.sentiment.hit++;
        else check('sentiment', label.sentiment, result.sentiment);
      }

      const predictedBrands = (result.brandRanking || []).map((b) => b.brandName);
      const matched = matchBrands(predictedBrands, label.brands);
      agg.brands.matched += matched;
      agg.brands.labeled += label.brands.length;
      agg.brands.predicted += predictedBrands.length;
      if (label.brands.length > 0 && matched < label.brands.length) {
        check('brandRecall', label.brands.join('|'), predictedBrands.join('|'));
      }

      if (label.mentioned) {
        agg.position.total++;
        if (result.position != null) agg.position.present++;
        else check('positionPresent', 'non-null', null);
      }

      // Safety: no unsafe URL may survive into citedUrls, ever. Without this
      // the eval merely RUNS the filter without asserting it (review fix —
      // the boolean `cited` would pass even if unsafe URLs leaked through).
      const unsafe = (result.citedUrls || []).filter((u) =>
        /^(javascript:|data:|file:|vbscript:)/i.test(u) ||
        /^https?:\/\/(localhost|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u),
      );
      agg.unsafeLeakRows = (agg.unsafeLeakRows || 0) + (unsafe.length > 0 ? 1 : 0);
      if (unsafe.length > 0) check('unsafeCitationLeak', 'none', unsafe.join('|'));

      report.failures.push(...rowFailures);
    }
  } finally {
    global.fetch = origFetch;
    console.log = origConsoleLog;
    if (origKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = origKey;
  }

  if (record) {
    fs.mkdirSync(path.dirname(RECORDED_FILE), { recursive: true });
    fs.writeFileSync(RECORDED_FILE, JSON.stringify(newRecordings, null, 2));
  }

  const pct = (h, t) => (t === 0 ? null : Math.round((h / t) * 1000) / 10);
  report.scores = {
    mentionedAcc: pct(agg.mentioned.hit, agg.mentioned.total),
    citedAcc: pct(agg.cited.hit, agg.cited.total),
    sentimentAcc: pct(agg.sentiment.hit, agg.sentiment.total),
    brandRecall: pct(agg.brands.matched, agg.brands.labeled),
    brandPrecision: pct(agg.brands.matched, agg.brands.predicted),
    positionPresent: pct(agg.position.present, agg.position.total),
    unsafeLeakRows: agg.unsafeLeakRows || 0,
  };
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--live') ? 'live' : args.includes('--fallback') ? 'fallback' : 'mocked';
  const record = args.includes('--record');

  const report = await runEval({
    mode,
    record,
    onProgress: mode === 'live' ? (id) => process.stderr.write(`  ${id}\n`) : null,
  });

  console.log(JSON.stringify(report, null, 2));
  if (args.includes('--write-baseline')) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(report, null, 2));
    console.error(`[eval] baseline written to ${BASELINE_FILE}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[eval] failed:', e.message);
    process.exit(1);
  });
}

module.exports = { runEval, RECORDED_FILE, BASELINE_FILE };
