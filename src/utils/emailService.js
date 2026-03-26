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

/**
 * Send an email
 */
const sendEmail = async ({ to, subject, html }) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || 'SupaRank <no-reply@suparank.com>',
    to,
    subject,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
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
