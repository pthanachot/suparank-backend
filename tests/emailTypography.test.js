/**
 * Typography and the single CTA spec (Phase 3).
 *
 * Two things this pins that are easy to regress:
 *
 * 1. FONT-FAMILY ON EVERY TEXT CELL. Outlook's Word engine does not cascade
 *    font-family into nested tables, so a cell that relies on inheritance
 *    renders in Times New Roman there — and nowhere else, which is why it
 *    survives review. Every cell that carries text must name the stack.
 *
 * 2. ONE BUTTON. Before this there were three specs across seven buttons
 *    (12px/32px + bold, the same + 14px/700, and one outlier at 14px/32px with
 *    radius 12). They now all come from ctaButton(), matching `.btn--lg` in
 *    homepage.css.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

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
  ctaButton,
} = require('../src/controllers/emailPortalController');

const ALL = Object.entries(ORIGINAL_DEFAULT_TEMPLATES);
const STACK = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Cells that hold text directly (no nested cell), minus mso comments. */
function textCells(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/g;
  const out = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const [, , attrs, inner] = m;
    if (/<t[dh][ >]/.test(inner)) continue; // layout cell, not a text cell
    if (!inner.replace(/<[^>]+>/g, '').trim()) continue; // empty / image only
    out.push(attrs);
  }
  return out;
}

describe('font stack', () => {
  it('no template still hardcodes Arial as the primary family', () => {
    for (const [id, tpl] of ALL) {
      assert.doesNotMatch(
        tpl.html,
        /font-family:Arial,sans-serif/,
        `${id}: still on the bare Arial stack`
      );
    }
  });

  it('names Inter first, with an Arial fallback', () => {
    for (const [id, tpl] of ALL) {
      assert.ok(tpl.html.includes(STACK), `${id}: font stack missing or altered`);
      // Not webfont-loaded on purpose — Gmail strips @import and <link>.
      assert.doesNotMatch(tpl.html, /@import|fonts\.googleapis/, `${id}: tried to load a webfont`);
    }
  });

  it('every text-bearing cell names the family — Outlook will not inherit it', () => {
    for (const [id, tpl] of ALL) {
      const bare = textCells(tpl.html).filter((a) => !a.includes('font-family'));
      assert.equal(bare.length, 0, `${id}: ${bare.length} text cell(s) without font-family`);
    }
  });

  it('carries the app body tracking', () => {
    for (const [id, tpl] of ALL) {
      assert.match(tpl.html, /letter-spacing:-0\.011em/, `${id}: no body tracking`);
    }
  });
});

describe('one CTA spec', () => {
  const WITH_CTA = [
    'welcome',
    'verify_email_link',
    'member_invite',
    'payment_failed',
    'topup_requested',
    'analysis_ready',
    'monthly_report',
    'scan_completed',
  ];

  it('the helper matches .btn--lg from homepage.css', () => {
    // height 46 = 13 + 20 + 13; padding 22 side; radius 8; 15px; 600; -0.01em
    const html = ctaButton('https://x.test', 'Label');
    assert.match(html, /padding:13px 22px/);
    assert.match(html, /font-size:15px/);
    assert.match(html, /line-height:20px/);
    assert.match(html, /font-weight:600/);
    assert.match(html, /letter-spacing:-0\.01em/);
    assert.match(html, /border-radius:8px/);
    assert.match(html, /color:#FFFFFF/);
  });

  it('centres with the align attribute, not margin:auto alone', () => {
    // Outlook ignores margin:auto on a table, same as it does on a div. The
    // first cut of this helper shipped with only the margin, which would have
    // left every button left-aligned in Outlook.
    const html = ctaButton('https://x.test', 'Label');
    assert.match(html, /<table role="presentation" align="center"/);
  });

  it('fills via the bgcolor attribute, which Outlook honours on a cell', () => {
    // An inline background-color on an <a> renders as unfilled blue text in
    // Outlook — the single most common broken-button bug in email.
    const html = ctaButton('https://x.test', 'Label');
    assert.match(html, /<td align="center" bgcolor="\{\{primaryColor\}\}"/);
  });

  it('takes a colour override for status buttons', () => {
    const html = ctaButton('https://x.test', 'Label', { bg: '#DC2626' });
    assert.match(html, /bgcolor="#DC2626"/);
    assert.doesNotMatch(html, /\{\{primaryColor\}\}/);
  });

  it('every button in every template comes from the helper', () => {
    for (const id of WITH_CTA) {
      const { html } = ORIGINAL_DEFAULT_TEMPLATES[id];
      assert.match(html, /<td align="center" bgcolor="/, `${id}: button is not the shared one`);
    }
  });

  it('the three old ad-hoc specs are gone', () => {
    for (const [id, tpl] of ALL) {
      assert.doesNotMatch(tpl.html, /padding:12px 32px/, `${id}: old 12/32 button`);
      assert.doesNotMatch(tpl.html, /padding:14px 32px/, `${id}: old 14/32 button`);
      assert.doesNotMatch(tpl.html, /font-weight:bold/, `${id}: unnormalised font-weight`);
      // Scoped to anchors: the shell's CARD is legitimately border-radius:12px,
      // it was verify_email_link's BUTTON that was the outlier.
      const anchorRadii = (tpl.html.match(/<a [^>]*border-radius:(\d+)px/g) || [])
        .map((a) => a.match(/border-radius:(\d+)px/)[1]);
      for (const r of anchorRadii) {
        assert.equal(r, '8', `${id}: button radius ${r}px, expected the token 8px`);
      }
    }
  });

  it('no bare anchor is styled as a button any more', () => {
    // The failure mode this replaces: <a style="background-color:…">
    for (const [id, tpl] of ALL) {
      assert.doesNotMatch(
        tpl.html,
        /<a [^>]*background-color:/,
        `${id}: anchor still carries its own fill`
      );
    }
  });

  it('leaves templates that never had a button without one', () => {
    const noCta = SYSTEM_TRIGGERS.map((t) => t.id).filter((id) => !WITH_CTA.includes(id));
    for (const id of noCta) {
      assert.doesNotMatch(
        ORIGINAL_DEFAULT_TEMPLATES[id].html,
        /<td align="center" bgcolor="/,
        `${id}: gained a button it should not have`
      );
    }
  });
});
