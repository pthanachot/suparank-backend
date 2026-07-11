/**
 * Phase 4 — tier-aware model presets (Node side).
 *  - tierToPreset maps Free → "budget", paid → "".
 *  - the writing-engine content calls send X-Model-Preset only when a preset is set.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tierToPreset } = require('../src/config/modelPreset');
const writingEngine = require('../src/services/writingEngine');

test('tierToPreset: Free → budget, paid/unknown → base ("")', () => {
  assert.equal(tierToPreset('free'), 'budget');
  assert.equal(tierToPreset('standard'), '');
  assert.equal(tierToPreset('professional'), '');
  assert.equal(tierToPreset('agency'), '');
  assert.equal(tierToPreset(''), '');
  assert.equal(tierToPreset(undefined), '');
});

// Capture the headers a writing-engine call sends.
async function captureHeaders(fn) {
  const orig = global.fetch;
  let headers = null;
  global.fetch = async (_url, opts) => {
    headers = opts.headers;
    return { ok: true, status: 200, body: null, json: async () => ({ sessionId: 'x' }), text: async () => '' };
  };
  try { await fn(); } finally { global.fetch = orig; }
  return headers;
}

test('chat: sends X-Model-Preset when preset is set', async () => {
  const h = await captureHeaders(() =>
    writingEngine.sendChatMessageStream('s1', 'hi', undefined, 'budget'));
  assert.equal(h['X-Model-Preset'], 'budget');
});

test('chat: omits X-Model-Preset for paid (empty preset)', async () => {
  const h = await captureHeaders(() =>
    writingEngine.sendChatMessageStream('s1', 'hi', undefined, ''));
  assert.equal('X-Model-Preset' in h, false);
});

test('agent: sends X-Model-Preset when preset is set', async () => {
  const h = await captureHeaders(() =>
    writingEngine.startAgent('s1', 'goal', 75, 5, undefined, undefined, 'freeform', 'budget'));
  assert.equal(h['X-Model-Preset'], 'budget');
});

test('agent: omits X-Model-Preset for paid (empty preset)', async () => {
  const h = await captureHeaders(() =>
    writingEngine.startAgent('s1', 'goal', 75, 5, undefined, undefined, 'freeform', ''));
  assert.equal('X-Model-Preset' in h, false);
});
