/**
 * Public (unauthenticated) contact form.
 *
 * The authenticated twin lives in contactController.js and reads the sender
 * from req.user. That path cannot serve prospects: /api/contact is gated by
 * authenticateToken at the router level, so a logged-out visitor filling in the
 * form on the marketing site got a 401. This controller is the public path, so
 * the sender's email arrives in the body and is validated here.
 *
 * Being unauthenticated and sending mail makes this an abuse target. The
 * posture mirrors publicToolsGuard: honeypot, strict validation, per-IP daily
 * cap. Two additions matter specifically here:
 *
 *   - Every value interpolated into the notification email is HTML-escaped.
 *     The authenticated controller does not do this, which is tolerable when
 *     the sender is a known user but not when anyone on the internet can post.
 *   - The reply-to address is the visitor's, so it is validated and length-
 *     capped before it reaches a mail header.
 */
const { sendEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');
const publicToolsService = require('../services/publicToolsService');
const { htmlEscape, headerSafe, subjectSafe } = require('../utils/htmlEscape');

const SUPPORT_EMAIL = 'support@suparank.ai';
const MAX_PER_DAY = 5;
const RATE_LIMIT_ID = 'public-contact';

// Deliberately simple. Real validation is the reply landing, not a regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CATEGORIES = ['General', 'Sales', 'Bug Report', 'Feature Request', 'Billing', 'Account'];

// ─── POST /api/public/contact ───────────────────────────────

const submitPublicContact = async (req, res) => {
  try {
    // 1. Honeypot. Real people never fill a hidden field; respond generically
    //    so a bot learns nothing about why it failed.
    if (typeof req.body?._hp === 'string' && req.body._hp.length > 0) {
      return res.status(400).json({ error: 'invalid request' });
    }

    const { name, email, subject, category, message } = req.body || {};

    if (!email || !EMAIL_RE.test(String(email).trim()) || String(email).length > 200) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ error: 'Subject is required' });
    }
    if (String(subject).length > 200) {
      return res.status(400).json({ error: 'Subject must be 200 characters or less' });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (String(message).length > 2000) {
      return res.status(400).json({ error: 'Message must be 2000 characters or less' });
    }
    if (name && String(name).length > 120) {
      return res.status(400).json({ error: 'Name must be 120 characters or less' });
    }

    // 2. Per-IP daily cap, only after validation so malformed posts cannot
    //    burn a real visitor's allowance from a shared NAT address.
    //
    //    FAIL OPEN. consumeRateLimit needs Mongo; sending the email does not.
    //    Letting a database hiccup propagate would turn a spam control into an
    //    outage of the only way a prospect can reach us, and they would have no
    //    way to report that it is broken. The honeypot and the CORS origin
    //    restriction still apply, so the downside of failing open is some spam
    //    in the support inbox. That is strictly better than silence.
    let allowed = true;
    try {
      ({ allowed } = await publicToolsService.consumeRateLimit(
        req.ip,
        RATE_LIMIT_ID,
        MAX_PER_DAY
      ));
    } catch (rateErr) {
      console.error('[public-contact] rate limit unavailable, allowing send:', rateErr.message);
    }
    if (!allowed) {
      return res.status(429).json({
        error: "You've sent several messages today. Please reply to our email instead, or try again tomorrow.",
      });
    }

    const safeEmail = headerSafe(String(email).trim());
    const safeSubject = String(subject).trim();
    const safeName = name ? String(name).trim() : safeEmail;
    const safeCategory = CATEGORIES.includes(category) ? category : 'General';
    const safeMessage = String(message).trim();
    const submittedAt = new Date().toISOString();

    /**
     * ESCAPE AT THE SOURCE, not just in the fallback below.
     *
     * applyCustomTemplate substitutes `data` into an admin-defined template
     * with a raw `String(value)` replace and no escaping of its own. If a
     * `contact_submitted` template is ever created in the email portal, it
     * silently takes over from the fallback markup here. Escaping only inside
     * the fallback would mean an admin adding a template quietly reintroduces
     * HTML injection from an unauthenticated endpoint into the support inbox.
     *
     * Trade-off: these values also feed the template's SUBJECT line, which is
     * plain text, so a subject containing < or & shows an entity. That is a
     * cosmetic wart on an internal email and is the right side of this trade.
     */
    const emailOptions = {
      to: SUPPORT_EMAIL,
      replyTo: safeEmail,
      data: {
        userName: htmlEscape(safeName),
        userEmail: htmlEscape(safeEmail),
        subject: htmlEscape(safeSubject),
        category: htmlEscape(safeCategory),
        message: htmlEscape(safeMessage),
        submittedAt: htmlEscape(submittedAt),
        source: 'public',
      },
    };
    const d = emailOptions.data;

    await applyCustomTemplate('contact_submitted', emailOptions);

    // Undo entity escaping in the Subject only: it is plain text, and support
    // should not read "I can&#39;t log in". See subjectSafe.
    if (emailOptions.subject) emailOptions.subject = subjectSafe(emailOptions.subject);

    if (!emailOptions.subject) {
      // Subject is a header, so it takes the raw (header-safe) subject rather
      // than the HTML-escaped one: no entities in the support inbox.
      emailOptions.subject = headerSafe(
        `[SupaRank Contact] ${safeCategory}: ${safeSubject}`
      );
      emailOptions.html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#111;margin-bottom:4px;">New Contact Form Submission</h2>
  <p style="color:#6b7280;font-size:14px;margin-top:0;">Sent from the public contact page (visitor was not signed in)</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;width:140px;">Name</td><td style="padding:8px 0;color:#111;">${d.userName}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Email</td><td style="padding:8px 0;color:#111;">${d.userEmail}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Category</td><td style="padding:8px 0;color:#111;">${d.category}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Subject</td><td style="padding:8px 0;color:#111;">${d.subject}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Message</td><td style="padding:8px 0;color:#111;white-space:pre-wrap;">${d.message}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="padding:8px 0;color:#6b7280;font-size:13px;">${d.submittedAt}</td></tr>
  </table>
</div>`;
    }

    await sendEmail(emailOptions);

    return res.status(201).json({ success: true });
  } catch (error) {
    console.error('[public-contact] submitPublicContact error:', error.message);
    return res.status(500).json({ error: 'Failed to send message' });
  }
};

// CATEGORIES is exported because it is a contract with the frontend form in
// app/contact/ContactForm.tsx, which lives in a different repo and keeps its
// own copy. The escaping helpers now live in utils/htmlEscape.js.
module.exports = { submitPublicContact, CATEGORIES };
