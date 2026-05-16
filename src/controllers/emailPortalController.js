/**
 * Email portal controller — admin email management for SupaRank.
 */

const User = require('../models/User');
const EmailTemplate = require('../models/EmailTemplate');
const EmailSendLog = require('../models/EmailSendLog');
const TriggerableEmailTemplate = require('../models/TriggerableEmailTemplate');
const { sendEmail } = require('../utils/emailService');

// ─── System email triggers (SupaRank-specific) ─────────────

const SYSTEM_TRIGGERS = [
  // Auth
  {
    id: 'welcome',
    name: 'Welcome Email',
    description: 'Sent when a new user signs up',
    category: 'auth',
    variables: ['userName', 'loginUrl'],
    triggerCount: 0,
  },
  {
    id: 'verify_email',
    name: 'Email Verification',
    description: 'Verification code sent during signup',
    category: 'auth',
    variables: ['code', 'expiresIn'],
    triggerCount: 0,
  },
  {
    id: 'password_reset',
    name: 'Password Reset',
    description: 'Password reset code',
    category: 'auth',
    variables: ['code', 'expiresIn'],
    triggerCount: 0,
  },
  // Engagement
  {
    id: 'feature_announcement',
    name: 'Feature Announcement',
    description: 'Announce new features to users',
    category: 'engagement',
    variables: ['userName', 'featureName', 'featureDescription', 'ctaUrl'],
    triggerCount: 0,
  },
  {
    id: 'usage_tips',
    name: 'Usage Tips',
    description: 'Tips for getting more from SupaRank',
    category: 'engagement',
    variables: ['userName', 'tipTitle', 'tipContent'],
    triggerCount: 0,
  },
  // Billing
  {
    id: 'payment_confirmation',
    name: 'Payment Confirmation',
    description: 'Sent after successful payment',
    category: 'billing',
    variables: ['userName', 'planName', 'amount', 'nextBillingDate'],
    triggerCount: 0,
  },
  {
    id: 'subscription_canceled',
    name: 'Subscription Canceled',
    description: 'Confirmation of subscription cancellation',
    category: 'billing',
    variables: ['userName', 'planName', 'endDate'],
    triggerCount: 0,
  },
  {
    id: 'payment_failed',
    name: 'Payment Failed',
    description: 'Notification of failed payment',
    category: 'billing',
    variables: ['userName', 'planName', 'retryDate', 'updatePaymentUrl'],
    triggerCount: 0,
  },
  {
    id: 'credits_low',
    name: 'Credits Running Low',
    description: 'Notification when credits are below threshold',
    category: 'billing',
    variables: ['userName', 'remainingCredits', 'planName'],
    triggerCount: 0,
  },
  // Feedback
  {
    id: 'feedback_submitted',
    name: 'Feedback Submitted',
    description: 'Sent to support@suparank.ai when a user submits in-app feedback',
    category: 'engagement',
    variables: ['feature', 'rating', 'stars', 'comment', 'userEmail', 'submittedAt'],
    triggerCount: 0,
  },
];

// ─── Original default templates (hardcoded, used as fallback) ─

const ORIGINAL_DEFAULT_TEMPLATES = {
  welcome: {
    subject: 'Welcome to SupaRank!',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#111;font-size:24px;margin-bottom:16px;">Welcome to SupaRank!</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">We're excited to have you on board. SupaRank helps you track your AI visibility, optimize your brand voice, and stay ahead of the competition.</p>
  <div style="text-align:center;margin:32px 0;">
    <a href="{{loginUrl}}" style="background:#111;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Get Started</a>
  </div>
  <p style="color:#888;font-size:14px;">If you have any questions, feel free to reach out to our support team.</p>
</div>`,
    variables: ['userName', 'loginUrl'],
  },
  verify_email: {
    subject: 'SupaRank - Verify Your Email',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:16px;">Verify your email</h2>
  <p style="color:#555;margin-bottom:24px;">Enter this code to verify your email address:</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
    <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#111;">{{code}}</span>
  </div>
  <p style="color:#888;font-size:14px;">This code expires in {{expiresIn}}.</p>
  <p style="color:#888;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    variables: ['code', 'expiresIn'],
  },
  password_reset: {
    subject: 'SupaRank - Reset Your Password',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:16px;">Reset your password</h2>
  <p style="color:#555;margin-bottom:24px;">Enter this code to reset your password:</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
    <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#111;">{{code}}</span>
  </div>
  <p style="color:#888;font-size:14px;">This code expires in {{expiresIn}}.</p>
  <p style="color:#888;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    variables: ['code', 'expiresIn'],
  },
  feature_announcement: {
    subject: 'New Feature: {{featureName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#111;font-size:24px;margin-bottom:16px;">New Feature Available!</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">We've just launched <strong>{{featureName}}</strong>!</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">{{featureDescription}}</p>
  <div style="text-align:center;margin:32px 0;">
    <a href="{{ctaUrl}}" style="background:#111;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Try It Now</a>
  </div>
</div>`,
    variables: ['userName', 'featureName', 'featureDescription', 'ctaUrl'],
  },
  usage_tips: {
    subject: 'SupaRank Tip: {{tipTitle}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#111;font-size:24px;margin-bottom:16px;">{{tipTitle}}</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <div style="color:#555;font-size:16px;line-height:1.6;">{{tipContent}}</div>
</div>`,
    variables: ['userName', 'tipTitle', 'tipContent'],
  },
  payment_confirmation: {
    subject: 'Payment Confirmed - {{planName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#111;font-size:24px;margin-bottom:16px;">Payment Confirmed</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">Your payment of <strong>{{amount}}</strong> for <strong>{{planName}}</strong> has been processed successfully.</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:24px 0;">
    <p style="color:#555;margin:4px 0;"><strong>Plan:</strong> {{planName}}</p>
    <p style="color:#555;margin:4px 0;"><strong>Next billing date:</strong> {{nextBillingDate}}</p>
  </div>
  <p style="color:#888;font-size:14px;">Thank you for your continued support!</p>
</div>`,
    variables: ['userName', 'planName', 'amount', 'nextBillingDate'],
  },
  subscription_canceled: {
    subject: 'Subscription Canceled - SupaRank',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#111;font-size:24px;margin-bottom:16px;">Subscription Canceled</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">Your <strong>{{planName}}</strong> subscription has been canceled.</p>
  <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin:24px 0;">
    <p style="color:#92400e;margin:0;">Your access continues until <strong>{{endDate}}</strong>. After that, your account will revert to the free plan.</p>
  </div>
  <p style="color:#555;font-size:16px;line-height:1.6;">If you change your mind, you can re-subscribe at any time from your billing settings.</p>
  <p style="color:#888;font-size:14px;">We hope to see you back soon!</p>
</div>`,
    variables: ['userName', 'planName', 'endDate'],
  },
  payment_failed: {
    subject: 'Payment Failed - Action Required',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#dc2626;font-size:24px;margin-bottom:16px;">Payment Failed</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">We were unable to process your payment for <strong>{{planName}}</strong>.</p>
  <div style="background:#fef2f2;border:1px solid #ef4444;border-radius:8px;padding:16px;margin:24px 0;">
    <p style="color:#991b1b;margin:0;">We'll retry your payment on <strong>{{retryDate}}</strong>. Please update your payment method to avoid interruption.</p>
  </div>
  <div style="text-align:center;margin:32px 0;">
    <a href="{{updatePaymentUrl}}" style="background:#dc2626;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Update Payment Method</a>
  </div>
</div>`,
    variables: ['userName', 'planName', 'retryDate', 'updatePaymentUrl'],
  },
  credits_low: {
    subject: 'Credits Running Low - SupaRank',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#f59e0b;font-size:24px;margin-bottom:16px;">Credits Running Low</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">You have <strong>{{remainingCredits}}</strong> credits remaining on your <strong>{{planName}}</strong> plan.</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">Consider upgrading your plan to get more credits and continue using all features without interruption.</p>
</div>`,
    variables: ['userName', 'remainingCredits', 'planName'],
  },
  feedback_submitted: {
    subject: '[SupaRank Feedback] {{stars}} — {{feature}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#111;margin-bottom:4px;">New Feedback Received</h2>
  <p style="color:#6b7280;font-size:14px;margin-top:0;">SupaRank In-App Feedback</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;width:140px;">Feature</td><td style="padding:8px 0;color:#111;">{{feature}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Rating</td><td style="padding:8px 0;color:#FFA163;font-size:20px;">{{stars}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">User</td><td style="padding:8px 0;color:#111;">{{userEmail}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Comment</td><td style="padding:8px 0;color:#111;">{{comment}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="padding:8px 0;color:#6b7280;font-size:13px;">{{submittedAt}}</td></tr>
  </table>
</div>`,
    variables: ['feature', 'rating', 'stars', 'comment', 'userEmail', 'submittedAt'],
  },
};

// ─── Template resolution helpers ────────────────────────────

/**
 * Resolve the template for a trigger (DB override > hardcoded original).
 * Also increments trigger stats (triggerCount, lastTriggered).
 */
const getTemplateForTrigger = async (triggerId) => {
  try {
    const originalDefault = ORIGINAL_DEFAULT_TEMPLATES[triggerId];
    if (!originalDefault) {
      console.warn(`[triggers] No original template for triggerId=${triggerId}`);
      return null;
    }

    const saved = await TriggerableEmailTemplate.findOne({ triggerId }).lean();

    // Increment stats
    await TriggerableEmailTemplate.findOneAndUpdate(
      { triggerId },
      {
        $inc: { triggerCount: 1 },
        $set: { lastTriggered: new Date() },
        $setOnInsert: { triggerId },
      },
      { upsert: true }
    );

    return {
      subject: saved?.defaultSubject || originalDefault.subject,
      html: saved?.defaultHtml || originalDefault.html,
    };
  } catch (error) {
    console.error(`[triggers] getTemplateForTrigger error for ${triggerId}:`, error.message);
    return null;
  }
};

/**
 * Resolve a trigger template and apply {{variable}} substitution.
 * Mutates emailOptions in place — sets .subject and .html, removes .data.
 *
 * Usage:
 *   const emailOptions = { to: user.email, data: { userName: 'John', planName: 'Pro' } };
 *   await applyCustomTemplate('subscription_canceled', emailOptions);
 *   await sendEmail(emailOptions);
 */
const applyCustomTemplate = async (triggerId, emailOptions) => {
  try {
    const template = await getTemplateForTrigger(triggerId);
    if (template && emailOptions.data) {
      emailOptions.subject = Object.entries(emailOptions.data).reduce(
        (subj, [key, value]) =>
          subj.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? '')),
        template.subject
      );
      emailOptions.html = Object.entries(emailOptions.data).reduce(
        (html, [key, value]) =>
          html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? '')),
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
    const users = await User.find({ status: 'active' })
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

    res.status(201).json({ template });
  } catch (error) {
    console.error('[emailPortal] saveTemplate error:', error.message);
    res.status(500).json({ error: 'Failed to save template' });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    await EmailTemplate.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('[emailPortal] deleteTemplate error:', error.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
};

// ─── Triggers ───────────────────────────────────────────────

const getTriggers = async (req, res) => {
  try {
    const savedTriggers = await TriggerableEmailTemplate.find().lean();
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

    const savedTrigger = await TriggerableEmailTemplate.findOne({ triggerId }).lean();

    res.json({
      defaultTemplate: {
        triggerId,
        subject: savedTrigger?.defaultSubject || originalDefault.subject,
        html: savedTrigger?.defaultHtml || originalDefault.html,
        variables: originalDefault.variables,
        isCustomized: !!savedTrigger?.defaultHtml,
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
      { triggerId },
      { $set: update, $setOnInsert: { triggerId } },
      { upsert: true, new: true }
    );

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
};
