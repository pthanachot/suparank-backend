/**
 * The brand header (logo + wordmark) that opens every triggerable email.
 *
 * Emails carried no logo at all before this; the mark now comes from the same
 * vector the app header renders (components/BrandLogo.tsx), rasterized to PNG
 * because Gmail strips <svg> and Outlook has never supported it.
 *
 * What these tests pin:
 *   1. every default template actually renders the <img>,
 *   2. the platform fallback tracks FRONTEND_URL,
 *   3. the tenant ladder matches BrandLogo's: logoIconUrl → logoUrl → ours,
 *   4. a caller-supplied logoUrl is never overwritten,
 *   5. a brand-lookup failure still ships the platform logo (fail-open) —
 *      a broken lookup must never leave a raw {{logoUrl}} in someone's inbox.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Fake emailService BEFORE requiring the controller — the real module builds
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
  ORIGINAL_DEFAULT_TEMPLATES,
  applyCustomTemplate,
} = require('../src/controllers/emailPortalController');
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
const brandService = require('../src/services/brandService');
const flagService = require('../src/services/flagService');

// No DB: template lookups fall back to the hardcoded defaults
TriggerableEmailTemplate.findOne = () => ({ lean: async () => null });
TriggerableEmailTemplate.findOneAndUpdate = async () => null;
flagService.isFlagLive = async () => false;

const PLATFORM_BRAND = { productName: 'SupaRank', supportEmail: 'support@suparank.ai' };

beforeEach(() => {
  process.env.FRONTEND_URL = 'https://app.suparank.ai';
  brandService.getPlatformBrand = async () => ({ ...PLATFORM_BRAND });
  brandService.getBrandForOrg = async () => ({ brand: { ...PLATFORM_BRAND } });
});

/** Render a trigger with a full data bag and return the html. */
async function render(triggerId, data = {}, orgId = null) {
  const trigger = SYSTEM_TRIGGERS.find((t) => t.id === triggerId);
  const full = Object.fromEntries(
    trigger.variables.filter((v) => !(v in data)).map((v) => [v, `VAL_${v}`])
  );
  // The auto-injected keys must be absent so the controller resolves them.
  for (const k of ['brandName', 'supportEmail', 'logoUrl', 'primaryColor']) {
    if (!(k in data)) delete full[k];
  }
  const opts = { to: 'x@example.com', data: { ...full, ...data } };
  await applyCustomTemplate(triggerId, opts, orgId);
  return opts.html;
}

describe('brand header markup', () => {
  it('every default template renders the logo image', () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      const { html } = ORIGINAL_DEFAULT_TEMPLATES[trigger.id];
      assert.match(
        html,
        /<img src="\{\{logoUrl\}\}"/,
        `${trigger.id}: template has no brand logo <img>`
      );
    }
  });

  it('every default template declares logoUrl as a variable', () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      assert.ok(
        trigger.variables.includes('logoUrl'),
        `${trigger.id}: logoUrl is used but not declared`
      );
    }
  });

  it('the logo carries an Outlook-safe height attribute and no fixed width', () => {
    const { html } = ORIGINAL_DEFAULT_TEMPLATES.welcome;
    // Outlook ignores the style block, so the raw attribute has to be there.
    assert.match(html, /<img src="\{\{logoUrl\}\}"[^>]*\sheight="40"/);
    // A fixed width would squash a tenant's wide lockup into a square.
    assert.doesNotMatch(html, /<img src="\{\{logoUrl\}\}"[^>]*\swidth="/);
  });

  it('no template leaves a literal {{logoUrl}} after substitution', async () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      const html = await render(trigger.id);
      assert.doesNotMatch(html, /\{\{logoUrl\}\}/, `${trigger.id}: unresolved logoUrl`);
    }
  });
});

describe('logo resolution ladder', () => {
  it('falls back to the platform PNG on FRONTEND_URL', async () => {
    const html = await render('welcome');
    assert.match(html, /src="https:\/\/app\.suparank\.ai\/brand\/suparank-mark\.png"/);
  });

  it('tracks FRONTEND_URL rather than hardcoding the host', async () => {
    process.env.FRONTEND_URL = 'https://staging.suparank.ai';
    const html = await render('welcome');
    assert.match(html, /src="https:\/\/staging\.suparank\.ai\/brand\/suparank-mark\.png"/);
  });

  it('falls back to the canonical app origin when FRONTEND_URL is unset', async () => {
    // The production origin is suparank.ai. It was app.suparank.ai here, which
    // is a host the platform does not serve — an unset FRONTEND_URL would have
    // put a dead logo and dead links in every email.
    delete process.env.FRONTEND_URL;
    const html = await render('welcome');
    assert.match(html, /src="https:\/\/suparank\.ai\/brand\/suparank-mark\.png"/);
    assert.doesNotMatch(html, /app\.suparank\.ai/);
  });

  it("prefers the tenant's square mark over their wide lockup", async () => {
    brandService.getBrandForOrg = async () => ({
      brand: {
        ...PLATFORM_BRAND,
        productName: 'Acme',
        logoIconUrl: 'https://acme.test/mark.png',
        logoUrl: 'https://acme.test/wide.png',
      },
    });
    const html = await render('welcome', {}, 'org1');
    assert.match(html, /src="https:\/\/acme\.test\/mark\.png"/);
    assert.doesNotMatch(html, /wide\.png/);
  });

  it("uses the tenant's wide lockup when no square mark is set", async () => {
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, logoUrl: 'https://acme.test/wide.png' },
    });
    const html = await render('welcome', {}, 'org1');
    assert.match(html, /src="https:\/\/acme\.test\/wide\.png"/);
  });

  it('ignores empty-string brand logo fields', async () => {
    // BrandConfig defaults both to '' — empty must not win over the platform PNG.
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, logoIconUrl: '', logoUrl: '' },
    });
    const html = await render('welcome', {}, 'org1');
    assert.match(html, /src="https:\/\/app\.suparank\.ai\/brand\/suparank-mark\.png"/);
  });

  it('never overwrites a logoUrl the caller supplied', async () => {
    const html = await render('welcome', { logoUrl: 'https://caller.test/x.png' });
    assert.match(html, /src="https:\/\/caller\.test\/x\.png"/);
  });

  it('still ships the platform logo when the brand lookup throws', async () => {
    brandService.getBrandForOrg = async () => {
      throw new Error('mongo down');
    };
    const html = await render('welcome', {}, 'org1');
    assert.match(html, /src="https:\/\/app\.suparank\.ai\/brand\/suparank-mark\.png"/);
    assert.doesNotMatch(html, /\{\{logoUrl\}\}/);
  });
});

describe('call-to-action colour', () => {
  // The app's primary CTA is .sb-cta → --sr-grad-cta → brand-500..brand-700.
  // Email can't carry that gradient (Outlook drops background-image), so the
  // buttons take a solid brand-600 — the same value as primaryColor's default.
  const BRAND_600 = '#2B5BE8';

  // Every template that has a button, and the colour it should carry.
  // payment_failed is deliberately NOT brand: red is a status signal there,
  // matching the red heading and warning panel in the same email.
  const WITH_CTA = [
    'welcome',
    'verify_email_link',
    'member_invite',
    'topup_requested',
    'monthly_report',
    'scan_completed',
  ];

  it('every brand CTA is driven by primaryColor, not a hardcoded hex', () => {
    for (const id of WITH_CTA) {
      const { html } = ORIGINAL_DEFAULT_TEMPLATES[id];
      // Phase 3: the fill moved from an inline background-color on the <a> to
      // the bgcolor ATTRIBUTE on a wrapping <td>, because Outlook's Word
      // engine ignores background-color on an inline anchor.
      assert.match(
        html,
        /<td align="center" bgcolor="\{\{primaryColor\}\}"/,
        `${id}: CTA does not use {{primaryColor}}`
      );
    }
  });

  it('no template carries the old off-brand indigo or black button', () => {
    for (const trigger of SYSTEM_TRIGGERS) {
      const { html } = ORIGINAL_DEFAULT_TEMPLATES[trigger.id];
      assert.doesNotMatch(html, /4[fF]46[eE]5/, `${trigger.id}: leftover indigo #4F46E5`);
      assert.doesNotMatch(html, /background:#111/, `${trigger.id}: leftover black button`);
    }
  });

  it('renders the platform brand blue by default', async () => {
    for (const id of WITH_CTA) {
      const html = await render(id);
      assert.match(
        html,
        new RegExp(`bgcolor="${BRAND_600}"`),
        `${id}: CTA is not the platform brand colour`
      );
    }
  });

  it("uses the tenant's primaryColor when they set one", async () => {
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, primaryColor: '#0F9D58' },
    });
    const html = await render('welcome', {}, 'org1');
    assert.match(html, /bgcolor="#0F9D58"/);
    assert.doesNotMatch(html, new RegExp(BRAND_600));
  });

  it('keeps the payment-failure button red — status, not brand', () => {
    const { html } = ORIGINAL_DEFAULT_TEMPLATES.payment_failed;
    // --sr-error-600, passed through ctaButton's `bg` override.
    assert.match(html, /bgcolor="#DC2626"/);
    assert.doesNotMatch(html, /bgcolor="\{\{primaryColor\}\}"/);
  });

  it('falls back to brand blue when the lookup throws', async () => {
    brandService.getBrandForOrg = async () => {
      throw new Error('mongo down');
    };
    const html = await render('welcome', {}, 'org1');
    assert.match(html, new RegExp(`bgcolor="${BRAND_600}"`));
    assert.doesNotMatch(html, /\{\{primaryColor\}\}/);
  });

  it('the scan report accent heading tracks the brand too', async () => {
    const html = await render('scan_completed');
    assert.match(html, new RegExp(`color:${BRAND_600};margin:0 0 8px 0`));
    assert.match(html, new RegExp(`border-bottom:2px solid ${BRAND_600}`));
  });
});

describe('tenant brand values cannot inject markup', () => {
  // brandName (BrandConfig.productName) is validated for LENGTH ONLY, and
  // logoUrl's validator accepts `https://x/a"><img>` and stores it raw. Both
  // land in attribute contexts, so both are escaped in the HTML pass.
  // Mail clients don't run script — the risk is hidden content and forged
  // links in mail an agency sends to their clients over our SPF/DKIM.

  it('escapes a quote-breakout in productName', async () => {
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, productName: '" onmouseover="x' },
    });
    const html = await render('welcome', {}, 'org1');
    assert.doesNotMatch(html, /alt="" onmouseover="x"/, 'broke out of the alt attribute');
    assert.match(html, /&quot; onmouseover=&quot;x/, 'productName was not escaped');
  });

  it('escapes a tag-injection in productName', async () => {
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, productName: '</title><style>a{}' },
    });
    const html = await render('welcome', {}, 'org1');
    assert.doesNotMatch(html, /<\/title><style>/, 'closed <title> early');
    assert.match(html, /&lt;\/title&gt;&lt;style&gt;/);
  });

  it('escapes a quote-breakout in logoUrl', async () => {
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, logoIconUrl: 'https://e.test/a"><img src=x>' },
    });
    const html = await render('welcome', {}, 'org1');
    assert.doesNotMatch(html, /"><img src=x>/, 'broke out of the src attribute');
    assert.match(html, /&quot;&gt;&lt;img src=x&gt;/);
  });

  it('leaves the SUBJECT unescaped — it is a plain-text header', async () => {
    // "Smith & Co" must not reach an inbox as "Smith &amp; Co".
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, productName: 'Smith & Co' },
    });
    const trigger = SYSTEM_TRIGGERS.find((t) => t.id === 'welcome');
    const data = Object.fromEntries(
      trigger.variables
        .filter((v) => !['brandName', 'supportEmail', 'logoUrl', 'primaryColor'].includes(v))
        .map((v) => [v, `VAL_${v}`])
    );
    const opts = { to: 'x@example.com', data };
    await applyCustomTemplate('welcome', opts, 'org1');
    assert.match(opts.subject, /Smith & Co/, 'subject was HTML-escaped');
    assert.doesNotMatch(opts.subject, /&amp;/);
  });

  it('does not escape the AI-Tracker row fragments', async () => {
    // The reason escaping is per-key and not wholesale: these are markup on
    // purpose. Escaping them turns the scan email into visible tag soup.
    const html = await render('scan_completed', {
      platformRows: '<tr><td>ChatGPT</td></tr>',
    });
    assert.match(html, /<tr><td>ChatGPT<\/td><\/tr>/, 'row fragment was escaped');
  });
});

describe('wordmark', () => {
  it('renders the platform name beside the mark', async () => {
    const html = await render('welcome');
    assert.match(html, />SupaRank<\/span>/);
  });

  it("renders the tenant's product name beside the mark", async () => {
    brandService.getBrandForOrg = async () => ({
      brand: { ...PLATFORM_BRAND, productName: 'Acme Rank' },
    });
    const html = await render('welcome', {}, 'org1');
    assert.match(html, />Acme Rank<\/span>/);
    assert.match(html, /alt="Acme Rank"/);
  });
});
