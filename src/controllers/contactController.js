const User = require('../models/User');
const { sendEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');
const { htmlEscape, headerSafe, subjectSafe } = require('../utils/htmlEscape');

const SUPPORT_EMAIL = 'support@suparank.ai';

// ─── POST /api/contact — submit contact form ────────────────

const submitContact = async (req, res) => {
  try {
    const { subject, category, message } = req.body;
    const { userId, email } = req.user;

    if (!subject || !subject.trim()) {
      return res.status(400).json({ error: 'Subject is required' });
    }
    if (subject.length > 200) {
      return res.status(400).json({ error: 'Subject must be 200 characters or less' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: 'Message must be 2000 characters or less' });
    }

    // Fetch user name for the email
    const user = await User.findById(userId).select('profile.name').lean();
    const userName = user?.profile?.name || email;

    /**
     * Escape everything user-controlled BEFORE applyCustomTemplate sees it.
     *
     * This matters more than it looks. `contact_submitted` has an entry in
     * ORIGINAL_DEFAULT_TEMPLATES, and getTemplateForTrigger falls back to it,
     * so a template ALWAYS resolves for this trigger. That means the fallback
     * markup further down is effectively dead code and the template path is
     * the only one that runs. applyCustomTemplate substitutes with a raw
     * String(value) replace, so before this any signed-in user could put
     * arbitrary HTML into the email the support team reads: a convincing
     * phishing link or a tracking pixel, in a message that appears to come
     * from our own system.
     */
    const safeCategory = category || 'General';
    const emailOptions = {
      to: SUPPORT_EMAIL,
      replyTo: headerSafe(email),
      data: {
        userName: htmlEscape(userName),
        userEmail: htmlEscape(email),
        subject: htmlEscape(subject.trim()),
        category: htmlEscape(safeCategory),
        message: htmlEscape(message.trim()),
        submittedAt: htmlEscape(new Date().toISOString()),
      },
    };

    await applyCustomTemplate('contact_submitted', emailOptions);

    // The template drops the HTML-escaped values into the Subject too, so undo
    // that here: a Subject is plain text and should read "I can't log in", not
    // "I can&#39;t log in". See subjectSafe.
    if (emailOptions.subject) emailOptions.subject = subjectSafe(emailOptions.subject);

    // Fallback if template resolution threw. In practice a template always
    // resolves for this trigger, so this is the error path only. It still uses
    // the escaped values: an error path is exactly where an injection would go
    // unnoticed. The subject takes the raw text, header-safed, because a
    // Subject is a plain-text header and should not show entities.
    if (!emailOptions.subject) {
      const d = emailOptions.data;
      emailOptions.subject = headerSafe(
        `[SupaRank Contact] ${safeCategory}: ${subject.trim()}`
      );
      emailOptions.html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#111;margin-bottom:4px;">New Contact Form Submission</h2>
  <p style="color:#6b7280;font-size:14px;margin-top:0;">SupaRank Help Center</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;width:140px;">User</td><td style="padding:8px 0;color:#111;">${d.userName}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Email</td><td style="padding:8px 0;color:#111;">${d.userEmail}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Category</td><td style="padding:8px 0;color:#111;">${d.category}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Subject</td><td style="padding:8px 0;color:#111;">${d.subject}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Message</td><td style="padding:8px 0;color:#111;white-space:pre-wrap;">${d.message}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="padding:8px 0;color:#6b7280;font-size:13px;">${d.submittedAt}</td></tr>
  </table>
</div>`;
    }

    await sendEmail(emailOptions);

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('[contact] submitContact error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

module.exports = { submitContact };
