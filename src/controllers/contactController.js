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

    // See publicContactController: the hardcoded fallback is gone because
    // resolution now degrades to the hardcoded default instead of returning
    // null. Never ship an empty shell to the support inbox.
    if (!emailOptions.subject || !emailOptions.html) {
      console.error('[contact] template resolved to nothing — not sending an empty email');
      return res.status(500).json({ error: 'Failed to send message' });
    }

    await sendEmail(emailOptions);

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('[contact] submitContact error:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

module.exports = { submitContact };
