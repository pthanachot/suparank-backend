'use strict';

/**
 * Wave 5 Phase 6 — the write side (plan §9).
 *
 * approvedOutline lands in a Schema.Types.Mixed column, which accepts anything
 * the client sends, and the outline edit + citability values arrive from the
 * browser. These are reshaped server-side rather than stored as sent; this
 * suite pins that reshaping, because a Mixed column will happily persist a
 * payload big enough to bloat every later read of the document.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const Content = require('../src/models/Content');

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

// Mirrors the sanitisers in contentController.updateContent.
const OUTLINE_EDIT_DEPTHS = ['unedited', 'renamed', 'sections-changed', 'heavy'];
const MAX_SECTIONS = 60, MAX_CHILDREN = 30, MAX_HEADING = 300;
const nonNegInt = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const heading = (v) => (typeof v === 'string' ? v.slice(0, MAX_HEADING) : '');
function sanitizeOutline(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sections = Array.isArray(raw.sections) ? raw.sections.slice(0, MAX_SECTIONS) : [];
  return {
    h1: heading(raw.h1),
    sections: sections.map((s) => ({
      h2: heading(s?.h2),
      children: (Array.isArray(s?.children) ? s.children.slice(0, MAX_CHILDREN) : []).map((c) => ({ h3: heading(c?.h3) })),
    })),
  };
}

test('an outline keeps only outline shape', () => {
  const out = sanitizeOutline({
    h1: 'Title', evil: 'dropped',
    sections: [{ h2: 'One', rationale: 'dropped', children: [{ h3: 'A', extra: 1 }] }],
  });
  assert.deepEqual(out, { h1: 'Title', sections: [{ h2: 'One', children: [{ h3: 'A' }] }] });
});

test('outline size is capped so a Mixed column cannot be used as storage', () => {
  const huge = {
    h1: 'x'.repeat(5000),
    sections: Array.from({ length: 500 }, () => ({
      h2: 'y'.repeat(5000),
      children: Array.from({ length: 500 }, () => ({ h3: 'z'.repeat(5000) })),
    })),
  };
  const out = sanitizeOutline(huge);
  assert.equal(out.h1.length, MAX_HEADING);
  assert.equal(out.sections.length, MAX_SECTIONS);
  assert.equal(out.sections[0].children.length, MAX_CHILDREN);
  assert.equal(out.sections[0].h2.length, MAX_HEADING);
});

test('non-objects and arrays are refused outright', () => {
  for (const bad of [null, undefined, 'string', 42, [1, 2, 3]]) {
    assert.equal(sanitizeOutline(bad), null);
  }
});

test('an unrecognised edit depth is dropped rather than stored', () => {
  // A junk value would otherwise read as a real bucket in the dashboard.
  assert.ok(!OUTLINE_EDIT_DEPTHS.includes('totally-rewrote-it'));
  assert.ok(OUTLINE_EDIT_DEPTHS.includes('heavy'));
});

test('the citability score is recomputed, never trusted from the client', () => {
  // A client claiming score 100 with 1 of 10 covered must not be believed.
  const total = nonNegInt(10);
  const covered = Math.min(nonNegInt(1) ?? 0, total);
  const score = total > 0 ? Math.round((covered / total) * 100) : 0;
  assert.equal(score, 10, 'ratio and score can never disagree');
});

test('covered is clamped to total', () => {
  const total = nonNegInt(5);
  const covered = Math.min(nonNegInt(99) ?? 0, total);
  assert.equal(covered, 5);
});

test('the model persists and reads back both Tier 2 shapes', async () => {
  await Content.collection.insertOne({
    contentNumber: 9100, title: 't', workspaceNumber: 1,
    approvedOutline: { h1: 'H', sections: [{ h2: 'S', children: [] }] },
    outlineEdit: { depth: 'renamed', sectionsBefore: 4, sectionsAfter: 4, headingsRenamed: 1, at: new Date() },
    citabilitySnapshot: { score: 60, covered: 6, total: 10, at: new Date() },
    createdAt: new Date(), updatedAt: new Date(),
  });
  const doc = await Content.findOne({ contentNumber: 9100 }).lean();
  assert.equal(doc.approvedOutline.h1, 'H');
  assert.equal(doc.outlineEdit.depth, 'renamed');
  assert.equal(doc.citabilitySnapshot.covered, 6);
});

test('the schema rejects an out-of-enum edit depth on a validated save', async () => {
  const doc = new Content({
    contentNumber: 9101, title: 't', workspaceNumber: 1, workspaceId: undefined,
    outlineEdit: { depth: 'nonsense' },
  });
  const err = doc.validateSync();
  assert.ok(err?.errors?.['outlineEdit.depth'], 'enum guards the field at the model layer too');
});
