/**
 * Email portal controller — admin email management for SupaRank.
 */

const User = require('../models/User');
const EmailTemplate = require('../models/EmailTemplate');
const EmailSendLog = require('../models/EmailSendLog');
const TriggerableEmailTemplate = require('../models/TriggerableEmailTemplate');
const { sendEmail } = require('../utils/emailService');
const { htmlEscape } = require('../utils/htmlEscape');
const { FONT_STACK, TRACKING_BODY, EMAIL_WIDTH } = require('../utils/emailTheme');
const adminAudit = require('../services/adminAuditService');
const AUDIT = require('../services/adminAuditActions');
// Called via module property (not destructured) so tests can stub them.
const flagService = require('../services/flagService');
const brandService = require('../services/brandService');

// ─── System email triggers (SupaRank-specific) ─────────────

const SYSTEM_TRIGGERS = [
  // Auth
  {
    id: 'welcome',
    preheader: 'Your workspace is ready — here is where to start.',
    name: 'Welcome Email',
    description: 'Sent when a new user signs up',
    category: 'auth',
    variables: ['userName', 'loginUrl', 'brandName', 'supportEmail', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'verify_email',
    preheader: 'Your verification code, valid for 15 minutes.',
    name: 'Email Verification',
    description: 'Verification code sent during signup',
    category: 'auth',
    variables: ['code', 'expiresIn', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'verify_email_link',
    preheader: 'One click to confirm your email address.',
    name: 'Email Verification Link',
    description: 'Link-based email verification (signup, resend, email change)',
    category: 'auth',
    variables: ['userName', 'verifyUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'password_reset',
    preheader: 'Your password reset code, valid for 15 minutes.',
    name: 'Password Reset',
    description: 'Password reset code',
    category: 'auth',
    variables: ['code', 'expiresIn', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'member_invite',
    preheader: '{{inviterName}} has invited you to {{orgName}}.',
    name: 'Member Invitation',
    description: 'Sent when someone is invited to join an organization',
    category: 'auth',
    variables: ['inviterName', 'orgName', 'role', 'acceptUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  // Billing
  {
    id: 'payment_confirmation',
    preheader: 'Payment received — your {{planName}} plan is active.',
    name: 'Payment Confirmation',
    description: 'Sent after successful payment',
    category: 'billing',
    variables: ['userName', 'planName', 'amount', 'nextBillingDate', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'subscription_canceled',
    preheader: 'Your plan is cancelled; access continues until {{endDate}}.',
    name: 'Subscription Canceled',
    description: 'Confirmation of subscription cancellation',
    category: 'billing',
    variables: ['userName', 'planName', 'endDate', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'payment_failed',
    preheader: 'We could not process your payment — action needed.',
    name: 'Payment Failed',
    description: 'Notification of failed payment',
    category: 'billing',
    variables: ['userName', 'planName', 'retryDate', 'updatePaymentUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'credits_low',
    preheader: '{{remainingCredits}} credits left on your {{planName}} plan.',
    name: 'Credits Running Low',
    description: 'Notification when credits are below threshold',
    category: 'billing',
    variables: ['userName', 'remainingCredits', 'planName', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  {
    id: 'topup_requested',
    preheader: '{{requesterName}} is asking you to top up credits.',
    name: 'Credit Top-Up Requested',
    description: 'Sent to the org owner when an admin/editor requests a credit top-up',
    category: 'billing',
    variables: ['userName', 'requesterName', 'requesterEmail', 'amount', 'note', 'billingUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  // Feedback
  {
    id: 'feedback_submitted',
    preheader: 'New in-app feedback from {{userEmail}}.',
    name: 'Feedback Submitted',
    description: 'Sent to support@suparank.ai when a user submits in-app feedback',
    category: 'engagement',
    variables: ['feature', 'rating', 'stars', 'comment', 'userEmail', 'submittedAt', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  // Support
  {
    id: 'contact_submitted',
    preheader: 'New contact form submission from {{userEmail}}.',
    name: 'Contact Form Submitted',
    description: 'Sent to support when a user submits the contact form',
    category: 'support',
    variables: ['userName', 'userEmail', 'subject', 'category', 'message', 'submittedAt', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  // Reports
  {
    id: 'monthly_report',
    preheader: 'Your {{period}} performance report for {{workspaceName}}.',
    name: 'Monthly Workspace Report',
    description: "Sent on the 1st of each month with a link to the previous month's workspace report",
    category: 'reports',
    variables: ['workspaceName', 'period', 'reportUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
  // AI Tracker
  {
    id: 'scan_completed',
    preheader: '{{visibility}}% visibility across {{promptsScanned}}.',
    name: 'AI Scan Completed',
    description: 'Sent to the workspace owner when an AI Tracker scan finishes',
    category: 'ai-tracker',
    variables: ['userName', 'trackerName', 'domain', 'scanDate', 'promptsScanned', 'visibility', 'mentionRate', 'shareOfVoice', 'citationRate', 'avgSentiment', 'platformRows', 'promptRows', 'competitorRows', 'actionRows', 'dashboardUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
    triggerCount: 0,
  },
];

/**
 * When the built-in default templates last changed materially.
 *
 * An override row is a SNAPSHOT: whoever saved it copied the default as it
 * looked that day and edited from there. Decision D2 says we never rewrite
 * that content — it is theirs — so the only way an agency learns their copy
 * has fallen behind is if we tell them. Any override saved before this date
 * predates the current defaults and is flagged stale in both editors.
 *
 * BUMP THIS whenever ORIGINAL_DEFAULT_TEMPLATES, wrapTemplate, BRAND_HEADER or
 * ctaButton change in a way a tenant would want to pick up. Deliberately one
 * date for all 14 rather than per-trigger: the shell, the brand header and the
 * button are shared, so a change to any of them touches every template.
 *
 * 2026-08-08 — brand logo, design tokens, Outlook shell + dark mode,
 * Inter/CTA typography, preheader (the four-phase alignment work).
 */
const DEFAULTS_REVISED_AT = new Date('2026-08-08T00:00:00.000Z');

/**
 * True when an override row was last saved before the current defaults.
 * Rows with no timestamp are treated as stale — a row that predates
 * `timestamps: true` is by definition older than any revision we tracked.
 */
const isOverrideStale = (row) => {
  if (!row) return false; // no override — nothing to fall behind
  if (!row.defaultSubject && !row.defaultHtml) return false; // stats-only row
  if (!row.updatedAt) return true;
  return new Date(row.updatedAt) < DEFAULTS_REVISED_AT;
};

// ─── Type + CTA (Phase 3) ───────────────────────────────────
// FONT_STACK / TRACKING_BODY / EMAIL_WIDTH live in utils/emailTheme so that
// utils/scanEmailRows can share them without a controller→controller require.

/**
 * One call-to-action button, matching `.btn--lg` from homepage.css:
 * height 46 (13px padding + 20px line-height), 22px side padding, radius 8,
 * 15px, weight 600, tracking -0.01em.
 *
 * WHY A TABLE AND NOT VML. Outlook's Word engine ignores `background-color`
 * on an inline `<a>`, so a bare anchor renders as blue underlined text with no
 * fill. The usual fixes are a VML `<v:roundrect>` or a table cell with the
 * `bgcolor` ATTRIBUTE. VML buys rounded corners in Outlook specifically, but
 * costs a hardcoded pixel WIDTH per button — which breaks the moment a label
 * is edited or translated — plus an `xmlns:w` declaration. The table cell
 * needs neither and sizes itself to the label; the only loss is square
 * corners in Outlook, which is where these buttons already lose their radius
 * today.
 *
 * `bgcolor` takes {{primaryColor}} because it is substituted before send and
 * brandService validates it as /^#[0-9a-fA-F]{6}$/.
 */
const ctaButton = (href, label, { bg = '{{primaryColor}}' } = {}) =>
  // `align="center"` is load-bearing, not decoration: Outlook's Word engine
  // ignores `margin:auto` on a table exactly as it ignores it on a div (the
  // Phase 2 bug). The buttons this replaced were inline-blocks inside a
  // `text-align:center` div, which Outlook DID centre — so shipping margin
  // alone would have left every button left-aligned there.
  `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:32px auto;">
      <tr>
        <td align="center" bgcolor="${bg}" style="font-family:${FONT_STACK};border-radius:8px;">
          <a href="${href}" style="display:inline-block;padding:13px 22px;font-family:${FONT_STACK};font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none;border-radius:8px;">${label}</a>
        </td>
      </tr>
    </table>`;

// ─── Brand header ───────────────────────────────────────────

/**
 * The platform logomark, as a hosted PNG.
 *
 * WHY A PNG AND NOT THE HEADER'S SVG. The app header (AppTopbar → BrandLogo)
 * renders the mark as inline <svg>. That cannot be reused here: Gmail strips
 * <svg> and refuses `.svg` in <img src>, and Outlook's Word rendering engine
 * has never supported SVG at all. The mark is therefore rasterized at build
 * time by suparank/scripts/build-email-logo.mjs, from the same vector, and
 * served from the frontend's public dir — the backend serves no static files.
 */
const PLATFORM_EMAIL_LOGO = () =>
  `${process.env.FRONTEND_URL || 'https://app.suparank.ai'}/brand/suparank-mark.png`;

/**
 * The logo + wordmark lockup that opens every email, mirroring the app
 * header's `<BrandLogo showWordmark />`.
 *
 * Table-based on purpose: flexbox and inline-block alignment are unreliable
 * in Outlook, and a two-cell table is the one horizontal-alignment primitive
 * every client renders. The image carries an explicit `height` ATTRIBUTE as
 * well as the CSS, because Outlook ignores the style block; width is left
 * auto so a tenant's wide lockup scales proportionally instead of being
 * squashed into a square (same trade-off as BrandLogo's non-icon branch).
 */
const BRAND_HEADER = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 28px 0;">
    <tr>
      <td style="padding:0 10px 0 0;vertical-align:middle;"><img src="{{logoUrl}}" alt="{{brandName}}" height="40" style="display:block;height:40px;width:auto;max-width:200px;border:0;outline:none;text-decoration:none;" /></td>
      <td style="font-family:${FONT_STACK};vertical-align:middle;"><span style="font-family:${FONT_STACK};font-size:19px;font-weight:800;letter-spacing:-0.02em;color:#111827;">{{brandName}}</span></td>
    </tr>
  </table>`;

/**
 * Auto-injected brand values that MUST be escaped before they enter the HTML.
 *
 * These are the only substituted values that are always plain text — unlike
 * aiTrackerController's `platformRows`/`promptRows`, which pass `<tr>`
 * fragments on purpose and are why escaping cannot be applied to `data`
 * wholesale (see utils/htmlEscape.js).
 *
 * They are also tenant-controlled and reach ATTRIBUTE contexts, which is what
 * makes them dangerous:
 *   - `brandName` is BrandConfig.productName, validated for LENGTH ONLY
 *     (brandService.strField), and lands in `alt="…"` and `<title>`;
 *   - `logoUrl` is BrandConfig.logoIconUrl/logoUrl and lands in `src="…"`.
 *     Its validator calls `new URL()`, which happily accepts
 *     `https://x/a"><img src=y>`, and then stores the RAW input rather than
 *     the normalised href — and the `startsWith('/')` branch skips URL
 *     parsing altogether.
 *
 * Without this, a white-label agency could put arbitrary markup in an email
 * delivered to THEIR clients over our SPF/DKIM. Mail clients don't execute
 * script, so this is HTML/CSS injection rather than XSS, but hidden content
 * and forged links are quite enough. Escaping a URL inside an attribute is
 * lossless — `&amp;` is the correct HTML spelling of `&` and every client
 * decodes it.
 */
const BRAND_ESCAPED_KEYS = new Set(['brandName', 'supportEmail', 'logoUrl']);

// ─── Email shell (Phase 2) ──────────────────────────────────

/**
 * Zero-width padding that follows the preheader.
 *
 * Without it, Gmail and Outlook.com keep reading past the preheader and pull
 * the first line of visible body copy into the inbox snippet — so the snippet
 * reads "Your July report is ready Your monthly report is ready The July…".
 * A run of invisible characters fills the snippet buffer instead. They are
 * zero-width/non-joiner, so nothing renders if a client ignores display:none.
 */
const PREHEADER_PAD = '&#847;&zwnj;&nbsp;'.repeat(60);

/**
 * Wrap inner content in the standard email document.
 *
 * WHY THE DEFAULTS STAY FULL DOCUMENTS. The obvious shape for this is to store
 * inner content in ORIGINAL_DEFAULT_TEMPLATES and wrap at resolution time in
 * getTemplateForTrigger. That would be wrong here, because an override row —
 * admin or tenant — saved before this change holds a FULL `<div>` document.
 * Wrapping at resolution time would either double-wrap those or need a
 * heuristic ("does this look like a full document?") applied to customer HTML,
 * which is precisely the kind of guess that fails silently in someone's inbox.
 *
 * Wrapping at DEFINITION time keeps `.html` a complete document exactly as it
 * was, so resolution, the 50 000-char tenant cap, and every existing override
 * behave identically. Old overrides keep rendering as the bare divs they are —
 * degraded, but no worse than today, and D2 says we never rewrite them.
 *
 * The markup itself is the conventional bulletproof shell:
 *   - a 100%-width outer table, because `margin:0 auto` on a div does not
 *     centre in Outlook's Word engine;
 *   - an mso conditional fixing the inner table to a hard 600px, because
 *     Outlook ignores `max-width`;
 *   - explicit background-color on BOTH tables — the templates set text
 *     colours with no background, so a dark-mode client that inverts the
 *     canvas but not the inline colour renders dark text on a dark card;
 *   - `color-scheme` / `supported-color-schemes`, the declarative opt-out of
 *     that auto-inversion in Apple Mail, iOS and Outlook.com.
 *
 * `font-family` is Arial here only because that is what the templates already
 * used; Phase 3 swaps the stack in this one place instead of 14.
 */
const wrapTemplate = (inner) => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>{{brandName}}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  table { border-collapse:collapse; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  body, table, td { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  @media only screen and (max-width:${EMAIL_WIDTH}px) {
    .sr-card { width:100% !important; }
    .sr-pad { padding:24px 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#F7F8FA;">
<div class="sr-preheader" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#F7F8FA;">{{preheader}}${PREHEADER_PAD}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F8FA;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <!--[if mso]><table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" class="sr-card" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_WIDTH}px;background-color:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;">
        <tr>
          <!-- No line-height here on purpose. A unitless value inherits as a
               FACTOR, so 1.6 on this cell reaches every nested table cell in
               the scan report and inflates dense rows, and reaches headings
               that want their own tighter leading. Body copy declares
               line-height:1.6 on its own <p>, which is where it belongs. -->
          <td class="sr-pad" style="padding:32px;font-family:${FONT_STACK};font-size:16px;letter-spacing:${TRACKING_BODY};color:#111827;">
${inner}
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;

// ─── Original default templates (hardcoded, used as fallback) ─

const ORIGINAL_DEFAULT_TEMPLATES = {
  welcome: {
    subject: 'Welcome to {{brandName}}!',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h1 style="color:#111827;font-size:24px;margin-bottom:16px;">Welcome to {{brandName}}!</h1>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">We're excited to have you on board. {{brandName}} helps you track your AI visibility, optimize your brand voice, and stay ahead of the competition.</p>
  ${ctaButton('{{loginUrl}}', 'Get Started')}
  <p style="color:#9CA3AF;font-size:14px;">If you have any questions, feel free to reach out to our support team at {{supportEmail}}.</p>
`),
    variables: ['userName', 'loginUrl', 'brandName', 'supportEmail', 'logoUrl', 'primaryColor', 'preheader'],
  },
  verify_email: {
    subject: '{{brandName}} — Verify your email',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h2 style="color:#111827;margin-bottom:16px;">Verify your email</h2>
  <p style="color:#4B5563;margin-bottom:24px;">Enter this code to verify your email address:</p>
  <div style="background:#F3F4F6;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;">{{code}}</span>
  </div>
  <p style="color:#9CA3AF;font-size:14px;">This code expires in {{expiresIn}}.</p>
  <p style="color:#9CA3AF;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
`),
    variables: ['code', 'expiresIn', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  verify_email_link: {
    subject: '{{brandName}} — Verify your email',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h2 style="color:#111827;margin-bottom:16px;">Verify your email</h2>
  <p style="color:#4B5563;margin-bottom:24px;">Hi {{userName}}, click the button below to verify your email address:</p>
  ${ctaButton('{{verifyUrl}}', 'Verify Email')}
  <p style="color:#9CA3AF;font-size:14px;margin-top:24px;">This link expires in 24 hours.</p>
  <p style="color:#9CA3AF;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
`),
    variables: ['userName', 'verifyUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  password_reset: {
    subject: '{{brandName}} — Reset your password',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h2 style="color:#111827;margin-bottom:16px;">Reset your password</h2>
  <p style="color:#4B5563;margin-bottom:24px;">Enter this code to reset your password:</p>
  <div style="background:#F3F4F6;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;">{{code}}</span>
  </div>
  <p style="color:#9CA3AF;font-size:14px;">This code expires in {{expiresIn}}.</p>
  <p style="color:#9CA3AF;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
`),
    variables: ['code', 'expiresIn', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  member_invite: {
    subject: "You've been invited to join {{orgName}}",
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h2 style="color:#111827;margin-bottom:16px;">You're invited</h2>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">{{inviterName}} has invited you to join <strong>{{orgName}}</strong> as {{role}}.</p>
  ${ctaButton('{{acceptUrl}}', 'Accept invitation')}
  <p style="color:#9CA3AF;font-size:14px;">This invitation expires in 7 days.</p>
  <p style="color:#9CA3AF;font-size:14px;">If you weren't expecting this, you can safely ignore this email.</p>
`),
    variables: ['inviterName', 'orgName', 'role', 'acceptUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  payment_confirmation: {
    subject: 'Payment Confirmed - {{planName}}',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h1 style="color:#111827;font-size:24px;margin-bottom:16px;">Payment Confirmed</h1>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Your payment of <strong>{{amount}}</strong> for <strong>{{planName}}</strong> has been processed successfully.</p>
  <div style="background:#F3F4F6;border-radius:8px;padding:16px;margin:24px 0;">
    <p style="color:#4B5563;margin:4px 0;"><strong>Plan:</strong> {{planName}}</p>
    <p style="color:#4B5563;margin:4px 0;"><strong>Next billing date:</strong> {{nextBillingDate}}</p>
  </div>
  <p style="color:#9CA3AF;font-size:14px;">Thank you for your continued support!</p>
`),
    variables: ['userName', 'planName', 'amount', 'nextBillingDate', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  subscription_canceled: {
    subject: 'Subscription Canceled - {{brandName}}',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h1 style="color:#111827;font-size:24px;margin-bottom:16px;">Subscription Canceled</h1>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Your <strong>{{planName}}</strong> subscription has been canceled.</p>
  <div style="background:#FFFBEB;border:1px solid #D97706;border-radius:8px;padding:16px;margin:24px 0;">
    <p style="color:#B45309;margin:0;">Your access continues until <strong>{{endDate}}</strong>. After that, your account will revert to the free plan.</p>
  </div>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">If you change your mind, you can re-subscribe at any time from your billing settings.</p>
  <p style="color:#9CA3AF;font-size:14px;">We hope to see you back soon!</p>
`),
    variables: ['userName', 'planName', 'endDate', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  payment_failed: {
    subject: 'Payment Failed - Action Required',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h1 style="color:#DC2626;font-size:24px;margin-bottom:16px;">Payment Failed</h1>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">We were unable to process your payment for <strong>{{planName}}</strong>.</p>
  <div style="background:#FEF2F2;border:1px solid #EF4444;border-radius:8px;padding:16px;margin:24px 0;">
    <p style="color:#B91C1C;margin:0;">We'll retry your payment on <strong>{{retryDate}}</strong>. Please update your payment method to avoid interruption.</p>
  </div>
  ${ctaButton('{{updatePaymentUrl}}', 'Update Payment Method', { bg: '#DC2626' })}
`),
    variables: ['userName', 'planName', 'retryDate', 'updatePaymentUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  credits_low: {
    subject: 'Credits Running Low - {{brandName}}',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h1 style="color:#D97706;font-size:24px;margin-bottom:16px;">Credits Running Low</h1>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">You have <strong>{{remainingCredits}}</strong> credits remaining on your <strong>{{planName}}</strong> plan.</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Consider upgrading your plan to get more credits and continue using all features without interruption.</p>
`),
    variables: ['userName', 'remainingCredits', 'planName', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  topup_requested: {
    subject: 'Credit top-up requested by {{requesterName}}',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h1 style="color:#111827;font-size:24px;margin-bottom:16px;">Credit Top-Up Requested</h1>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;"><strong>{{requesterName}}</strong> ({{requesterEmail}}) has requested a credit top-up for your organization.</p>
  <div style="background:#F3F4F6;border-radius:8px;padding:16px;margin:24px 0;">
    <p style="color:#4B5563;margin:4px 0;"><strong>Requested amount:</strong> {{amount}}</p>
    <p style="color:#4B5563;margin:4px 0;"><strong>Note:</strong> {{note}}</p>
  </div>
  ${ctaButton('{{billingUrl}}', 'Buy Credits')}
  <p style="color:#9CA3AF;font-size:14px;">Only you (the owner) can purchase credits for the organization.</p>
`),
    variables: ['userName', 'requesterName', 'requesterEmail', 'amount', 'note', 'billingUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  feedback_submitted: {
    subject: '[{{brandName}} Feedback] {{stars}} — {{feature}}',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h2 style="color:#111827;margin-bottom:4px;">New Feedback Received</h2>
  <p style="color:#6B7280;font-size:14px;margin-top:0;">{{brandName}} In-App Feedback</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;width:140px;">Feature</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;">{{feature}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;">Rating</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#D97706;font-size:20px;">{{stars}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;">User</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;">{{userEmail}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Comment</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;">{{comment}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#6B7280;font-size:13px;">{{submittedAt}}</td></tr>
  </table>
`),
    variables: ['feature', 'rating', 'stars', 'comment', 'userEmail', 'submittedAt', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  contact_submitted: {
    subject: '[{{brandName}} Contact] {{category}} — {{subject}}',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h2 style="color:#111827;margin-bottom:4px;">New Contact Form Submission</h2>
  <p style="color:#6B7280;font-size:14px;margin-top:0;">{{brandName}} Help Center</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;width:140px;">User</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;">{{userName}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;">Email</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;">{{userEmail}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;">Category</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;">{{category}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;">Subject</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;">{{subject}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Message</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#111827;white-space:pre-wrap;">{{message}}</td></tr>
    <tr><td style="font-family:${FONT_STACK};padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="font-family:${FONT_STACK};padding:8px 0;color:#6B7280;font-size:13px;">{{submittedAt}}</td></tr>
  </table>
`),
    variables: ['userName', 'userEmail', 'subject', 'category', 'message', 'submittedAt', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  monthly_report: {
    subject: 'Your {{period}} report for {{workspaceName}} is ready',
    html: wrapTemplate(`
  ${BRAND_HEADER}
  <h1 style="color:#111827;font-size:24px;margin-bottom:16px;">Your monthly report is ready</h1>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">The <strong>{{period}}</strong> performance report for <strong>{{workspaceName}}</strong> has been generated.</p>
  <p style="color:#4B5563;font-size:16px;line-height:1.6;">It covers content production, on-page scores, AI visibility and search performance for the month.</p>
  ${ctaButton('{{reportUrl}}', 'View Report')}
  <p style="color:#9CA3AF;font-size:14px;">This link expires in 90 days. You're receiving this because you're part of this workspace on {{brandName}}.</p>
`),
    variables: ['workspaceName', 'period', 'reportUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
  scan_completed: {
    subject: 'AI Scan Complete – {{trackerName}}',
    html: wrapTemplate(`

  <!-- Brand -->
  ${BRAND_HEADER}

  <!-- Header -->
  <h1 style="font-size:20px;font-weight:700;margin:0 0 6px 0;">AI Tracker Scan Complete</h1>
  <p style="color:#6B7280;font-size:14px;margin:0 0 24px 0;">Hi {{userName}} &mdash; <strong>{{domain}}</strong> was scanned on {{scanDate}}.</p>

  <!-- Key Metrics -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:{{primaryColor}};margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid {{primaryColor}};">Key Metrics</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;margin-bottom:24px;">
    <tr>
      <td style="font-family:${FONT_STACK};padding:14px;text-align:center;border-right:1px solid #E5E7EB;background:#F9FAFB;">
        <div style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Visibility</div>
        <div style="font-size:22px;font-weight:700;">{{visibility}}</div>
      </td>
      <td style="font-family:${FONT_STACK};padding:14px;text-align:center;border-right:1px solid #E5E7EB;background:#F9FAFB;">
        <div style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Mention Rate</div>
        <div style="font-size:22px;font-weight:700;">{{mentionRate}}%</div>
      </td>
      <td style="font-family:${FONT_STACK};padding:14px;text-align:center;border-right:1px solid #E5E7EB;background:#F9FAFB;">
        <div style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Share of Voice</div>
        <div style="font-size:22px;font-weight:700;">{{shareOfVoice}}%</div>
      </td>
      <td style="font-family:${FONT_STACK};padding:14px;text-align:center;border-right:1px solid #E5E7EB;background:#F9FAFB;">
        <div style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Citation Rate</div>
        <div style="font-size:22px;font-weight:700;">{{citationRate}}%</div>
      </td>
      <td style="font-family:${FONT_STACK};padding:14px;text-align:center;background:#F9FAFB;">
        <div style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Sentiment</div>
        <div style="font-size:14px;font-weight:600;">{{avgSentiment}}</div>
      </td>
    </tr>
  </table>

  <!-- Platform Breakdown -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #E5E7EB;">Platform Breakdown</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E7EB;margin-bottom:24px;">
    <thead>
      <tr style="background:#F9FAFB;">
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Platform</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Visibility</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Mentions</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Citations</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;"></th>
      </tr>
    </thead>
    <tbody>{{platformRows}}</tbody>
  </table>

  <!-- Tracked Prompts -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #E5E7EB;">Tracked Prompts ({{promptsScanned}})</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E7EB;margin-bottom:24px;">
    <thead>
      <tr style="background:#F9FAFB;">
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Status</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">#</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Prompt</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Platforms</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Mention</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Citation</th>
      </tr>
    </thead>
    <tbody>{{promptRows}}</tbody>
  </table>

  <!-- Competitors -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #E5E7EB;">Top Competitors</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E7EB;margin-bottom:24px;">
    <thead>
      <tr style="background:#F9FAFB;">
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">#</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Brand</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Mentions</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Citations</th>
        <th style="font-family:${FONT_STACK};padding:8px 14px;text-align:left;color:#6B7280;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #E5E7EB;">Visibility</th>
      </tr>
    </thead>
    <tbody>{{competitorRows}}</tbody>
  </table>

  <!-- Recommended Actions -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #E5E7EB;">Recommended Actions</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E7EB;margin-bottom:28px;">
    <tbody>{{actionRows}}</tbody>
  </table>

  <!-- CTA -->
  ${ctaButton('{{dashboardUrl}}', 'View Full Dashboard')}
  <p style="color:#9CA3AF;font-size:11px;text-align:center;margin:0;">You&rsquo;re receiving this because email notifications are enabled on your {{brandName}} account.</p>
`),
    variables: ['userName', 'trackerName', 'domain', 'scanDate', 'promptsScanned', 'visibility', 'mentionRate', 'shareOfVoice', 'citationRate', 'avgSentiment', 'platformRows', 'promptRows', 'competitorRows', 'actionRows', 'dashboardUrl', 'brandName', 'logoUrl', 'primaryColor', 'preheader'],
  },
};

// ─── Template resolution helpers ────────────────────────────

// Legacy global rows predate the organizationId field entirely, so the
// GLOBAL row is "organizationId null OR missing".
const _globalRowFilter = (triggerId) => ({
  triggerId,
  $or: [{ organizationId: null }, { organizationId: { $exists: false } }],
});

/**
 * Resolve the template for a trigger.
 * Resolution order (Phase 12):
 *   (a) TENANT override — only when organizationId is given AND the
 *       whiteLabelEmail launch flag is live AND the org row exists;
 *   (b) GLOBAL admin override (organizationId null/missing);
 *   (c) hardcoded original default.
 * Also increments trigger stats (triggerCount, lastTriggered) on the
 * GLOBAL row — never creates tenant rows as a side effect.
 *
 * DATABASE FAILURE DEGRADES TO THE HARDCODED DEFAULT (Phase 4). It used to
 * return null: one try/catch wrapped the whole body, so a transient Mongo
 * error while reading an OVERRIDE discarded the perfectly good hardcoded
 * template too. Every caller then fell through to its own duplicate
 * unstyled copy of the email — no logo, no shell, no brand colour — which is
 * also why those copies existed. Overrides need the database; defaults never
 * did. Now only the override lookup is at risk, so this returns null solely
 * for an unknown triggerId.
 */
const getTemplateForTrigger = async (triggerId, organizationId = null) => {
  const originalDefault = ORIGINAL_DEFAULT_TEMPLATES[triggerId];
  if (!originalDefault) {
    console.warn(`[triggers] No original template for triggerId=${triggerId}`);
    return null;
  }

  try {
    let tenant = null;
    if (organizationId && (await flagService.isFlagLive('whiteLabelEmail'))) {
      // Downgrade semantics match brandService: the override row is retained
      // but only APPLIES while the org keeps the white-label entitlement —
      // otherwise a downgraded org's custom HTML would ship with platform
      // branding substituted into it. Guarded so a brand-lookup failure
      // only skips the tenant override (fail-closed) without breaking the
      // global/default resolution below. (Both lookups are 5-min cached.)
      let entitled = false;
      try {
        ({ entitled } = await brandService.getBrandForOrg(organizationId));
      } catch (err) {
        console.error('[triggers] entitlement lookup failed:', err.message);
      }
      if (entitled) {
        tenant = await TriggerableEmailTemplate.findOne({ triggerId, organizationId }).lean();
      }
    }

    const saved = await TriggerableEmailTemplate.findOne(_globalRowFilter(triggerId)).lean();

    // Increment stats — always on the GLOBAL row
    await TriggerableEmailTemplate.findOneAndUpdate(
      _globalRowFilter(triggerId),
      {
        $inc: { triggerCount: 1 },
        $set: { lastTriggered: new Date() },
        $setOnInsert: { triggerId, organizationId: null },
      },
      { upsert: true }
    );

    return {
      subject: tenant?.defaultSubject || saved?.defaultSubject || originalDefault.subject,
      html: tenant?.defaultHtml || saved?.defaultHtml || originalDefault.html,
    };
  } catch (error) {
    // Overrides unreachable (DB down, index missing, timeout). The hardcoded
    // default is right here in memory and needs nothing — ship it rather than
    // failing the send. Stats are lost for this one email; that is the cheaper
    // half of the trade.
    console.error(
      `[triggers] override lookup failed for ${triggerId}, using hardcoded default:`,
      error.message
    );
    return { subject: originalDefault.subject, html: originalDefault.html };
  }
};

/**
 * Resolve a trigger template and apply {{variable}} substitution.
 * Mutates emailOptions in place — sets .subject and .html, removes .data.
 * `brandName` / `supportEmail` / `logoUrl` / `primaryColor` are auto-injected
 * into data (resolved brand of `organizationId`, or the platform brand)
 * unless the caller set them.
 *
 * Usage:
 *   const emailOptions = { to: user.email, data: { userName: 'John', planName: 'Pro' } };
 *   await applyCustomTemplate('subscription_canceled', emailOptions, orgIdOrNull);
 *   await sendEmail(emailOptions);
 */
const applyCustomTemplate = async (triggerId, emailOptions, organizationId = null) => {
  try {
    const template = await getTemplateForTrigger(triggerId, organizationId);
    if (template && emailOptions.data) {
      // Enrich with brand variables before substitution. Emails must never
      // fail on brand lookups — fall back to the platform identity.
      if (
        emailOptions.data.brandName === undefined ||
        emailOptions.data.supportEmail === undefined ||
        emailOptions.data.logoUrl === undefined ||
        emailOptions.data.primaryColor === undefined
      ) {
        let brandName = 'SupaRank';
        let supportEmail = 'support@suparank.ai';
        // Same degradation ladder as the app header's <BrandLogo icon>:
        // the tenant's square mark, else their wide lockup, else ours. A
        // tenant's own logo at any shape beats showing them SupaRank's.
        let logoUrl = PLATFORM_EMAIL_LOGO();
        // Solid, not the app's --sr-grad-cta gradient: Outlook's Word engine
        // drops background-image, which would leave a white button with white
        // text. brand-600 is the midpoint of that gradient and is already the
        // platform primaryColor default, so a solid fill reads as the same CTA.
        // Safe to interpolate into a style attribute — brandService validates
        // primaryColor against /^#[0-9a-fA-F]{6}$/ on save.
        let primaryColor = brandService.HARDCODED_DEFAULTS.primaryColor;
        try {
          const brand = organizationId
            ? (await brandService.getBrandForOrg(organizationId)).brand
            : await brandService.getPlatformBrand();
          if (brand?.productName) brandName = brand.productName;
          if (brand?.supportEmail) supportEmail = brand.supportEmail;
          if (brand?.logoIconUrl || brand?.logoUrl) logoUrl = brand.logoIconUrl || brand.logoUrl;
          if (brand?.primaryColor) primaryColor = brand.primaryColor;
        } catch (err) {
          console.error(`[triggers] brand lookup failed for ${triggerId}:`, err.message);
        }
        if (emailOptions.data.brandName === undefined) emailOptions.data.brandName = brandName;
        if (emailOptions.data.supportEmail === undefined) emailOptions.data.supportEmail = supportEmail;
        if (emailOptions.data.logoUrl === undefined) emailOptions.data.logoUrl = logoUrl;
        if (emailOptions.data.primaryColor === undefined) emailOptions.data.primaryColor = primaryColor;
      }

      /**
       * Preheader — the inbox snippet line.
       *
       * Resolved HERE rather than left to the main substitution loop below,
       * because the copy itself contains placeholders ("{{inviterName}} has
       * invited you to {{orgName}}"). That loop walks Object.entries in
       * insertion order, so leaving nested placeholders to it would only work
       * while `preheader` happened to be substituted before the keys it
       * references — order-dependent, and silently wrong the day someone
       * reorders the data bag.
       *
       * NOT escaped. Every value it interpolates is already in `data`, escaped
       * (or not) exactly as the body will render it; escaping again would
       * double-encode the callers that correctly pre-escape.
       */
      if (emailOptions.data.preheader === undefined) {
        const def = SYSTEM_TRIGGERS.find((t) => t.id === triggerId);
        let text = def?.preheader || '';
        for (const [key, value] of Object.entries(emailOptions.data)) {
          text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? ''));
        }
        // A placeholder with no matching data would otherwise ship literally
        // into the inbox snippet, which is worse than a shorter preheader.
        emailOptions.data.preheader = text.replace(/\{\{\w+\}\}/g, '').replace(/\s+/g, ' ').trim();
      }

      // The Subject is a plain-text header (RFC 5322) and is never parsed as
      // HTML, so it takes the RAW values — escaping here would put "Smith
      // &amp; Co" in an agency's subject line.
      emailOptions.subject = Object.entries(emailOptions.data).reduce(
        (subj, [key, value]) =>
          subj.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? '')),
        template.subject
      );
      // The body does NOT. See BRAND_ESCAPED_KEYS.
      emailOptions.html = Object.entries(emailOptions.data).reduce(
        (html, [key, value]) =>
          html.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
            BRAND_ESCAPED_KEYS.has(key) ? htmlEscape(value) : String(value ?? '')
          ),
        template.html
      );
      delete emailOptions.data;
    }
  } catch (error) {
    console.error(`[triggers] applyCustomTemplate error for ${triggerId}:`, error.message);
  }
};

// ─── Subscribers ────────────────────────────────────────────

const getSubscribedUsers = async (req, res) => {
  try {
    const users = await User.find({ status: 'active', 'preferences.emailNotifications': { $ne: false } })
      .select('email profile')
      .lean();

    const subscribers = users.map((u) => ({
      email: u.email,
      name: u.profile?.name || '',
    }));

    res.json({ subscribers, total: subscribers.length });
  } catch (error) {
    console.error('[emailPortal] getSubscribedUsers error:', error.message);
    res.status(500).json({ error: 'Failed to fetch subscribers' });
  }
};

// ─── Send bulk emails ───────────────────────────────────────

const sendBulkEmails = async (req, res) => {
  try {
    const { getSettings } = require('../services/systemSettingsService');
    if (getSettings().emailNotificationsEnabled === false) {
      return res.status(409).json({
        error: 'Email notifications are disabled in system settings. Enable them in Settings before sending.',
      });
    }

    const { subject, htmlContent, recipients, fromName, replyTo } = req.body;

    if (!subject || !htmlContent || !recipients?.length) {
      return res.status(400).json({ error: 'Subject, HTML content, and recipients are required' });
    }

    let successCount = 0;
    let failedCount = 0;
    const failedRecipients = [];

    for (const email of recipients) {
      try {
        await sendEmail({
          to: email,
          subject,
          html: htmlContent,
          ...(fromName && { fromName }),
          ...(replyTo && { replyTo }),
        });
        successCount++;
      } catch {
        failedCount++;
        failedRecipients.push(email);
      }
    }

    // Log the send
    await EmailSendLog.create({
      subject,
      recipientCount: recipients.length,
      successCount,
      failedCount,
      fromName: fromName || 'SupaRank',
      replyTo: replyTo || '',
      sentBy: req.user?.email || 'admin',
      status: failedCount === 0 ? 'completed' : failedCount === recipients.length ? 'failed' : 'partial',
      failedRecipients,
    });

    adminAudit.fromReq(req, { action: AUDIT.EMAIL_SEND, targetType: 'email', targetId: null, meta: { subject, recipientCount: recipients.length, successCount, failedCount } });
    res.json({
      summary: {
        queued: successCount,
        failed: failedCount,
        total: recipients.length,
      },
    });
  } catch (error) {
    console.error('[emailPortal] sendBulkEmails error:', error.message);
    res.status(500).json({ error: 'Failed to send emails' });
  }
};

// ─── Send test email ────────────────────────────────────────

const sendTestEmail = async (req, res) => {
  try {
    const { subject, htmlContent, testEmail, fromName, replyTo } = req.body;

    if (!subject || !htmlContent || !testEmail) {
      return res.status(400).json({ error: 'Subject, HTML content, and test email are required' });
    }

    await sendEmail({
      to: testEmail,
      subject: `[TEST] ${subject}`,
      html: htmlContent,
      ...(fromName && { fromName }),
      ...(replyTo && { replyTo }),
    });

    res.json({ success: true, message: `Test email sent to ${testEmail}` });
  } catch (error) {
    console.error('[emailPortal] sendTestEmail error:', error.message);
    res.status(500).json({ error: 'Failed to send test email' });
  }
};

// ─── Send logs ──────────────────────────────────────────────

const getSendLogs = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const [logs, total] = await Promise.all([
      EmailSendLog.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      EmailSendLog.countDocuments(),
    ]);

    res.json({
      logs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[emailPortal] getSendLogs error:', error.message);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
};

// ─── Portal stats ───────────────────────────────────────────

const getPortalStats = async (req, res) => {
  try {
    const [totalSent, totalFailed, totalCampaigns, templateCount, subscriberCount] = await Promise.all([
      EmailSendLog.aggregate([{ $group: { _id: null, total: { $sum: '$successCount' } } }]),
      EmailSendLog.aggregate([{ $group: { _id: null, total: { $sum: '$failedCount' } } }]),
      EmailSendLog.countDocuments(),
      EmailTemplate.countDocuments(),
      User.countDocuments({ status: 'active' }),
    ]);

    res.json({
      totalSent: totalSent[0]?.total || 0,
      totalFailed: totalFailed[0]?.total || 0,
      totalCampaigns,
      templateCount,
      subscriberCount,
    });
  } catch (error) {
    console.error('[emailPortal] getPortalStats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

// ─── Templates CRUD ─────────────────────────────────────────

const getTemplates = async (req, res) => {
  try {
    const templates = await EmailTemplate.find().sort({ createdAt: -1 }).lean();
    res.json({ templates });
  } catch (error) {
    console.error('[emailPortal] getTemplates error:', error.message);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
};

const saveTemplate = async (req, res) => {
  try {
    const { name, subject, htmlContent, description } = req.body;

    if (!name || !subject || !htmlContent) {
      return res.status(400).json({ error: 'Name, subject, and HTML content are required' });
    }

    const template = await EmailTemplate.create({
      name,
      subject,
      htmlContent,
      description: description || '',
      createdBy: req.user?.email || 'admin',
    });

    adminAudit.fromReq(req, { action: AUDIT.EMAIL_TEMPLATE_SAVE, targetType: 'email', targetId: template._id, meta: { name } });
    res.status(201).json({ template });
  } catch (error) {
    console.error('[emailPortal] saveTemplate error:', error.message);
    res.status(500).json({ error: 'Failed to save template' });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await EmailTemplate.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });
    adminAudit.fromReq(req, { action: AUDIT.EMAIL_TEMPLATE_DELETE, targetType: 'email', targetId: id });
    res.json({ success: true });
  } catch (error) {
    console.error('[emailPortal] deleteTemplate error:', error.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
};

// ─── Triggers ───────────────────────────────────────────────

const getTriggers = async (req, res) => {
  try {
    // Global rows only — tenant overrides are managed via the org routes
    const savedTriggers = await TriggerableEmailTemplate.find({
      $or: [{ organizationId: null }, { organizationId: { $exists: false } }],
    }).lean();
    const triggerMap = {};
    savedTriggers.forEach((t) => {
      triggerMap[t.triggerId] = t;
    });

    const triggers = SYSTEM_TRIGGERS.map((def) => {
      const saved = triggerMap[def.id];
      const originalDefault = ORIGINAL_DEFAULT_TEMPLATES[def.id];
      return {
        ...def,
        lastTriggered: saved?.lastTriggered || null,
        triggerCount: saved?.triggerCount || 0,
        hasDefaultTemplate: !!originalDefault,
        hasCustomDefault: !!saved?.defaultHtml,
        // D2: this override was copied from an older default and has not been
        // refreshed. We never rewrite it, so flagging it is the only way the
        // admin finds out.
        overrideStale: isOverrideStale(saved),
        variables: originalDefault?.variables || def.variables || [],
      };
    });

    res.json({ triggers });
  } catch (error) {
    console.error('[emailPortal] getTriggers error:', error.message);
    res.status(500).json({ error: 'Failed to fetch triggers' });
  }
};

// ─── Trigger template management ────────────────────────────

const getDefaultTemplate = async (req, res) => {
  try {
    const { triggerId } = req.params;
    const originalDefault = ORIGINAL_DEFAULT_TEMPLATES[triggerId];
    if (!originalDefault) {
      return res.status(404).json({ error: 'No default template for this trigger' });
    }

    const savedTrigger = await TriggerableEmailTemplate.findOne(_globalRowFilter(triggerId)).lean();

    res.json({
      defaultTemplate: {
        triggerId,
        subject: savedTrigger?.defaultSubject || originalDefault.subject,
        html: savedTrigger?.defaultHtml || originalDefault.html,
        variables: originalDefault.variables,
        isCustomized: !!savedTrigger?.defaultHtml,
        // D2 — see isOverrideStale. `originalHtml` below is the current
        // built-in default, so the editor can offer a one-click refresh.
        overrideStale: isOverrideStale(savedTrigger),
        defaultsRevisedAt: DEFAULTS_REVISED_AT.toISOString(),
        originalSubject: originalDefault.subject,
        originalHtml: originalDefault.html,
      },
    });
  } catch (error) {
    console.error('[emailPortal] getDefaultTemplate error:', error.message);
    res.status(500).json({ error: 'Failed to fetch default template' });
  }
};

const updateDefaultTemplate = async (req, res) => {
  try {
    const { triggerId } = req.params;
    const { subject, html, reset } = req.body;

    const originalDefault = ORIGINAL_DEFAULT_TEMPLATES[triggerId];
    if (!originalDefault) {
      return res.status(404).json({ error: 'No default template for this trigger' });
    }

    const update = {};
    if (reset) {
      update.defaultSubject = null;
      update.defaultHtml = null;
    } else {
      if (subject !== undefined) update.defaultSubject = subject;
      if (html !== undefined) update.defaultHtml = html;
    }

    await TriggerableEmailTemplate.findOneAndUpdate(
      _globalRowFilter(triggerId),
      { $set: update, $setOnInsert: { triggerId, organizationId: null } },
      { upsert: true, new: true }
    );

    adminAudit.fromReq(req, { action: AUDIT.EMAIL_DEFAULT_UPDATE, targetType: 'email', targetId: triggerId, meta: { reset: !!reset } });
    res.json({
      success: true,
      message: reset ? 'Default template reset to original' : 'Default template saved',
    });
  } catch (error) {
    console.error('[emailPortal] updateDefaultTemplate error:', error.message);
    res.status(500).json({ error: 'Failed to update default template' });
  }
};

module.exports = {
  getSubscribedUsers,
  sendBulkEmails,
  sendTestEmail,
  getSendLogs,
  getPortalStats,
  getTemplates,
  saveTemplate,
  deleteTemplate,
  getTriggers,
  getDefaultTemplate,
  updateDefaultTemplate,
  applyCustomTemplate,
  // Exported for tests: template/variable contract verification
  SYSTEM_TRIGGERS,
  ORIGINAL_DEFAULT_TEMPLATES,
  // Exported for tests: the override-vs-default resolution path, which the
  // Phase 2 shell must leave untouched for pre-shell override rows.
  getTemplateForTrigger,
  wrapTemplate,
  EMAIL_WIDTH,
  ctaButton,
  FONT_STACK,
  // D2 staleness signal, shared with tenantEmailTemplateController.
  isOverrideStale,
  DEFAULTS_REVISED_AT,
};
