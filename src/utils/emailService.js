const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Secondary transporter for sending to support@suparank.ai via privateemail SMTP
// (Brevo emails to privateemail get dropped due to SPF mismatch)
const supportTransporter =
  process.env.SUPPORT_SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SUPPORT_SMTP_HOST,
        port: parseInt(process.env.SUPPORT_SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SUPPORT_SMTP_USER,
          pass: process.env.SUPPORT_SMTP_PASS,
        },
      })
    : null;

// Verify SMTP connection at startup so misconfiguration is caught early
transporter.verify().then(() => {
  console.log('[email] SMTP connection verified');
}).catch((err) => {
  console.error('[email] SMTP connection failed:', err.message);
});

/**
 * Send an email.
 *
 * `orgId` (optional) makes the FROM identity tenant-aware (Phase 11):
 * a white-label org with a verified sender domain sends as
 * "Their Name <no-reply@their-domain>"; a custom from-name without a
 * verified domain sends as "Their Name <platform address>". Resolution is
 * fail-open — identity problems fall back to the platform default and the
 * email still goes out.
 */
const sendEmail = async ({ to, subject, html, fromName, replyTo, orgId }) => {
  const defaultFrom = process.env.EMAIL_FROM || 'SupaRank <no-reply@suparank.com>';
  let from = fromName
    ? `${fromName} <${defaultFrom.match(/<(.+)>/)?.[1] || 'no-reply@suparank.ai'}>`
    : defaultFrom;

  if (orgId) {
    // Lazy require: emailService is a util loaded at boot by many modules;
    // the identity service pulls in brand/tier services.
    const { resolveSenderIdentity } = require('../services/emailIdentityService');
    const identity = await resolveSenderIdentity(orgId);
    if (identity) from = `${identity.fromName} <${identity.fromEmail}>`;
  }

  // Use privateemail SMTP when sending to support@suparank.ai (SPF workaround)
  const useSupportTransport =
    supportTransporter && typeof to === 'string' && to.includes('support@suparank.ai');

  const mailOptions = {
    from: useSupportTransport ? `SupaRank <${process.env.SUPPORT_SMTP_USER}>` : from,
    to,
    subject,
    html,
    ...(replyTo && { replyTo }),
  };

  try {
    const transport = useSupportTransport ? supportTransporter : transporter;
    const info = await transport.sendMail(mailOptions);
    console.log(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`Failed to send email to ${to}:`, error.message);
    throw error;
  }
};

/**
 * Send verification code email
 */
const sendVerificationCodeEmail = async (email, code) => {
  return sendEmail({
    to: email,
    subject: 'Your SupaRank verification code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #111; margin-bottom: 16px;">Verify your email</h2>
        <p style="color: #555; margin-bottom: 24px;">Enter this code to verify your email address:</p>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #111;">${code}</span>
        </div>
        <p style="color: #888; font-size: 14px;">This code expires in 15 minutes.</p>
        <p style="color: #888; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
};

/**
 * Send password reset code email
 */
const sendPasswordResetCodeEmail = async (email, code) => {
  return sendEmail({
    to: email,
    subject: 'Reset your SupaRank password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #111; margin-bottom: 16px;">Reset your password</h2>
        <p style="color: #555; margin-bottom: 24px;">Enter this code to reset your password:</p>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #111;">${code}</span>
        </div>
        <p style="color: #888; font-size: 14px;">This code expires in 15 minutes.</p>
        <p style="color: #888; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
};

module.exports = { sendEmail, sendVerificationCodeEmail, sendPasswordResetCodeEmail };
