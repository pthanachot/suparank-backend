/**
 * Design-token allow-list for transactional email (Phase 1).
 *
 * The 14 templates were each written against whatever palette was to hand, and
 * had accumulated THREE competing neutral ramps: Tailwind slate (#e2e8f0,
 * #64748b, #f8fafc, #94a3b8, #f1f5f9), CSS shorthand (#111, #555, #888,
 * #f5f5f5), and a handful of genuine --sr-gray-* tokens. Warnings were raw
 * Tailwind amber rather than --sr-warning-*.
 *
 * An allow-list, not a deny-list, is the point. A deny-list only stops the
 * nine values we happened to find; this fails on ANY hex outside the design
 * system, which is what stops the drift recurring the next time someone adds
 * a template.
 *
 * Both files are covered because the scan-report email is built in two places:
 * the template lives in emailPortalController, but its <tr> fragments are
 * generated in aiTrackerController and substituted in. Sweeping one without
 * the other leaves that table two-toned.
 *
 * Source of truth: suparank/app/(dashboard)/workspace.css (:root token block)
 * and suparank/app/globals.css (--brand-* scale).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const EMAIL_CONTROLLER = path.join(SRC, 'controllers/emailPortalController.js');
const TRACKER_CONTROLLER = path.join(SRC, 'controllers/aiTrackerController.js');
const PREVIEW_SCRIPT = path.join(__dirname, '..', 'scripts', 'previewEmails.js');

// ─── The design system ──────────────────────────────────────

const NEUTRALS = [
  '#F9FAFB', '#F3F4F6', '#E5E7EB', '#D1D5DB', '#9CA3AF',
  '#6B7280', '#4B5563', '#374151', '#1F2937', '#111827',
];
const SURFACES = ['#FFFFFF', '#F7F8FA'];
const SEMANTIC = [
  '#ECFDF5', '#10B981', '#059669', '#047857', // success
  '#FFFBEB', '#D97706', '#B45309',            // warning
  '#FEF2F2', '#FEE2E2', '#EF4444', '#DC2626', '#B91C1C', // error
];
const BRAND = [
  '#EEF2FF', '#E0E9FF', '#C3D3FD', '#93AEFB', '#6088F8',
  '#3B6EF5', '#2B5BE8', '#2248CC', '#1D39A1', '#1A2F7A',
];

const ALLOWED = new Set([...NEUTRALS, ...SURFACES, ...SEMANTIC, ...BRAND]);

// The ramps Phase 1 retired. Redundant with the allow-list, but a named
// failure ("leftover slate") diagnoses faster than "unknown hex".
const RETIRED = {
  '#e2e8f0': 'slate-200 → #E5E7EB',
  '#f8fafc': 'slate-50 → #F9FAFB',
  '#f1f5f9': 'slate-100 → #F3F4F6',
  '#64748b': 'slate-500 → #6B7280',
  '#94a3b8': 'slate-400 → #9CA3AF',
  '#111': 'shorthand → #111827',
  '#555': 'shorthand → #4B5563',
  '#888': 'shorthand → #9CA3AF',
  '#f5f5f5': 'shorthand → #F3F4F6',
  '#f59e0b': 'amber-500 → #D97706',
  '#fef3c7': 'amber-100 → #FFFBEB',
  '#92400e': 'amber-800 → #B45309',
  '#991b1b': 'red-800 → #B91C1C',
  '#4F46E5': 'off-brand indigo → {{primaryColor}}',
  '#22c55e': 'green-500 → #10B981',
  '#dcfce7': 'green-100 → #ECFDF5',
  '#15803d': 'green-700 → #047857',
  '#FFA163': 'ad-hoc star orange → #D97706',
};

// `&#10003;` and friends are HTML entities, not colours — a bare
// /#[0-9a-f]{3,6}/ matches them. Strip entities before scanning.
function hexColorsIn(source) {
  const withoutEntities = source.replace(/&#\d+;/g, '');
  return withoutEntities.match(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g) || [];
}

/**
 * The scan email's row builders, sliced out of aiTrackerController by the
 * markers that bracket them. Asserting the markers exist means a refactor that
 * moves the block fails loudly instead of silently scanning nothing.
 */
function trackerEmailBlock() {
  const src = fs.readFileSync(TRACKER_CONTROLLER, 'utf8');
  const start = src.indexOf('// ── 11. Send scan summary email to workspace owner');
  const end = src.indexOf("applyCustomTemplate('scan_completed'");
  assert.ok(start !== -1, 'scan-email start marker not found — update this test');
  assert.ok(end > start, 'scan-email end marker not found — update this test');
  return src.slice(start, end);
}

/**
 * emailPortalController is an email file end to end, so it is scanned WHOLE
 * rather than sliced. An earlier version of this test only scanned
 * BRAND_HEADER..'Template resolution helpers', which silently left
 * applyCustomTemplate's `primaryColor` fallback outside the guard — the test
 * claimed more coverage than it had.
 */
function templateBlock() {
  return fs.readFileSync(EMAIL_CONTROLLER, 'utf8');
}

/**
 * The preview harness hand-copies the scan email's <tr> fragments, because the
 * real builders are inline inside executeScan and cannot be imported. That
 * copy drifted out of the token sweep once already — the review tool was
 * rendering the retired palette while the shipped code rendered the new one,
 * which makes every screenshot taken from it a lie. Guarding it here is the
 * cheap half of the fix; the structural drift remains a known limitation.
 */
function previewFixture() {
  const src = fs.readFileSync(PREVIEW_SCRIPT, 'utf8');
  // TENANT_BRAND holds a deliberately foreign colour — the fixture exists to
  // prove an agency's own primaryColor reaches the CTA, so it MUST NOT be a
  // SupaRank token. Cut that one declaration rather than allow-listing the
  // value, which would also let it pass inside a real template.
  const start = src.indexOf('const TENANT_BRAND = {');
  assert.ok(start !== -1, 'TENANT_BRAND marker not found — update this test');
  const end = src.indexOf('};', start);
  assert.ok(end > start, 'TENANT_BRAND is not a closed object literal');
  return src.slice(0, start) + src.slice(end);
}

const SOURCES = [
  ['email templates', templateBlock],
  ['scan-report row builders', trackerEmailBlock],
  ['preview harness fixture', previewFixture],
];

// ─── Tests ──────────────────────────────────────────────────

describe('email colour allow-list', () => {
  for (const [label, read] of SOURCES) {
    it(`${label}: every hex is a design token`, () => {
      const found = [...new Set(hexColorsIn(read()))];
      const strays = found.filter((hex) => !ALLOWED.has(hex.toUpperCase()));
      assert.deepEqual(
        strays,
        [],
        `${label}: ${strays.length} colour(s) outside the design system: ${strays.join(', ')}`
      );
    });

    it(`${label}: no retired ramp survives`, () => {
      const src = read();
      for (const [hex, fix] of Object.entries(RETIRED)) {
        // `#` is not a regex metacharacter, so the literal needs no escaping.
        assert.doesNotMatch(
          src,
          new RegExp(`${hex}\\b`, 'i'),
          `${label}: retired colour ${hex} — ${fix}`
        );
      }
    });

    it(`${label}: hex values are uppercase`, () => {
      // Mixed case defeats the allow-list at a glance and makes review noisy;
      // the token definitions in workspace.css are uppercase.
      const lower = [...new Set(hexColorsIn(read()))].filter(
        (hex) => /[a-f]/.test(hex) && hex !== hex.toUpperCase()
      );
      assert.deepEqual(lower, [], `${label}: lowercase hex: ${lower.join(', ')}`);
    });
  }

  it('the neutral ramp actually reaches the templates', () => {
    // Guards the markers above: if a future refactor made templateBlock()
    // return an empty slice, every assertion here would vacuously pass.
    const found = hexColorsIn(templateBlock());
    assert.ok(found.length > 50, `expected a populated template block, found ${found.length} colours`);
    for (const token of ['#111827', '#4B5563', '#E5E7EB']) {
      assert.ok(found.includes(token), `expected ${token} in the swept templates`);
    }
  });
});
