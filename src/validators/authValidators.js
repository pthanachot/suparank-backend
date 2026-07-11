/**
 * Zod schemas for the auth endpoints (Phase 20 input-validation rollout).
 *
 * Every schema uses `.passthrough()`: it validates the fields the handler reads
 * (type + required + length caps) but never strips unknown keys, so it cannot
 * accidentally drop a field a controller depends on. Operator-injection keys are
 * already removed upstream by the global mongoSanitize middleware, so passthrough
 * is safe here.
 *
 * These deliberately enforce TYPE + REQUIRED + MAX-LENGTH only (no new format or
 * min-length rules) so they reject malformed/oversized/injection-shaped input
 * (e.g. `email` arriving as an object or array) without changing which valid
 * string inputs the controllers already accept.
 */
const { z } = require('zod');

const email = z
  .string({ required_error: 'email is required', invalid_type_error: 'email must be a string' })
  .min(1, 'email is required')
  .max(320, 'email too long');

const password = z
  .string({ required_error: 'password is required', invalid_type_error: 'password must be a string' })
  .min(1, 'password is required')
  .max(200, 'password too long');

const optToken = z.string().max(1000).optional();

// POST /email-signup — { name, email, password, verificationCode?, inviteToken? }
const emailSignupSchema = z
  .object({
    // Optional: the handler falls back to the email local-part when name is absent
    // (authController emailSignup: `name || email.split('@')[0]`).
    name: z.string({ invalid_type_error: 'name must be a string' }).max(200, 'name too long').optional(),
    email,
    password,
    verificationCode: z.string().max(20).optional(),
    inviteToken: optToken,
  })
  .passthrough();

// POST /email-login — { email, password }
const emailLoginSchema = z.object({ email, password }).passthrough();

// POST /google-auth — { credential, inviteToken? }
const googleAuthSchema = z
  .object({
    credential: z.string({ required_error: 'credential is required', invalid_type_error: 'credential must be a string' }).min(1, 'credential is required').max(5000, 'credential too long'),
    inviteToken: optToken,
  })
  .passthrough();

// POST /refresh-token — { refreshToken }
const refreshTokenSchema = z
  .object({ refreshToken: z.string({ required_error: 'refreshToken is required', invalid_type_error: 'refreshToken must be a string' }).min(1).max(2000) })
  .passthrough();

// POST /verify-email and /reset-password share a token; reset also carries password.
const verifyEmailSchema = z
  .object({ token: z.string({ required_error: 'token is required', invalid_type_error: 'token must be a string' }).min(1).max(500) })
  .passthrough();

const resetPasswordSchema = z
  .object({ token: z.string({ required_error: 'token is required', invalid_type_error: 'token must be a string' }).min(1).max(500), password })
  .passthrough();

// Email-only endpoints — /resend-verification, /forgot-password
const emailOnlySchema = z.object({ email }).passthrough();

// POST /send-verification-code — { email, purpose? }
const sendVerificationCodeSchema = z.object({ email, purpose: z.string().max(50).optional() }).passthrough();

// POST /verify-reset-code — { email, code }
const verifyResetCodeSchema = z
  .object({ email, code: z.string({ required_error: 'code is required', invalid_type_error: 'code must be a string' }).min(1).max(20) })
  .passthrough();

module.exports = {
  emailSignupSchema,
  emailLoginSchema,
  googleAuthSchema,
  refreshTokenSchema,
  verifyEmailSchema,
  resetPasswordSchema,
  emailOnlySchema,
  sendVerificationCodeSchema,
  verifyResetCodeSchema,
};
