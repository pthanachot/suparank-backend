const User = require('../models/User');
const { sendEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');

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

    const emailOptions = {
      to: SUPPORT_EMAIL,
      replyTo: email,
      data: {
        userName,
        userEmail: email,
        subject: subject.trim(),
        category: category || 'General',
        message: message.trim(),
        submittedAt: new Date().toISOString(),
      },
    };

    await applyCustomTemplate('contact_submitted', emailOptions);

    // Fallback if template resolution didn't populate subject/html
    if (!emailOptions.subject) {
      emailOptions.subject = `[SupaRank Contact] ${category || 'General'} — ${subject.trim()}`;
      emailOptions.html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#111;margin-bottom:4px;">New Contact Form Submission</h2>
  <p style="color:#6b7280;font-size:14px;margin-top:0;">SupaRank Help Center</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;width:140px;">User</td><td style="padding:8px 0;color:#111;">${userName}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Email</td><td style="padding:8px 0;color:#111;">${email}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Category</td><td style="padding:8px 0;color:#111;">${category || 'General'}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Subject</td><td style="padding:8px 0;color:#111;">${subject.trim()}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Message</td><td style="padding:8px 0;color:#111;white-space:pre-wrap;">${message.trim()}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="padding:8px 0;color:#6b7280;font-size:13px;">${new Date().toISOString()}</td></tr>
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
