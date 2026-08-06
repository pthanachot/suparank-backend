/**
 * Phase 6 — synthetic Kimi recordings (stopgap until a working OpenRouter
 * key allows `run.js --live --record` to replace this file with REAL model
 * outputs; the dev key currently 401s).
 *
 * Each recording is an OpenRouter-shaped body whose content is a RAW,
 * messy extraction derived from the ground-truth labels: duplicate brand
 * entries (exercises mentionCount merging), casing variants (isSameBrand
 * dedupe), UNSAFE citation URLs passed through verbatim (the pipeline must
 * filter them), fenced JSON on every third row (fence stripping), and
 * label-consistent sentiment scores. Replaying these makes the mocked eval
 * a PIPELINE-fidelity gate: parsing, dedupe, URL safety, sentiment
 * re-derivation, position math — not model quality.
 *
 * Skipped rows: adv-05 (slice-8000 — only meaningful live).
 *
 * Usage: node tests/aiTracker/eval/genSyntheticRecordings.js
 */

const fs = require('fs');
const path = require('path');

const EVAL_DIR = __dirname;
const OUT = path.join(EVAL_DIR, 'recorded/kimi.json');

const answers = [
  ...JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'answers/synthetic.json'), 'utf8')),
  ...JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'answers/adversarial.json'), 'utf8')),
];
const labels = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'labels.json'), 'utf8'));

/** All link URLs in the answer, RAW — markdown AND html hrefs, including
 *  unsafe ones (a capable model extracts both; the pipeline must filter). */
function rawUrls(answer) {
  const urls = [];
  const md = /\]\(([^)\s]+(?:\([^)]*\)[^)\s]*)?)\)/g;
  let m;
  while ((m = md.exec(answer)) !== null) urls.push(m[1]);
  const href = /href="([^"]+)"/g;
  while ((m = href.exec(answer)) !== null) urls.push(m[1]);
  return urls;
}

const recordings = { _meta: { synthetic: true, note: 'replace via run.js --live --record once a working OPENROUTER_API_KEY exists' } };

let i = 0;
for (const row of answers) {
  const label = labels[row.id];
  if (!label || row.id === 'adv-05') continue;
  i++;

  // Raw brand list: labeled truth + realistic mess.
  const brands = [...label.brands];
  if (brands.length > 0) brands.splice(1, 0, brands[0]); // duplicate first brand → mentionCount merge
  if (row.id === 'adv-16') brands.splice(0, brands.length, 'Semrush', 'SEMrush', 'semrush'); // casing flood
  if (row.id === 'syn-21') brands.splice(0, brands.length, 'HubSpot', 'HubSpot Marketing Hub', 'HubSpot', 'Braze', 'Klaviyo', 'Customer.io');

  const sentiment = label.sentiment
    ? { label: label.sentiment, score: label.sentiment === 'positive' ? 85 : label.sentiment === 'neutral' ? 50 : 20 }
    : null;

  const payload = JSON.stringify({ brands, citationUrls: rawUrls(row.answer), sentiment });
  const content = i % 3 === 0 ? '```json\n' + payload + '\n```' : payload;

  recordings[row.id] = {
    model: 'moonshotai/kimi-k2-0905',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 400, completion_tokens: 90 },
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(recordings, null, 2));
console.log(JSON.stringify({ recordings: i, out: OUT }));
