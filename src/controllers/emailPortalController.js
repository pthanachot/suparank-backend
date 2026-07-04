/**
 * Email portal controller — admin email management for SupaRank.
 */

const User = require('../models/User');
const EmailTemplate = require('../models/EmailTemplate');
const EmailSendLog = require('../models/EmailSendLog');
const TriggerableEmailTemplate = require('../models/TriggerableEmailTemplate');
const { sendEmail } = require('../utils/emailService');
// Called via module property (not destructured) so tests can stub them.
const flagService = require('../services/flagService');
const brandService = require('../services/brandService');

// ─── System email triggers (SupaRank-specific) ─────────────

const SYSTEM_TRIGGERS = [
  // Auth
  {
    id: 'welcome',
    name: 'Welcome Email',
    description: 'Sent when a new user signs up',
    category: 'auth',
    variables: ['userName', 'loginUrl', 'brandName', 'supportEmail'],
    triggerCount: 0,
  },
  {
    id: 'verify_email',
    name: 'Email Verification',
    description: 'Verification code sent during signup',
    category: 'auth',
    variables: ['code', 'expiresIn', 'brandName'],
    triggerCount: 0,
  },
  {
    id: 'verify_email_link',
    name: 'Email Verification Link',
    description: 'Link-based email verification (signup, resend, email change)',
    category: 'auth',
    variables: ['userName', 'verifyUrl', 'brandName'],
    triggerCount: 0,
  },
  {
    id: 'password_reset',
    name: 'Password Reset',
    description: 'Password reset code',
    category: 'auth',
    variables: ['code', 'expiresIn', 'brandName'],
    triggerCount: 0,
  },
  {
    id: 'member_invite',
    name: 'Member Invitation',
    description: 'Sent when someone is invited to join an organization',
    category: 'auth',
    variables: ['inviterName', 'orgName', 'role', 'acceptUrl', 'brandName'],
    triggerCount: 0,
  },
  // Billing
  {
    id: 'payment_confirmation',
    name: 'Payment Confirmation',
    description: 'Sent after successful payment',
    category: 'billing',
    variables: ['userName', 'planName', 'amount', 'nextBillingDate', 'brandName'],
    triggerCount: 0,
  },
  {
    id: 'subscription_canceled',
    name: 'Subscription Canceled',
    description: 'Confirmation of subscription cancellation',
    category: 'billing',
    variables: ['userName', 'planName', 'endDate', 'brandName'],
    triggerCount: 0,
  },
  {
    id: 'payment_failed',
    name: 'Payment Failed',
    description: 'Notification of failed payment',
    category: 'billing',
    variables: ['userName', 'planName', 'retryDate', 'updatePaymentUrl', 'brandName'],
    triggerCount: 0,
  },
  {
    id: 'credits_low',
    name: 'Credits Running Low',
    description: 'Notification when credits are below threshold',
    category: 'billing',
    variables: ['userName', 'remainingCredits', 'planName', 'brandName'],
    triggerCount: 0,
  },
  // Feedback
  {
    id: 'feedback_submitted',
    name: 'Feedback Submitted',
    description: 'Sent to support@suparank.ai when a user submits in-app feedback',
    category: 'engagement',
    variables: ['feature', 'rating', 'stars', 'comment', 'userEmail', 'submittedAt', 'brandName'],
    triggerCount: 0,
  },
  // Support
  {
    id: 'contact_submitted',
    name: 'Contact Form Submitted',
    description: 'Sent to support when a user submits the contact form',
    category: 'support',
    variables: ['userName', 'userEmail', 'subject', 'category', 'message', 'submittedAt', 'brandName'],
    triggerCount: 0,
  },
  // Reports
  {
    id: 'monthly_report',
    name: 'Monthly Workspace Report',
    description: "Sent on the 1st of each month with a link to the previous month's workspace report",
    category: 'reports',
    variables: ['workspaceName', 'period', 'reportUrl', 'brandName'],
    triggerCount: 0,
  },
  // AI Tracker
  {
    id: 'scan_completed',
    name: 'AI Scan Completed',
    description: 'Sent to the workspace owner when an AI Tracker scan finishes',
    category: 'ai-tracker',
    variables: ['userName', 'trackerName', 'domain', 'scanDate', 'promptsScanned', 'visibility', 'mentionRate', 'shareOfVoice', 'citationRate', 'avgSentiment', 'platformRows', 'promptRows', 'competitorRows', 'actionRows', 'dashboardUrl', 'brandName'],
    triggerCount: 0,
  },
];

// ─── Original default templates (hardcoded, used as fallback) ─

const ORIGINAL_DEFAULT_TEMPLATES = {
  welcome: {
    subject: 'Welcome to {{brandName}}!',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#111;font-size:24px;margin-bottom:16px;">Welcome to {{brandName}}!</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">We're excited to have you on board. {{brandName}} helps you track your AI visibility, optimize your brand voice, and stay ahead of the competition.</p>
  <div style="text-align:center;margin:32px 0;">
    <a href="{{loginUrl}}" style="background:#111;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Get Started</a>
  </div>
  <p style="color:#888;font-size:14px;">If you have any questions, feel free to reach out to our support team at {{supportEmail}}.</p>
</div>`,
    variables: ['userName', 'loginUrl', 'brandName', 'supportEmail'],
  },
  verify_email: {
    subject: '{{brandName}} — Verify your email',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:16px;">Verify your email</h2>
  <p style="color:#555;margin-bottom:24px;">Enter this code to verify your email address:</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
    <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#111;">{{code}}</span>
  </div>
  <p style="color:#888;font-size:14px;">This code expires in {{expiresIn}}.</p>
  <p style="color:#888;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    variables: ['code', 'expiresIn', 'brandName'],
  },
  verify_email_link: {
    subject: '{{brandName}} — Verify your email',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:16px;">Verify your email</h2>
  <p style="color:#555;margin-bottom:24px;">Hi {{userName}}, click the button below to verify your email address:</p>
  <a href="{{verifyUrl}}" style="display:inline-block;padding:14px 32px;background:#4F46E5;color:white;text-decoration:none;border-radius:12px;font-weight:bold;font-size:14px;">Verify Email</a>
  <p style="color:#888;font-size:14px;margin-top:24px;">This link expires in 24 hours.</p>
  <p style="color:#888;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    variables: ['userName', 'verifyUrl', 'brandName'],
  },
  password_reset: {
    subject: '{{brandName}} — Reset your password',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:16px;">Reset your password</h2>
  <p style="color:#555;margin-bottom:24px;">Enter this code to reset your password:</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
    <span style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#111;">{{code}}</span>
  </div>
  <p style="color:#888;font-size:14px;">This code expires in {{expiresIn}}.</p>
  <p style="color:#888;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
</div>`,
    variables: ['code', 'expiresIn', 'brandName'],
  },
  member_invite: {
    subject: "You've been invited to join {{orgName}}",
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:16px;">You're invited</h2>
  <p style="color:#555;font-size:16px;line-height:1.6;">{{inviterName}} has invited you to join <strong>{{orgName}}</strong> as {{role}}.</p>
  <div style="text-align:center;margin:32px 0;">
    <a href="{{acceptUrl}}" style="background:#111;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Accept invitation</a>
  </div>
  <p style="color:#888;font-size:14px;">This invitation expires in 7 days.</p>
  <p style="color:#888;font-size:14px;">If you weren't expecting this, you can safely ignore this email.</p>
</div>`,
    variables: ['inviterName', 'orgName', 'role', 'acceptUrl', 'brandName'],
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
    variables: ['userName', 'planName', 'amount', 'nextBillingDate', 'brandName'],
  },
  subscription_canceled: {
    subject: 'Subscription Canceled - {{brandName}}',
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
    variables: ['userName', 'planName', 'endDate', 'brandName'],
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
    variables: ['userName', 'planName', 'retryDate', 'updatePaymentUrl', 'brandName'],
  },
  credits_low: {
    subject: 'Credits Running Low - {{brandName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#f59e0b;font-size:24px;margin-bottom:16px;">Credits Running Low</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">Hi {{userName}},</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">You have <strong>{{remainingCredits}}</strong> credits remaining on your <strong>{{planName}}</strong> plan.</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">Consider upgrading your plan to get more credits and continue using all features without interruption.</p>
</div>`,
    variables: ['userName', 'remainingCredits', 'planName', 'brandName'],
  },
  feedback_submitted: {
    subject: '[{{brandName}} Feedback] {{stars}} — {{feature}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#111;margin-bottom:4px;">New Feedback Received</h2>
  <p style="color:#6b7280;font-size:14px;margin-top:0;">{{brandName}} In-App Feedback</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;width:140px;">Feature</td><td style="padding:8px 0;color:#111;">{{feature}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Rating</td><td style="padding:8px 0;color:#FFA163;font-size:20px;">{{stars}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">User</td><td style="padding:8px 0;color:#111;">{{userEmail}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Comment</td><td style="padding:8px 0;color:#111;">{{comment}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="padding:8px 0;color:#6b7280;font-size:13px;">{{submittedAt}}</td></tr>
  </table>
</div>`,
    variables: ['feature', 'rating', 'stars', 'comment', 'userEmail', 'submittedAt', 'brandName'],
  },
  contact_submitted: {
    subject: '[{{brandName}} Contact] {{category}} — {{subject}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;border:1px solid #e5e7eb;border-radius:8px;">
  <h2 style="color:#111;margin-bottom:4px;">New Contact Form Submission</h2>
  <p style="color:#6b7280;font-size:14px;margin-top:0;">{{brandName}} Help Center</p>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;width:140px;">User</td><td style="padding:8px 0;color:#111;">{{userName}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Email</td><td style="padding:8px 0;color:#111;">{{userEmail}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Category</td><td style="padding:8px 0;color:#111;">{{category}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Subject</td><td style="padding:8px 0;color:#111;">{{subject}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Message</td><td style="padding:8px 0;color:#111;white-space:pre-wrap;">{{message}}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Submitted</td><td style="padding:8px 0;color:#6b7280;font-size:13px;">{{submittedAt}}</td></tr>
  </table>
</div>`,
    variables: ['userName', 'userEmail', 'subject', 'category', 'message', 'submittedAt', 'brandName'],
  },
  monthly_report: {
    subject: 'Your {{period}} report for {{workspaceName}} is ready',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h1 style="color:#111;font-size:24px;margin-bottom:16px;">Your monthly report is ready</h1>
  <p style="color:#555;font-size:16px;line-height:1.6;">The <strong>{{period}}</strong> performance report for <strong>{{workspaceName}}</strong> has been generated.</p>
  <p style="color:#555;font-size:16px;line-height:1.6;">It covers content production, on-page scores, AI visibility and search performance for the month.</p>
  <div style="text-align:center;margin:32px 0;">
    <a href="{{reportUrl}}" style="background:#111;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">View Report</a>
  </div>
  <p style="color:#888;font-size:14px;">This link expires in 90 days. You're receiving this because you're part of this workspace on {{brandName}}.</p>
</div>`,
    variables: ['workspaceName', 'period', 'reportUrl', 'brandName'],
  },
  scan_completed: {
    subject: 'AI Scan Complete – {{trackerName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;color:#111;">

  <!-- Header -->
  <h1 style="font-size:20px;font-weight:700;margin:0 0 6px 0;">AI Tracker Scan Complete</h1>
  <p style="color:#64748b;font-size:14px;margin:0 0 24px 0;">Hi {{userName}} &mdash; <strong>{{domain}}</strong> was scanned on {{scanDate}}.</p>

  <!-- Key Metrics -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#4f46e5;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #4f46e5;">Key Metrics</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
    <tr>
      <td style="padding:14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
        <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Visibility</div>
        <div style="font-size:22px;font-weight:700;">{{visibility}}</div>
      </td>
      <td style="padding:14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
        <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Mention Rate</div>
        <div style="font-size:22px;font-weight:700;">{{mentionRate}}%</div>
      </td>
      <td style="padding:14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
        <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Share of Voice</div>
        <div style="font-size:22px;font-weight:700;">{{shareOfVoice}}%</div>
      </td>
      <td style="padding:14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
        <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Citation Rate</div>
        <div style="font-size:22px;font-weight:700;">{{citationRate}}%</div>
      </td>
      <td style="padding:14px;text-align:center;background:#f8fafc;">
        <div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Sentiment</div>
        <div style="font-size:14px;font-weight:600;">{{avgSentiment}}</div>
      </td>
    </tr>
  </table>

  <!-- Platform Breakdown -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #e2e8f0;">Platform Breakdown</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;margin-bottom:24px;">
    <thead>
      <tr style="background:#f8fafc;">
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Platform</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Visibility</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Mentions</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Citations</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;"></th>
      </tr>
    </thead>
    <tbody>{{platformRows}}</tbody>
  </table>

  <!-- Tracked Prompts -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #e2e8f0;">Tracked Prompts ({{promptsScanned}})</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;margin-bottom:24px;">
    <thead>
      <tr style="background:#f8fafc;">
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Status</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">#</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Prompt</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Platforms</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Mention</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Citation</th>
      </tr>
    </thead>
    <tbody>{{promptRows}}</tbody>
  </table>

  <!-- Competitors -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #e2e8f0;">Top Competitors</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;margin-bottom:24px;">
    <thead>
      <tr style="background:#f8fafc;">
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">#</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Brand</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Mentions</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Citations</th>
        <th style="padding:8px 14px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;">Visibility</th>
      </tr>
    </thead>
    <tbody>{{competitorRows}}</tbody>
  </table>

  <!-- Recommended Actions -->
  <h2 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#374151;margin:0 0 8px 0;padding-bottom:6px;border-bottom:2px solid #e2e8f0;">Recommended Actions</h2>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;margin-bottom:28px;">
    <tbody>{{actionRows}}</tbody>
  </table>

  <!-- CTA -->
  <div style="text-align:center;margin-bottom:24px;">
    <a href="{{dashboardUrl}}" style="background:#4f46e5;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">View Full Dashboard</a>
  </div>
  <p style="color:#94a3b8;font-size:11px;text-align:center;margin:0;">You&rsquo;re receiving this because email notifications are enabled on your {{brandName}} account.</p>
</div>`,
    variables: ['userName', 'trackerName', 'domain', 'scanDate', 'promptsScanned', 'visibility', 'mentionRate', 'shareOfVoice', 'citationRate', 'avgSentiment', 'platformRows', 'promptRows', 'competitorRows', 'actionRows', 'dashboardUrl', 'brandName'],
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
 */
const getTemplateForTrigger = async (triggerId, organizationId = null) => {
  try {
    const originalDefault = ORIGINAL_DEFAULT_TEMPLATES[triggerId];
    if (!originalDefault) {
      console.warn(`[triggers] No original template for triggerId=${triggerId}`);
      return null;
    }

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
    console.error(`[triggers] getTemplateForTrigger error for ${triggerId}:`, error.message);
    return null;
  }
};

/**
 * Resolve a trigger template and apply {{variable}} substitution.
 * Mutates emailOptions in place — sets .subject and .html, removes .data.
 * `brandName` / `supportEmail` are auto-injected into data (resolved brand
 * of `organizationId`, or the platform brand) unless the caller set them.
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
      if (emailOptions.data.brandName === undefined || emailOptions.data.supportEmail === undefined) {
        let brandName = 'SupaRank';
        let supportEmail = 'support@suparank.ai';
        try {
          const brand = organizationId
            ? (await brandService.getBrandForOrg(organizationId)).brand
            : await brandService.getPlatformBrand();
          if (brand?.productName) brandName = brand.productName;
          if (brand?.supportEmail) supportEmail = brand.supportEmail;
        } catch (err) {
          console.error(`[triggers] brand lookup failed for ${triggerId}:`, err.message);
        }
        if (emailOptions.data.brandName === undefined) emailOptions.data.brandName = brandName;
        if (emailOptions.data.supportEmail === undefined) emailOptions.data.supportEmail = supportEmail;
      }

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
};
