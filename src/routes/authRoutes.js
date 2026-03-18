const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Public routes
router.post('/email-signup', authController.emailSignup);
router.post('/email-login', authController.emailLogin);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);
router.post('/send-verification-code', authController.sendVerificationCode);
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-reset-code', authController.verifyResetCode);
router.post('/reset-password', authController.resetPassword);
router.get('/validate-reset-token', authController.validateResetToken);
router.post('/google-auth', authController.googleAuth);

module.exports = router;
