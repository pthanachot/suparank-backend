/**
 * Render every triggerable email template to one reviewable HTML page.
 *
 *   node scripts/previewEmails.js              # platform brand
 *   node scripts/previewEmails.js --tenant     # a white-label agency's brand
 *   node scripts/previewEmails.js --open       # …and open it
 *
 * Output: backend/.preview/emails.html (gitignored).
 *
 * WHY THIS EXISTS. The email templates are 14 hardcoded HTML strings that no
 * test renders and no page displays. Every design change to them — the token
 * sweep, the Outlook table shell, the type stack — is otherwise reviewed by
 * reading raw markup in a controller file. This is the review mechanism.
 *
 * No SMTP and no database: emailService, the TriggerableEmailTemplate model,
 * flagService and brandService are all stubbed the same way
 * tests/emailTriggerTemplates.test.js stubs them, so template resolution falls
 * through to ORIGINAL_DEFAULT_TEMPLATES. That means this previews the DEFAULTS
 * — it deliberately does not show admin or tenant overrides, which are
 * customer content and live only in the database.
 */

const fs = require('node:fs');
const path = require('node:path');

const TENANT = process.argv.includes('--tenant');
const OPEN = process.argv.includes('--open');

// The logo lives in the frontend's public dir, which isn't served here. Point
// FRONTEND_URL at the folder on disk so the mark renders in the preview.
process.env.FRONTEND_URL =
  process.env.PREVIEW_ASSET_BASE ||
  `file://${path.join(__dirname, '..', '..', 'suparank', 'public')}`;

// Stub emailService BEFORE requiring the controller — the real module builds
// SMTP transports and fires a verify() at load.
require.cache[require.resolve('../src/utils/emailService')] = {
  exports: {
    sendEmail: async () => ({}),
    sendVerificationCodeEmail: async () => ({}),
    sendPasswordResetCodeEmail: async () => ({}),
  },
};

const {
  SYSTEM_TRIGGERS,
  applyCustomTemplate,
} = require('../src/controllers/emailPortalController');
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
const brandService = require('../src/services/brandService');
const flagService = require('../src/services/flagService');

TriggerableEmailTemplate.findOne = () => ({ lean: async () => null });
TriggerableEmailTemplate.findOneAndUpdate = async () => null;
flagService.isFlagLive = async () => false;

const PLATFORM_BRAND = {
  productName: 'SupaRank',
  supportEmail: 'support@suparank.ai',
  primaryColor: '#2B5BE8',
};

// A plausible agency: their own name, their own colour, no custom logo (the
// commonest white-label shape — colour is a one-field change, hosting a logo
// is not).
const TENANT_BRAND = {
  productName: 'Northwind Studio',
  supportEmail: 'hello@northwindstudio.test',
  primaryColor: '#0F766E',
};

const BRAND = TENANT ? TENANT_BRAND : PLATFORM_BRAND;
brandService.getPlatformBrand = async () => ({ ...BRAND });
brandService.getBrandForOrg = async () => ({ brand: { ...BRAND } });

// ─── Sample data ────────────────────────────────────────────
// One bag keyed by variable name; each trigger takes the subset it declares.
// Values are realistic on purpose — "VAL_userName" hides layout problems that
// a real 20-character name exposes.

const SAMPLE = {
  userName: 'Alex Rivera',
  loginUrl: 'https://app.suparank.ai/login',
  code: '482913',
  expiresIn: '15 minutes',
  verifyUrl: 'https://app.suparank.ai/verify-email?token=sample',
  inviterName: 'Jordan Lee',
  orgName: 'Northwind Media',
  role: 'editor',
  acceptUrl: 'https://app.suparank.ai/accept-invite?token=sample',
  planName: 'Agency Monthly',
  amount: '$249.00',
  nextBillingDate: 'September 1, 2026',
  endDate: 'August 31, 2026',
  retryDate: 'August 12, 2026',
  updatePaymentUrl: 'https://app.suparank.ai/settings/billing',
  remainingCredits: '340',
  requesterName: 'Sam Ortiz',
  requesterEmail: 'sam@northwind.test',
  note: 'Running low before the Q3 content push.',
  billingUrl: 'https://app.suparank.ai/settings/billing',
  feature: 'AI Tracker',
  rating: '5',
  stars: '★★★★★',
  comment: "Genuinely useful — the competitor breakdown is the bit we open first.",
  userEmail: 'alex@northwind.test',
  submittedAt: '2026-08-08T10:00:00.000Z',
  subject: 'Cannot export a report',
  category: 'Bug',
  message: 'The export button returns a 404 on workspaces with an apostrophe in the name.',
  workspaceName: 'Northwind Media',
  period: 'July 2026',
  reportUrl: 'https://app.suparank.ai/r/sample',
  trackerName: 'northwind.com',
  domain: 'northwind.com',
  scanDate: 'August 8, 2026',
  promptsScanned: '24 scanned, 6 from history',
  visibility: '61',
  mentionRate: '48',
  shareOfVoice: '22',
  citationRate: '31',
  avgSentiment: 'Positive (72)',
  dashboardUrl: 'https://app.suparank.ai/workspace/1/ai-tracker',
  contentTitle: 'How to rank in AI answers in 2026',
  editorUrl: 'https://app.suparank.ai/workspace/12/drafts/34',
};

// The scan email's four row variables are <tr> fragments. These come from the
// REAL builders in utils/scanEmailRows — the harness used to hand-copy that
// markup, and the copy silently drifted out of the Phase 1 token sweep, so
// every screenshot taken from it was wrong about the email it was previewing.
const scanRows = require('../src/utils/scanEmailRows');

const ROWS = {
  platformRows: scanRows.buildPlatformRows(
    [
      { name: 'ChatGPT', visibility: 64, mentionCount: 12, citationCount: 7, errorCount: 0 },
      { name: 'Perplexity', visibility: 58, mentionCount: 11, citationCount: 9, errorCount: 0 },
      { name: 'Gemini', visibility: 41, mentionCount: 8, citationCount: 3, errorCount: 2 },
    ],
    24
  ),
  promptRows: scanRows.buildPromptRows([
    {
      prompt: 'best ai seo tools for agencies',
      platforms: [{ mentioned: true, cited: true }, { mentioned: true, cited: false }, { mentioned: true, cited: false }, { mentioned: false, cited: false }],
    },
    {
      prompt: 'how to track brand mentions in chatgpt',
      platforms: [{ mentioned: true, cited: true }, { mentioned: true, cited: false }, { mentioned: false, cited: false }, { mentioned: false, cited: false }],
    },
    {
      // Deliberately long + punctuated: exercises the 70-char truncation and
      // the escaping on a user-authored value.
      prompt: "content optimization software comparison — which one actually wins in 2026?",
      platforms: [{ mentioned: true, cited: false }, { mentioned: false, cited: false }, { mentioned: false, cited: false }, { mentioned: false, cited: false }],
      _isCarryForward: true,
      _carryDate: '2026-08-01T00:00:00.000Z',
    },
  ]),
  competitorRows: scanRows.buildCompetitorRows([
    { name: 'Surfer SEO', mentions: 18, citations: 9, visibility: 71 },
    { name: 'Clearscope', mentions: 12, citations: 6, visibility: 54 },
    { name: 'Frase', mentions: 7, citations: 2, visibility: 31 },
  ]),
  actionRows: scanRows.buildActionRows(
    [
      { priority: 'high', title: 'Publish a head-to-head comparison page', description: 'Surfer is cited in 3 prompts where you are absent', impact: '+12% visibility' },
      { priority: 'medium', title: 'Add FAQ schema to the pricing page', description: 'Perplexity favours structured answers', impact: '+6% citations' },
      { priority: 'low', title: 'Refresh the 2025 benchmark post', description: 'Stale dates suppress recency ranking', impact: '+3% mentions' },
    ],
    BRAND.primaryColor
  ),
};

// ─── Render ─────────────────────────────────────────────────

function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

async function main() {
  const sections = [];
  const missing = [];

  for (const trigger of SYSTEM_TRIGGERS) {
    const data = {};
    for (const name of trigger.variables) {
      if (name in ROWS) data[name] = ROWS[name];
      else if (name in SAMPLE) data[name] = SAMPLE[name];
      // brandName / supportEmail / logoUrl / primaryColor are auto-injected —
      // leaving them out is what exercises that path. Anything else absent is
      // a genuine gap in this fixture, so report it rather than hide it.
      else if (!['brandName', 'supportEmail', 'logoUrl', 'primaryColor', 'preheader'].includes(name)) {
        missing.push(`${trigger.id}.${name}`);
      }
    }

    const opts = { to: 'preview@example.com', data };
    await applyCustomTemplate(trigger.id, opts);

    // The preheader is display:none in the email, so the only way to review it
    // is to lift it out here. It is what the inbox actually shows before the
    // mail is opened, which makes it as reviewable as the subject.
    const snippet = (opts.html || '').match(/<div class="sr-preheader"[^>]*>([\s\S]*?)<\/div>/);
    const preheader = snippet ? snippet[1].replace(/&#847;|&zwnj;|&nbsp;/g, '').trim() : '';

    sections.push(`<section class="card">
  <header class="hd">
    <span class="id">${trigger.id}</span>
    <span class="cat">${trigger.category}</span>
    <span class="subj">${escapeAttr(opts.subject || '(no subject resolved)')}</span>
  </header>
  <div class="inbox">
    <span class="inbox-label">inbox snippet</span>${escapeAttr(preheader) || '<em>none</em>'}
  </div>
  <div class="body">${opts.html || '<p style="padding:20px;color:#B91C1C;">Template failed to resolve.</p>'}</div>
</section>`);
  }

  const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Email templates — ${BRAND.productName}</title>
<style>
  body { background:#F7F8FA; margin:0; padding:28px; font-family:'Inter',-apple-system,system-ui,sans-serif; color:#111827; }
  h1 { font-size:17px; margin:0 0 4px; letter-spacing:-0.02em; }
  .meta { font-size:12px; color:#6B7280; margin:0 0 24px; }
  .card { margin:0 0 32px; border:1px solid #E5E7EB; border-radius:10px; overflow:hidden; background:#FFFFFF; }
  .hd { background:#111827; color:#FFFFFF; padding:9px 14px; font-size:12px; display:flex; gap:10px; align-items:baseline; }
  .id { font-weight:700; }
  .cat { font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:rgba(255,255,255,.14); padding:2px 6px; border-radius:4px; }
  .subj { color:rgba(255,255,255,.65); font-weight:400; }
  .warn { background:#FFFBEB; border:1px solid #D97706; color:#B45309; padding:10px 14px; border-radius:8px; font-size:12px; margin:0 0 24px; }
  .inbox { background:#F9FAFB; border-bottom:1px solid #E5E7EB; padding:7px 14px; font-size:12px; color:#4B5563; }
  .inbox-label { display:inline-block; font-size:9px; text-transform:uppercase; letter-spacing:.07em; color:#9CA3AF; margin-right:8px; }
</style></head>
<body>
  <h1>Transactional email — default templates</h1>
  <p class="meta">${SYSTEM_TRIGGERS.length} triggers · brand: <strong>${BRAND.productName}</strong> (${BRAND.primaryColor})${TENANT ? ' · <strong>--tenant</strong>' : ''}</p>
  ${missing.length ? `<p class="warn"><strong>${missing.length} declared variable(s) have no sample data:</strong> ${missing.join(', ')}</p>` : ''}
  ${sections.join('\n')}
</body></html>`;

  const outDir = path.join(__dirname, '..', '.preview');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, TENANT ? 'emails.tenant.html' : 'emails.html');
  fs.writeFileSync(outFile, page);

  console.log(`Rendered ${SYSTEM_TRIGGERS.length} templates → ${outFile}`);
  if (missing.length) console.warn(`WARNING: no sample data for ${missing.join(', ')}`);
  if (OPEN) require('node:child_process').spawn('open', [outFile], { detached: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
