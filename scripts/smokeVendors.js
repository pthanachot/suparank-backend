/**
 * DAILY LIVE SMOKE — the drift tripwire (test plan Phase 9).
 *
 * Makes ONE real call per configured vendor plus one analyzer call, and
 * asserts the RESPONSE SHAPE the scan engine actually parses. This is the
 * only layer that can catch what mocked tests never will:
 *   - a model id that was deprecated (404/400 from the vendor)
 *   - a revoked/expired API key (401) — the G-01 class of silent failure
 *   - a response-schema change (fields the parser reads disappearing)
 *
 * Opt-in and real-money: requires SMOKE=1. Skips (does not fail) vendors
 * whose key is absent, so it works on partial configurations.
 *
 * Usage:
 *   SMOKE=1 node scripts/smokeVendors.js
 *   SMOKE=1 node scripts/smokeVendors.js --json     (machine-readable)
 *
 * Exit codes: 0 all-configured-vendors healthy · 1 drift detected · 2 misuse.
 * Schedule daily (cron/launchd); alert on any non-zero exit.
 */

const path = require('path');
const dotenv = require(path.join(__dirname, '../node_modules/dotenv'));

// .env.local FIRST — backend/.env intentionally holds empty vendor keys.
dotenv.config({ path: path.join(__dirname, '../.env.local') });
dotenv.config({ path: path.join(__dirname, '../.env') });

// The guard applies to EXECUTING the smoke, not to requiring it. Tests import
// this module to exercise the verify() predicates against fixtures (no network,
// no keys); running it directly still demands SMOKE=1 because every probe makes
// a real, billed vendor call.
if (require.main === module && process.env.SMOKE !== '1') {
  console.error('[smoke] refusing to run: set SMOKE=1 (this makes REAL, billed vendor calls)');
  process.exit(2);
}

const JSON_OUT = process.argv.includes('--json');
const QUERY = 'best seo tools 2026';
const engine = require(path.join(__dirname, '../src/services/aiTrackerScanEngine'));
// Phase C4: the keyword vendors were never smoked — only the AI-Tracker four.
const keywordService = require(path.join(__dirname, '../src/services/keywordService'));
const { COUNTRY_LOCALES } = require(path.join(__dirname, '../src/config/locales'));

/** Each probe: key it needs, the call, and the shape contract we depend on. */
const PROBES = [
  {
    id: 'chatgpt',
    key: 'CHATGPT_API_KEY',
    run: () => engine.searchChatGPT(QUERY, null),
    // F3/F4: `Array.isArray(citations)` was ALWAYS true — the engine builds
    // `const citations = []` unconditionally — so the check was dead code and
    // the probe reduced to "did we get text". A vendor that stops returning
    // citations (schema change, grounding disabled) passed cleanly, which is
    // exactly the drift this script's header claims to catch.
    verify: (r) => {
      if (!r || typeof r.answer !== 'string' || r.answer.trim().length === 0) return 'empty answer';
      if (!Array.isArray(r.citations) || r.citations.length === 0) return 'ZERO citations — parser or vendor schema drift';
      if (!Array.isArray(r.fanoutQueries)) return 'fanoutQueries not an array';
      // F4: the engine silently falls back from the Responses API to Chat
      // Completions on a 400/404 (deprecated model, changed tool contract),
      // losing fanout capture. Both flags were returned and never inspected —
      // so "a model id was deprecated", purpose #1 of this script, was
      // undetectable on ChatGPT's primary path.
      if (r.fanoutUnavailable) return 'FELL BACK to Chat Completions (Responses API rejected us — deprecated model?)';
      if (typeof r.modelVariant === 'string' && r.modelVariant.endsWith('-fallback')) {
        return `running on fallback model variant: ${r.modelVariant}`;
      }
      if (r.fanoutQueries.length === 0) return 'no fanout queries — web_search tool may not have run';
      return null;
    },
  },
  {
    id: 'gemini',
    key: 'GEMINI_API_KEY',
    run: () => engine.searchGemini(QUERY, null),
    verify: (r) => {
      if (!r?.answer?.trim()) return 'empty answer';
      if (!Array.isArray(r.citations) || r.citations.length === 0) return 'ZERO citations — grounding disabled or groundingChunks schema drift';
      // G2: when the grounding-redirect HEAD fails, the engine falls back to
      // storing the Google wrapper URL. It looks like a valid citation but can
      // never match a tracked domain, so every "cited" verdict silently
      // becomes "mentioned".
      const wrapped = r.citations.filter((u) => typeof u === 'string' && u.includes('vertexaisearch.cloud.google.com'));
      if (wrapped.length) return `${wrapped.length} unresolved grounding-redirect URL(s) — redirect resolution is failing`;
      return null;
    },
  },
  {
    id: 'claude',
    key: 'ANTHROPIC_API_KEY',
    run: () => engine.searchClaude(QUERY, null),
    verify: (r) => {
      if (!r?.answer?.trim()) return 'empty answer';
      if (!Array.isArray(r.citations) || r.citations.length === 0) return 'ZERO citations — web_search_tool_result schema drift';
      return null;
    },
  },
  {
    id: 'perplexity',
    key: 'PERPLEXITY_API_KEY',
    run: () => engine.searchPerplexity(QUERY, null),
    verify: (r) => {
      if (!r?.answer?.trim()) return 'empty answer';
      // The engine reads `data.citations`; Perplexity moving it (e.g. to
      // `search_results`) would zero out the product's core signal silently.
      if (!Array.isArray(r.citations) || r.citations.length === 0) return 'ZERO citations — `data.citations` may have moved';
      return null;
    },
  },
  {
    id: 'analyzer(kimi)',
    key: 'OPENROUTER_API_KEY',
    run: () => engine.analyzeResponse(
      'SupaRank leads AI visibility tracking [suparank.com](https://suparank.com/features). Ahrefs is strong for backlinks [ahrefs.com](https://ahrefs.com).',
      QUERY, 'SupaRank', 'suparank.com', null,
    ),
    // The analyzer NEVER throws — it silently degrades to regex. An empty
    // brandRanking with a mentioned target is the fingerprint of that
    // fallback, i.e. the key/model is broken. This is the check that would
    // have caught the 401 we hit during Phase 6.
    verify: (r) => {
      if (!r) return 'no result';
      if (r.mentioned !== true) return 'target brand not detected in a control answer';
      if (!Array.isArray(r.brandRanking) || r.brandRanking.length === 0) return 'FELL BACK TO REGEX (bad key/model or vendor down)';
      if (r.position == null) return 'position null → fallback path';
      return null;
    },
  },
  // ── Phase C4: keyword-research vendors ────────────────────────────────────
  {
    id: 'dataforseo',
    key: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    run: () => keywordService.fetchRelatedKeywords('seo tools', 'United States', 'en'),
    // Mirrors the field paths tests/keywords/schema-contract.test.js pins
    // against fixtures. If DataForSEO renames one, the mapper defaults it to
    // 0 and the product silently shows zeros — only a LIVE call catches that.
    verify: (r) => {
      if (!r || !Array.isArray(r.related)) return 'related not an array';
      if (r.related.length === 0) return 'zero related keywords for a common seed';
      const row = r.related[0];
      if (typeof row.keyword !== 'string' || !row.keyword) return 'row.keyword missing';
      if (typeof row.searchVolume !== 'number') return 'row.searchVolume not a number';
      if (typeof row.keywordDifficulty !== 'number') return 'row.keywordDifficulty not a number';
      if (!Array.isArray(row.monthlySearches)) return 'row.monthlySearches not an array';
      // Every metric reading exactly 0 is the fingerprint of a renamed field.
      const allZero = r.related.every((x) => x.searchVolume === 0 && x.keywordDifficulty === 0 && x.cpc === 0);
      if (allZero) return 'EVERY metric is 0 — probable vendor field rename mapping to defaults';
      return null;
    },
  },
  {
    id: 'serper',
    key: 'SERPER_API_KEY',
    run: () => keywordService.fetchSerpResults('seo tools', 'us', 'en'),
    verify: (r) => {
      if (!r || !Array.isArray(r.organic)) return 'organic not an array';
      if (r.organic.length === 0) return 'zero organic results for a common query';
      const row = r.organic[0];
      if (!row.title || !row.link) return 'organic row missing title/link';
      if (!row.domain) return 'domain not derived from link';
      if (!Array.isArray(r.peopleAlsoAsk)) return 'peopleAlsoAsk not an array';
      return null;
    },
  },
  {
    // The 53 location codes have been carried since the URL-IMPORT plan and
    // NEVER validated against DataForSEO's published list. A wrong code does
    // not error — DataForSEO happily returns data for the WRONG COUNTRY, so
    // this can only be caught by comparing against the live locations list.
    id: 'dataforseo-location-codes',
    key: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    run: async () => {
      const auth = Buffer.from(
        `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
      ).toString('base64');
      // F11: this was the only unbounded request in the file. A server that
      // accepts the connection and never responds hung the daily cron forever,
      // so the "alert on non-zero exit" contract never fired — absence of an
      // exit is not monitored.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let body;
      try {
        const res = await fetch(
          'https://api.dataforseo.com/v3/dataforseo_labs/locations_and_languages',
          { headers: { Authorization: `Basic ${auth}` }, signal: controller.signal },
        );
        body = await res.json();
      } finally {
        clearTimeout(timeout);
      }
      const published = new Map();
      for (const task of body.tasks || []) {
        for (const row of task.result || []) {
          if (row.location_code != null) published.set(row.location_code, row.location_name);
        }
      }
      return { published, ours: COUNTRY_LOCALES };
    },
    verify: ({ published, ours }) => {
      if (published.size === 0) return 'could not read the published locations list';
      const bad = [];
      const mismatched = [];
      for (const [code, entry] of Object.entries(ours)) {
        if (entry.locationCode == null) continue;
        if (!published.has(entry.locationCode)) {
          bad.push(`${code}: location_code ${entry.locationCode} is not published`);
          continue;
        }
        // F9: presence alone was checked, which cannot detect the failure the
        // comment above describes. A code that EXISTS but denotes a different
        // country returns data for the wrong market with no error — the whole
        // point of validating these. The name was already in hand and unused.
        const publishedName = published.get(entry.locationCode);
        if (publishedName && entry.locationName && publishedName !== entry.locationName) {
          mismatched.push(`${code}: ${entry.locationCode} is "${publishedName}", we call it "${entry.locationName}"`);
        }
      }
      if (bad.length) return `${bad.length} invalid location_code(s): ${bad.slice(0, 5).join('; ')}`;
      if (mismatched.length) {
        return `${mismatched.length} location_code(s) point at the WRONG COUNTRY: ${mismatched.slice(0, 5).join('; ')}`;
      }
      return null;
    },
  },
];

async function main() {
  const started = Date.now();
  const results = [];

  for (const probe of PROBES) {
    // A probe may need more than one variable (DataForSEO is login+password);
    // a partially-configured vendor must SKIP, not report false drift.
    const needed = Array.isArray(probe.key) ? probe.key : [probe.key];
    const missing = needed.filter((k) => !process.env[k]);
    if (missing.length) {
      results.push({ id: probe.id, status: 'skipped', reason: `${missing.join(', ')} not set` });
      continue;
    }
    const t0 = Date.now();
    try {
      const out = await probe.run();
      const problem = probe.verify(out);
      results.push({
        id: probe.id,
        status: problem ? 'drift' : 'ok',
        ms: Date.now() - t0,
        ...(problem ? { problem } : {}),
        ...(out?.answer ? { answerLen: out.answer.length, citations: out.citations?.length ?? 0 } : {}),
        ...(out?.brandRanking ? { brands: out.brandRanking.length, position: out.position } : {}),
      });
    } catch (e) {
      results.push({ id: probe.id, status: 'error', ms: Date.now() - t0, error: e.message.slice(0, 160) });
    }
  }

  const bad = results.filter((r) => r.status === 'drift' || r.status === 'error');
  const ran = results.filter((r) => r.status !== 'skipped');

  // F2: "skipped" used to count as healthy, so a box with no .env.local ran
  // ZERO probes, printed "healthy", and exited 0 — a cron alerting on non-zero
  // exit stayed green forever while testing nothing. A run that checked
  // nothing is not a healthy run.
  const ranNothing = ran.length === 0;

  // --require=chatgpt,gemini,... fails when a named probe did not actually run,
  // so a deploy that loses one key is caught instead of silently skipping.
  const requireArg = process.argv.find((a) => a.startsWith('--require='));
  const required = requireArg ? requireArg.slice('--require='.length).split(',').filter(Boolean) : [];
  const missingRequired = required.filter(
    (id) => !results.some((r) => r.id === id && r.status !== 'skipped'),
  );

  const healthy = bad.length === 0 && !ranNothing && missingRequired.length === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    totalMs: Date.now() - started,
    results,
    probesRun: ran.length,
    probesSkipped: results.length - ran.length,
    ...(missingRequired.length ? { missingRequired } : {}),
    healthy,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`VENDOR SMOKE — ${report.generatedAt}\n`);
    for (const r of results) {
      const tag = { ok: 'OK   ', drift: 'DRIFT', error: 'ERROR', skipped: 'SKIP ' }[r.status];
      const detail = r.problem || r.error || (r.status === 'skipped' ? r.reason : `${r.ms}ms answerLen=${r.answerLen ?? '-'} citations=${r.citations ?? '-'}${r.brands !== undefined ? ` brands=${r.brands} position=${r.position}` : ''}`);
      console.log(`  ${tag} ${r.id.padEnd(15)} ${detail}`);
    }
    const verdict = ranNothing
      ? 'NOTHING RAN — every probe skipped (no credentials?); this is NOT a healthy result'
      : missingRequired.length
        ? `required probe(s) did not run: ${missingRequired.join(', ')}`
        : bad.length === 0
          ? `healthy (${ran.length}/${results.length} probes ran)`
          : `${bad.length} vendor(s) drifting`;
    console.log(`\n${verdict} (${report.totalMs}ms)`);
  }
  // Exit 3 distinguishes "checked nothing" from "checked and found drift" (1),
  // so alerting can tell a broken deploy from a broken vendor.
  if (ranNothing || missingRequired.length) process.exit(3);
  process.exit(bad.length === 0 ? 0 : 1);
}

// F14: the tripwire had zero tests and PROBES was not exported, so no verify()
// could be exercised against a fixture — which is why F3/F4/F9 (probes that
// cannot detect their own stated failure) survived. Exported for
// tests/aiTracker/smoke-probes.test.js. Requiring this file does NOT run
// main(); the SMOKE=1 guard above still gates every real call.
module.exports = { PROBES };

if (require.main === module) {
  main().catch((e) => {
    console.error('[smoke] harness error:', e.message);
    process.exit(2);
  });
}
