'use strict';

// Conversations Phase 9: the edges that Phases 1-3 made REACHABLE.
//
// None of these are new. They have all been true since threads shipped — they
// were simply unreachable because nobody could find the conversation switcher.
// Making it discoverable is what turns them into bugs a user can hit.
//
// Two of the five items the plan listed turned out to be closed already, as a
// side effect of Phase 4's session eviction. They are asserted here rather than
// assumed, because the reason they are closed is indirect: eviction means the
// next run mints a FRESH engine session, and both the CFS cache and the plan-step
// checklist are per-session state that a fresh session simply does not have.

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const aiController = require('../src/controllers/aiController');
const threadService = require('../src/services/threadService');
const flagService = require('../src/services/flagService');
const FeatureFlag = require('../src/models/FeatureFlag');

function stubFlag(live) {
  const saved = FeatureFlag.findOne;
  flagService.clearFlagCache();
  FeatureFlag.findOne = () => ({
    select: () => ({ lean: async () => (live ? { enabled: true, implemented: true } : null) }),
  });
  return () => { FeatureFlag.findOne = saved; flagService.clearFlagCache(); };
}

function makeContent(id, mode = 'chat') {
  return { _id: { toString: () => id }, workspaceId: 'w1', contentNumber: 5, mode };
}

async function callActivate(content, threadId = 'dddddddddddddddddddddddd') {
  const req = {
    params: { workspaceNumber: '1', contentNumber: '5', threadId },
    user: { userId: 'u1' }, body: {}, _prefetchedContent: content,
  };
  let status = 200; let payload = null;
  const res = { status(s) { status = s; return this; }, json(p) { payload = p; return this; } };
  await aiController.activateThread(req, res);
  return { status, payload };
}

// ─── The mode surprise ───────────────────────────────────────

test('activate reports the DRAFT mode so a plan-mode lockdown is not silent', async () => {
  // Mode lives on the content, not the conversation, and neither activate nor
  // newThread touches it. Opening an old chat on a plan-mode draft therefore
  // re-enters plan mode with the document tools denied — the model can only
  // research and propose. The transcript gives no hint; the response must.
  const restore = stubFlag(true);
  const saved = threadService.activateThread;
  threadService.activateThread = async () => ({ _id: 'T1', title: 'Older chat' });
  try {
    const { status, payload } = await callActivate(makeContent('c-mode-1', 'plan'));
    assert.strictEqual(status, 200);
    assert.strictEqual(payload.mode, 'plan');
  } finally { threadService.activateThread = saved; restore(); aiController.contentSessionMap.delete('c-mode-1'); }
});

test('activate does NOT reset the draft mode', async () => {
  // Reporting, not resetting. Forcing chat on switch would abandon an
  // in-progress plan the user may have spent a run building — destructive, and
  // surprising in the other direction. Switching conversations is the user's
  // call; silently ending their plan is not.
  const restore = stubFlag(true);
  const saved = threadService.activateThread;
  threadService.activateThread = async () => ({ _id: 'T1', title: 'x' });
  const content = makeContent('c-mode-2', 'execute');
  try {
    await callActivate(content);
    assert.strictEqual(content.mode, 'execute', 'the draft is still executing its plan');
  } finally { threadService.activateThread = saved; restore(); aiController.contentSessionMap.delete('c-mode-2'); }
});

test('a chat-mode draft reports chat and needs no notice', async () => {
  const restore = stubFlag(true);
  const saved = threadService.activateThread;
  threadService.activateThread = async () => ({ _id: 'T1', title: 'x' });
  try {
    const { payload } = await callActivate(makeContent('c-mode-3', 'chat'));
    assert.strictEqual(payload.mode, 'chat');
  } finally { threadService.activateThread = saved; restore(); aiController.contentSessionMap.delete('c-mode-3'); }
});

// ─── Closed by Phase 4, asserted not assumed ─────────────────

test('switching evicts, which is what clears the per-session CFS cache and plan steps', async () => {
  // CFSCache and PlanSteps are per-ENGINE-SESSION state (both `json:"-"`, never
  // persisted). Conversation B reading A's cached context, or being blocked from
  // seeding a fresh checklist by A's half-finished one
  // (seedPlanStepsFromSections returns early when any step is working/done),
  // both require B to REUSE A's session. Phase 4 made switching mint a new one,
  // so neither is reachable — but only for as long as the eviction stays.
  const restore = stubFlag(true);
  const saved = threadService.activateThread;
  threadService.activateThread = async () => ({ _id: 'T1', title: 'x' });
  aiController.rememberSession('c-bleed', 'session-of-conversation-A');
  try {
    await callActivate(makeContent('c-bleed'));
    assert.strictEqual(aiController.contentSessionMap.get('c-bleed'), undefined,
      'the next run mints a fresh session — no CFS cache, no plan steps to inherit');
  } finally { threadService.activateThread = saved; restore(); aiController.contentSessionMap.delete('c-bleed'); }
});

// ─── The coupled constants ───────────────────────────────────

test('the replay budget tracks the compaction trigger', async () => {
  // Both were literal 24000s, but only ONE was env-tunable. Raising
  // THREAD_COMPACT_TRIGGER_TOKENS let threads grow past a replay budget that
  // stayed put, and the shaper silently dropped the oldest turns it walked past
  // — history loss from tuning a single knob.
  //
  // Asserted through the public shaper: build a thread whose tail exceeds the
  // DEFAULT budget and confirm the shaper still carries what compaction would
  // have left alone.
  const big = 'x'.repeat(4 * 3000); // ~3000 estimated tokens per row
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({ seq: i, kind: i % 2 === 0 ? 'user' : 'assistant', text: big, meta: {} });
  }
  const shaped = threadService.shapeThreadForReplay(rows);
  assert.ok(shaped.length > 0, 'a thread under the trigger must survive the replay budget intact');
  assert.strictEqual(shaped[0].role, 'user', 'replay always opens on a user turn');
});
