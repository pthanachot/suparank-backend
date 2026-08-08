'use strict';

/**
 * Wave 0 (§3.2) — anti-drift CI guard for the analytics event registry.
 *
 * Walks the frontend's client-side emit sites and fails when an emitted event
 * name is missing from src/config/analyticsEvents.js. This is the exact
 * failure mode that silently dropped `ai_removed_restored` for weeks: the
 * server answered 200 {ok:true} while discarding every batch.
 *
 * Mirrors tests/agentBilling.test.js, which parses the frontend command
 * registry from the monorepo layout (../../suparank).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ALLOWED_EVENTS } = require('../src/config/analyticsEvents');

const FRONTEND_ROOT = path.resolve(__dirname, '../../suparank');
const SCAN_DIRS = ['components', 'app', 'lib'].map((d) => path.join(FRONTEND_ROOT, d));

// observe("name", …) direct calls, plus onObservation("name", …) — usePlanMode
// emits through an injected callback wired to observe() in EditorChatBar.
const EMIT_RE = /\b(?:observe|onObservation)\(\s*["']([a-z][a-z0-9_]*)["']/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
}

function collectEmittedEvents() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(dir, files);
  const found = new Map(); // event → first file it appears in
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    EMIT_RE.lastIndex = 0;
    while ((m = EMIT_RE.exec(src)) !== null) {
      if (!found.has(m[1])) found.set(m[1], path.relative(FRONTEND_ROOT, file));
    }
  }
  return found;
}

test('CONFORMANCE: every frontend observe() emit is in the registry', () => {
  const emitted = collectEmittedEvents();
  assert.ok(emitted.size > 0, 'expected to find observe() call sites in the frontend');
  const unregistered = [...emitted.entries()].filter(([name]) => !ALLOWED_EVENTS.has(name));
  assert.deepEqual(
    unregistered,
    [],
    `frontend emits event(s) missing from src/config/analyticsEvents.js — ` +
      `they will be SILENTLY DROPPED with a 200 response: ` +
      unregistered.map(([n, f]) => `${n} (${f})`).join(', ')
  );
});

test('regression pin: ai_removed_restored is actually emitted by the frontend', () => {
  // If this emit is ever removed, the registry entry should be revisited too —
  // but more importantly, this pins that the scanner finds real emit sites.
  const emitted = collectEmittedEvents();
  assert.ok(
    emitted.has('ai_removed_restored'),
    'expected EditorChatBar to emit ai_removed_restored (scanner may be broken)'
  );
});
