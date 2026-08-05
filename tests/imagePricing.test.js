/**
 * Phase 3 — per-image pricing for /image.
 *
 * The economics changed from "a flat 10 per RUN however many images it made"
 * to "a small run base plus 10 per IMAGE, capped". A run that generates four
 * images used to cost the same as one, which priced the command below its own
 * provider COGS the moment it did what it was for.
 *
 * Two callers share the imageGenerate action and must NOT share a price shape:
 *   - POST …/ai/generate-image makes exactly one image per call and passes no
 *     count, so it keeps its flat per-image charge with no run base.
 *   - the /image agent run passes a count and is priced through
 *     agentRunCredits, which adds the base.
 *
 * The settle direction is the constraint behind most of these: settle() can
 * only refund (Math.min(actual, reserved)), never top up, so the reservation
 * must be the ceiling and every possible actual must sit at or below it.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { resolveCredits, agentRunCredits, agentRunCostShape } = require('../src/config/creditRules');
const { CREDIT_COSTS, IMAGE_MAX_BILLED_IMAGES } = require('../src/config/creditCosts');
const { IMAGE_BUDGET_PER_RUN } = require('../src/config/agentBilling');

const BASE = resolveCredits('inlineAction', {});
const PER = CREDIT_COSTS.imageGenerate.credits;
const CAP = IMAGE_MAX_BILLED_IMAGES;

// ─── The per-image action itself ─────────────────────────────────

test('the one-shot generate-image endpoint still pays the flat per-image price', () => {
  // It passes no count. If units ever stopped defaulting to 1 this endpoint
  // would silently bill 0 — the whole à-la-carte image path, free.
  assert.equal(resolveCredits('imageGenerate', {}), PER);
  assert.equal(resolveCredits('imageGenerate', { tier: 'professional' }), PER);
});

test('images are priced per image, not per call', () => {
  assert.equal(resolveCredits('imageGenerate', { images: 1 }), PER);
  assert.equal(resolveCredits('imageGenerate', { images: 2 }), PER * 2);
  assert.equal(resolveCredits('imageGenerate', { images: 3 }), PER * 3);
});

test('zero images costs zero — not one image', () => {
  // The regression this pins is `||` in place of `??` for the unit default:
  // `0 || 1` is 1, which would bill an image to every run that made none.
  assert.equal(resolveCredits('imageGenerate', { images: 0 }), 0);
  assert.equal(agentRunCredits('imageGenerate', { images: 0 }), BASE,
    'a run that generated nothing owes the run base and nothing more');
});

test('the billable count is capped', () => {
  assert.equal(resolveCredits('imageGenerate', { images: CAP + 1 }), PER * CAP);
  assert.equal(resolveCredits('imageGenerate', { images: 1e9 }), PER * CAP);
});

test('a hostile or broken count can never inflate the charge', () => {
  // The count originates in an SSE payload. The controller clamps it, but this
  // is the layer that turns it into money, so it must be safe on its own.
  for (const bad of [-5, NaN, Infinity, -Infinity, 'many', null, undefined, {}, []]) {
    const got = resolveCredits('imageGenerate', { images: bad });
    assert.ok(Number.isFinite(got) && got >= 0 && got <= PER * CAP,
      `images=${JSON.stringify(bad)} produced ${got}`);
  }
  // undefined/null fall through to the default of 1 (the one-shot endpoint's
  // shape); everything non-numeric floors at 0. Neither can exceed the cap.
  assert.equal(resolveCredits('imageGenerate', { images: NaN }), 0);
  assert.equal(resolveCredits('imageGenerate', { images: -5 }), 0);
});

// ─── Run pricing ─────────────────────────────────────────────────

test('an agent run adds the run base on top of the images', () => {
  assert.equal(agentRunCredits('imageGenerate', { images: 1 }), BASE + PER);
  assert.equal(agentRunCredits('imageGenerate', { images: CAP }), BASE + PER * CAP);
});

test('agentRunCredits changes nothing for any other action', () => {
  for (const action of ['articleGenerate', 'fullDocPass', 'inlineAction', 'reScore']) {
    for (const tier of ['free', 'professional']) {
      assert.equal(
        agentRunCredits(action, { tier, images: 3 }),
        resolveCredits(action, { tier, images: 3 }),
        `${action}/${tier}: only imageGenerate may price differently as a run`,
      );
    }
  }
});

// ─── The invariants that keep the money right ────────────────────

test('the image allowance never exceeds what can be billed', () => {
  // If the engine were allowed more images than the price table can charge
  // for, every image past the cap would be free. They are one number for this
  // reason; this test fails if someone reintroduces a second literal.
  //
  // Read off the SPEC, not off IMAGE_MAX_BILLED_IMAGES: the spec's cap is what
  // resolveCredits actually clamps to, and hardcoding a smaller literal there
  // is exactly the drift worth catching — comparing the constant to itself
  // would not notice.
  const specCap = CREDIT_COSTS.imageGenerate.cap;
  assert.equal(specCap, CAP, 'the priced cap must be the shared constant');
  assert.ok(IMAGE_BUDGET_PER_RUN <= specCap,
    `allowance ${IMAGE_BUDGET_PER_RUN} exceeds billable cap ${specCap} — images past the cap would be free`);
});

test('no reachable outcome costs more than the reservation', () => {
  // THE settle invariant. The route reserves the worst case; the controller
  // settles to the images actually made. settle() clamps to the reservation,
  // so an actual above it would be silently absorbed — revenue lost with no
  // error anywhere.
  const reserved = agentRunCredits('imageGenerate', { images: IMAGE_BUDGET_PER_RUN });
  for (let n = 0; n <= IMAGE_BUDGET_PER_RUN + 5; n++) {
    assert.ok(agentRunCredits('imageGenerate', { images: n }) <= reserved,
      `${n} images settles above the ${reserved}-credit reservation`);
  }
});

test('every extra image costs more, up to the cap', () => {
  // Guards against a cap or floor that quietly makes some images free.
  for (let n = 1; n <= CAP; n++) {
    const prev = agentRunCredits('imageGenerate', { images: n - 1 });
    const cur = agentRunCredits('imageGenerate', { images: n });
    assert.ok(cur > prev, `image ${n} was free (${prev} → ${cur})`);
  }
});

// ─── The published shape ─────────────────────────────────────────

test('the published shape matches what the server actually reserves', () => {
  // The UI gates on shape.worstCase. If it drifted below the reservation the
  // editor would wave through runs the deduction then refuses with a 402.
  const shape = agentRunCostShape('imageGenerate', {});
  assert.deepEqual(shape, {
    base: BASE, perUnit: PER, unit: 'image', max: CAP, worstCase: BASE + PER * CAP,
  });
  assert.equal(shape.worstCase, agentRunCredits('imageGenerate', { images: IMAGE_BUDGET_PER_RUN }),
    'the quoted ceiling and the reservation must be the same number');
});

// ─── The reservation the route actually makes ────────────────────

/**
 * Drive the REAL credit gate off the REAL agent route. The formula above is
 * only correct if the route applies it: an estimator that resolved the flat
 * per-image price would reserve 10, settle() would then clamp a 12-credit
 * actual down to 10, and the run would be underbilled with nothing raised
 * anywhere. Asserting the arithmetic in isolation cannot catch that — this
 * pins the wired number.
 */
async function reserveFor(body) {
  const router = require('../src/routes/workspaceRoutes');
  const creditService = require('../src/services/creditService');
  const tierService = require('../src/services/tierService');
  const workspaceQuotaService = require('../src/services/workspaceQuotaService');
  const Content = require('../src/models/Content');

  const layer = router.stack.find((l) => l.route?.path?.endsWith('/ai/agent') && l.route.methods.post);
  assert.ok(layer, 'the agent route is not registered');
  // rwr, rf, requirePermission, rc(...), handler — the credit gate is the one
  // before the controller. Found by position from the END so inserting an
  // earlier guard does not silently shift this onto the wrong middleware.
  const gate = layer.route.stack[layer.route.stack.length - 2].handle;

  const saved = [];
  const stub = (obj, key, fn) => { saved.push([obj, key, obj[key]]); obj[key] = fn; };
  stub(tierService, 'getOrgTierConfig', async () => ({ tier: 'professional', config: { aiChat: true } }));
  stub(creditService, 'isFeatureEnabled', () => true);
  stub(creditService, 'getBalance', async () => ({ subscription: 10000, general: 0, userFree: 0, total: 10000 }));
  stub(workspaceQuotaService, 'resolveWorkspacePlanLimits', async () => null);
  stub(Content, 'findByNumber', async () => null);

  const req = {
    workspace: { _id: 'w1', organizationId: 'org1' },
    user: { userId: 'u1' },
    params: { workspaceNumber: '1', contentNumber: '1' },
    body,
  };
  try {
    await new Promise((resolve, reject) => {
      gate(req, { status: () => ({ json: reject }) }, resolve);
    });
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) saved[i][0][saved[i][1]] = saved[i][2];
  }
  return req.creditContext?.estimatedCredits;
}

test('the agent route reserves the full worst case for an /image run', async () => {
  const reserved = await reserveFor({ mode: 'sequential', commandName: 'image' });
  assert.equal(reserved, BASE + PER * IMAGE_BUDGET_PER_RUN);
  assert.ok(reserved >= agentRunCredits('imageGenerate', { images: IMAGE_BUDGET_PER_RUN }),
    'the reservation must cover the most the run can settle to');
});

test('the image reservation does not leak into other commands', async () => {
  // agentRunCredits is called with an images count for EVERY run; only the
  // image action may let it change the price.
  const grammar = await reserveFor({ mode: 'sequential', commandName: 'grammar' });
  assert.equal(grammar, resolveCredits('inlineAction', { tier: 'professional' }));
  const autoWrite = await reserveFor({ mode: 'freeform', intent: 'auto-write' });
  assert.equal(autoWrite, resolveCredits('articleGenerate', { tier: 'professional' }));
});

test('flat actions publish no shape', () => {
  for (const action of ['articleGenerate', 'fullDocPass', 'inlineAction']) {
    assert.equal(agentRunCostShape(action, {}), null);
  }
});

test('the shape is built through the resolver, not from the raw spec numbers', () => {
  // Neither component of this price varies by tier today, so comparing tiers
  // would pass against a hardcoded shape and prove nothing. zeroCredit is a
  // resolver rule that DOES change the answer, so it shows the caller's
  // context actually reaches the resolver — which is what makes the published
  // shape follow Option B, the zero-credit list and any future tier rule
  // instead of quietly diverging from what gets charged.
  const waived = agentRunCostShape('imageGenerate', { zeroCredit: true });
  assert.deepEqual(waived, { base: 0, perUnit: 0, unit: 'image', max: CAP, worstCase: 0 });

  const paid = agentRunCostShape('imageGenerate', { tier: 'professional' });
  assert.equal(paid.base, resolveCredits('inlineAction', { tier: 'professional' }));
  assert.equal(paid.worstCase, agentRunCredits('imageGenerate', { tier: 'professional', images: CAP }));
});
