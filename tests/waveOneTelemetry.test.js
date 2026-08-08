'use strict';

/**
 * Wave 1 (§4b server emits + §4c schema additions).
 *
 * 1. Registry pins: all 11 server-lane events registered — recordObservation
 *    SILENTLY drops unregistered names, so a rename kills an emit with no
 *    error anywhere. This is the failure mode that hid ai_removed_restored.
 * 2. Backend emit-site scanner: every recordObservation('name') in src/ must
 *    be in the registry (the server-lane twin of observeRegistryConformance).
 * 3. Schema pins: the §4c fields exist with the exact enums the dashboard
 *    queries will filter on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EVENTS, ALLOWED_EVENTS } = require('../src/config/analyticsEvents');

// ─── 1. Registry pins ───────────────────────────────────────

const WAVE1_SERVER_EVENTS = [
  'quota_denied',
  'keyword_search',
  'keyword_detail_opened',
  'keyword_history_replayed',
  'keyword_history_deleted',
  'readability_check_run',
  'import_url_succeeded',
  'report_share_opened',
  'report_pdf_exported',
  'onboarding_completed',
  'onboarding_skipped',
];

test('all 11 Wave 1 server events are registered with lane=server', () => {
  for (const e of WAVE1_SERVER_EVENTS) {
    assert.ok(ALLOWED_EVENTS.has(e), `${e} must be registered — recordObservation drops unregistered names silently`);
    assert.equal(EVENTS[e].lane, 'server', `${e} lane`);
  }
});

// ─── 2. Backend emit-site scanner ───────────────────────────

test('CONFORMANCE: every recordObservation() emit in src/ is registered', () => {
  const SRC = path.resolve(__dirname, '../src');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(SRC);

  const found = new Map();
  const RE = /recordObservation\(\s*['"]([a-z][a-z0-9_]*)['"]/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src)) !== null) {
      if (!found.has(m[1])) found.set(m[1], path.relative(SRC, f));
    }
  }
  assert.ok(found.size >= WAVE1_SERVER_EVENTS.length, 'expected to find the Wave 1 emit sites');
  const unregistered = [...found.entries()].filter(([n]) => !ALLOWED_EVENTS.has(n));
  assert.deepEqual(unregistered, [],
    'backend emits event(s) missing from the registry — they are silently dropped: '
    + unregistered.map(([n, f]) => `${n} (${f})`).join(', '));
  // And every Wave 1 event actually HAS an emit site (no dead registry entries).
  for (const e of WAVE1_SERVER_EVENTS) {
    assert.ok(found.has(e), `${e} is registered but never emitted anywhere in src/`);
  }
});

// ─── 3. Schema pins (§4c) ───────────────────────────────────

test('AiTrackerScan carries trigger + triggeredBy', () => {
  const AiTrackerScan = require('../src/models/AiTrackerScan');
  const trigger = AiTrackerScan.schema.path('trigger');
  assert.ok(trigger, 'trigger field exists');
  assert.deepEqual(trigger.enumValues.sort(), ['cron', 'manual', 'refresh_all', 'single']);
  assert.ok(AiTrackerScan.schema.path('triggeredBy'), 'triggeredBy field exists');
});

test('AiTrackerPrompt carries source (manual|suggested, default manual)', () => {
  const AiTrackerPrompt = require('../src/models/AiTrackerPrompt');
  const source = AiTrackerPrompt.schema.path('source');
  assert.deepEqual(source.enumValues.sort(), ['manual', 'suggested']);
  assert.equal(source.defaultValue, 'manual');
});

test('AgentUsageLog carries the run-record telemetry fields', () => {
  const AgentUsageLog = require('../src/models/AgentUsageLog');
  for (const f of ['startedAt', 'impersonatedBy', 'voiceId', 'avatarId']) {
    assert.ok(AgentUsageLog.schema.path(f), `${f} field exists`);
  }
});

test('Content carries createdVia (blank|url|keyword|template, default blank)', () => {
  const Content = require('../src/models/Content');
  const createdVia = Content.schema.path('createdVia');
  assert.deepEqual(createdVia.enumValues.sort(), ['blank', 'keyword', 'template', 'url']);
  assert.equal(createdVia.defaultValue, 'blank');
});
