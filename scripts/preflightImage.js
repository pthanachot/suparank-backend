/**
 * PRE-FLIGHT for switching /image on (remediation Phase 7).
 *
 * Makes NO model calls, so it spends nothing, and NO writes — it answers "is
 * this deployment configured such that enabling /image will work and be billed
 * correctly", which is the question you want answered BEFORE the toggle, not
 * after a user's document fills with images that 404 in an hour.
 *
 * Its only outbound calls are a GET /health on the engine and a findOne on the
 * settings singleton. Note it reads that singleton DIRECTLY rather than through
 * systemSettingsService.loadSettings(), which upserts — a script that says it
 * only looks must only look.
 *
 * Usage:
 *   node scripts/preflightImage.js
 *   node scripts/preflightImage.js --json     (machine-readable)
 *
 * Exit codes: 0 ready to enable · 1 at least one BLOCKER · 2 misuse.
 *
 * This script does NOT enable anything. Enabling is a runtime admin action
 * (Admin → Settings → Slash Commands), deliberately: it is reversible without
 * a deploy and it is audited against the admin who did it.
 */

const path = require('path');
const dotenv = require(path.join(__dirname, '../node_modules/dotenv'));

dotenv.config({ path: path.join(__dirname, '../.env.local') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const JSON_OUT = process.argv.includes('--json');

// In --json mode stdout must carry ONLY the document. Requiring the app's
// services prints incidental lines ("[B2] connection warmed up"), and the B2
// keep-warm one is ASYNC — it can land after the JSON, so suppressing during
// require is not enough. Route every incidental log to stderr for the whole
// process and write the document with process.stdout.write.
if (JSON_OUT) {
  console.log = (...a) => console.error(...a);
}

const safeOrigin = (u) => { try { return new URL(u).origin; } catch { return null; } };

const checks = [];
const add = (level, name, ok, detail, fix) => checks.push({ level, name, ok, detail, fix });
const BLOCKER = 'blocker';
const WARN = 'warn';
const INFO = 'info';

async function main() {
  const imageStorage = require(path.join(__dirname, '../src/services/imageStorage'));
  const { costFor } = require(path.join(__dirname, '../src/config/modelRegistry'));
  const {
    IMAGE_BUDGET_PER_RUN, DEFAULT_DISABLED_AGENT_COMMANDS, COMMAND_TOOLS,
  } = require(path.join(__dirname, '../src/config/agentBilling'));
  const { agentRunCredits, agentRunCostShape } = require(path.join(__dirname, '../src/config/creditRules'));
  const { CREDIT_COSTS, IMAGE_MAX_BILLED_IMAGES } = require(path.join(__dirname, '../src/config/creditCosts'));

  // ── 1. Durable storage ────────────────────────────────────
  // Mirrors the runtime guard in aiController: refuse only when NEITHER side is
  // durable, because contentController re-hosts engine URLs to the backend's
  // bucket on save. Either one alone is enough.
  const backendB2 = imageStorage.isEnabled();
  const engineUrlEarly = process.env.WRITING_ENGINE_URL || 'http://localhost:8090';

  // One /health call, read directly rather than through getEngineCapabilities:
  // that helper deliberately reports only `imageStorage` and collapses "engine
  // answered but the field is missing" into the same null as "engine is down".
  // Those need different advice, and this script also wants image_base_url from
  // the same response.
  let health = null;
  let healthError = null;
  try {
    const res = await fetch(`${engineUrlEarly}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) healthError = `HTTP ${res.status}`;
    else health = await res.json();
  } catch (e) {
    healthError = e.name === 'TimeoutError' ? 'timed out' : e.message;
  }

  const engineStorage = typeof health?.image_storage === 'string' ? health.image_storage : null;
  const engineReachable = health !== null;

  add(
    engineReachable ? INFO : BLOCKER,
    'writing engine reachable',
    engineReachable,
    engineReachable
      ? `image_storage=${engineStorage ?? 'ABSENT from /health'}`
      : `GET ${engineUrlEarly}/health — ${healthError}`,
    'Start the engine and set WRITING_ENGINE_URL, then re-run.',
  );

  // Answered, but not in the shape the backend parses — the capability probe
  // would read this as "unknown" and quietly stop refusing ephemeral runs.
  if (engineReachable && engineStorage === null) {
    add(BLOCKER, '/health reports image_storage', false,
      `keys present: ${Object.keys(health).join(', ') || 'none'}`,
      'The backend\'s capability probe reads this field; without it the durable-storage '
        + 'refusal cannot fire. Check the engine build.');
  }

  const durable = engineStorage === 'b2' || backendB2;
  add(
    durable ? INFO : BLOCKER,
    'images will survive the hour',
    durable,
    `engine=${engineStorage ?? 'unknown'} backend_b2=${backendB2}`,
    'Configure B2 on the engine (B2_KEY_ID/B2_APP_KEY/B2_BUCKET_NAME) or on the '
      + 'backend (B2_ENDPOINT/B2_BUCKET/B2_KEY_ID/B2_APP_KEY). Without either, every '
      + 'generated image 404s within the hour and the run is still billed.',
  );

  // Engine-served images are re-hosted only from an allowlisted origin. In a
  // split deploy the engine's public IMAGE_BASE_URL is a different origin from
  // WRITING_ENGINE_URL, and the symptom is silent: images simply stay on the
  // engine and expire.
  // Asked of the ENGINE rather than inferred: it is the only party that knows
  // which base URL it bakes into the markdown it emits.
  const engineUrl = engineUrlEarly;
  const extraOrigin = process.env.ENGINE_IMAGE_BASE_URL || '';
  const allowed = new Set();
  for (const u of [engineUrl, extraOrigin]) {
    if (!u) continue;
    try { allowed.add(new URL(u).origin); } catch { /* reported below */ }
  }
  if (extraOrigin && !allowed.has(safeOrigin(extraOrigin))) {
    add(BLOCKER, 'ENGINE_IMAGE_BASE_URL is a valid URL', false, extraOrigin,
      'Must be an absolute URL (e.g. https://engine.example.com).');
  }

  // Reuses the single /health response above rather than asking twice.
  const engineImageBase = typeof health?.image_base_url === 'string' ? health.image_base_url : null;

  if (engineImageBase === null) {
    add(WARN, 'engine image origin matches the allowlist', true,
      `engine did not report image_base_url; allowlisted: ${[...allowed].join(', ')}`,
      'An older engine build does not report this. Confirm by hand that the engine\'s '
        + 'IMAGE_BASE_URL origin is one of the allowlisted origins, or generated images '
        + 'are never copied to B2 and expire silently.');
  } else {
    const engineOrigin = safeOrigin(engineImageBase);
    const matches = engineOrigin !== null && allowed.has(engineOrigin);
    add(
      matches ? INFO : BLOCKER,
      'engine image origin matches the allowlist',
      matches,
      `engine serves ${engineImageBase} · allowlisted: ${[...allowed].join(', ')}`,
      `Set ENGINE_IMAGE_BASE_URL=${engineOrigin ?? engineImageBase} on the BACKEND. `
        + 'Until then the backend refuses to re-host these images, so every generated '
        + 'image stays on the engine and expires — billed, then gone.',
    );
  }

  // ── 2. Billing ────────────────────────────────────────────
  const priced = costFor('google/gemini-2.5-flash-image', 0, 0, { images: 1 });
  add(
    priced.known && priced.costUsd > 0 ? INFO : BLOCKER,
    'image model is priced',
    priced.known && priced.costUsd > 0,
    `${priced.resolved || 'google/gemini-2.5-flash-image'} → $${priced.costUsd}/image`,
    'An unpriced model records costUsd=0, so every image looks free on the COGS '
      + 'dashboard and the margin report is wrong. Add it to modelRegistry.',
  );

  const cap = CREDIT_COSTS.imageGenerate.cap;
  const budgetSafe = IMAGE_BUDGET_PER_RUN <= cap;
  add(
    budgetSafe ? INFO : BLOCKER,
    'allowance never exceeds what can be billed',
    budgetSafe,
    `allowance=${IMAGE_BUDGET_PER_RUN} billable cap=${cap}`,
    'Images past the billable cap are free. Keep IMAGE_BUDGET_PER_RUN derived '
      + 'from creditCosts.IMAGE_MAX_BILLED_IMAGES.',
  );

  const shape = agentRunCostShape('imageGenerate', {});
  const worst = agentRunCredits('imageGenerate', { images: IMAGE_BUDGET_PER_RUN });
  const cogsWorst = priced.costUsd * IMAGE_BUDGET_PER_RUN;
  add(
    INFO, 'price per run', true,
    `${shape.base} + ${shape.perUnit}/image, max ${shape.max} → reserves ${worst} credits `
      + `(worst-case COGS $${cogsWorst.toFixed(3)})`,
    null,
  );
  add(
    worst >= 1 ? INFO : BLOCKER,
    'a run reserves a non-zero amount',
    worst >= 1,
    `${worst} credits`,
    'A zero reservation means the run is free.',
  );

  // ── 3. Current state ──────────────────────────────────────
  let disabled = null;
  let settingsSource = 'built-in default (DB not consulted)';
  try {
    const mongoose = require('mongoose');
    if (process.env.MONGODB_URI) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
      // findOne, NOT systemSettingsService.loadSettings(): that helper upserts
      // the singleton, so calling it here would make this pre-flight WRITE to
      // the production settings collection. Harmless in effect, but a script
      // that says it only looks must only look.
      const SystemSettings = require(path.join(__dirname, '../src/models/SystemSettings'));
      const doc = await SystemSettings.findOne({ key: 'global' }).lean();
      // Same resolution the service applies: an absent field means "use the
      // built-in default", and only an explicit array (even []) overrides it.
      disabled = Array.isArray(doc?.disabledAgentCommands)
        ? doc.disabledAgentCommands
        : null;
      settingsSource = doc
        ? (disabled === null ? 'live SystemSettings (no override → default)' : 'live SystemSettings')
        : 'no SystemSettings document yet → default';
      await mongoose.disconnect();
    }
  } catch (e) {
    settingsSource = `DB unavailable (${e.message})`;
  }
  if (disabled === null) disabled = [...DEFAULT_DISABLED_AGENT_COMMANDS];

  const imageOff = disabled.includes('image');
  add(
    INFO, '/image current state', true,
    `${imageOff ? 'OFF' : 'ON'} — from ${settingsSource}. disabled=[${disabled.join(', ')}]`,
    null,
  );
  add(
    COMMAND_TOOLS.image ? INFO : BLOCKER,
    '/image is a known server command',
    !!COMMAND_TOOLS.image,
    COMMAND_TOOLS.image ? COMMAND_TOOLS.image.join(', ') : 'missing from COMMAND_TOOLS',
    'The admin console can only toggle commands the server registry knows.',
  );

  // ── Report ────────────────────────────────────────────────
  const blockers = checks.filter((c) => c.level === BLOCKER && !c.ok);
  const warns = checks.filter((c) => c.level === WARN);

  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ready: blockers.length === 0, checks }, null, 2)}\n`);
  } else {
    console.log('\n  PRE-FLIGHT — enabling /image\n');
    for (const c of checks) {
      const mark = c.level === BLOCKER && !c.ok ? '✗' : c.level === WARN ? '!' : '·';
      console.log(`  ${mark} ${c.name}`);
      if (c.detail) console.log(`      ${c.detail}`);
      if (!c.ok && c.fix) console.log(`      FIX: ${c.fix}`);
    }
    console.log('');
    if (blockers.length) {
      console.log(`  NOT READY — ${blockers.length} blocker(s) above.\n`);
    } else {
      console.log('  READY. Nothing here has been changed.\n');
      console.log('  To enable: Admin → Settings → Slash Commands → /image.');
      console.log('  The toggle is runtime, audited, and reversible without a deploy.');
      if (warns.length) console.log(`  ${warns.length} warning(s) above are worth reading first.`);
      console.log('');
    }
  }
  process.exit(blockers.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[preflight] failed:', e.message);
  process.exit(2);
});
