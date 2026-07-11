const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const validateBody = require('../middleware/validateBody');
const v = require('../validators/authValidators');

// Public routes
router.post('/email-signup', validateBody(v.emailSignupSchema), authController.emailSignup);
router.post('/email-login', validateBody(v.emailLoginSchema), authController.emailLogin);
router.post('/google-auth', validateBody(v.googleAuthSchema), authController.googleAuth);
router.post('/refresh-token', validateBody(v.refreshTokenSchema), authController.refreshToken);
router.post('/verify-email', validateBody(v.verifyEmailSchema), authController.verifyEmail);
router.post('/resend-verification', validateBody(v.emailOnlySchema), authController.resendVerification);
router.post('/send-verification-code', validateBody(v.sendVerificationCodeSchema), authController.sendVerificationCode);
router.post('/forgot-password', validateBody(v.emailOnlySchema), authController.forgotPassword);
router.post('/verify-reset-code', validateBody(v.verifyResetCodeSchema), authController.verifyResetCode);
router.post('/reset-password', validateBody(v.resetPasswordSchema), authController.resetPassword);
router.get('/validate-reset-token', authController.validateResetToken);

// Protected routes
router.post('/logout', authenticateToken, authController.logout);
router.get('/verify', authenticateToken, authController.verify);
router.get('/profile', authenticateToken, authController.getProfile);

module.exports = router;
