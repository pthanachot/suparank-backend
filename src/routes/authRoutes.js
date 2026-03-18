const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Public routes
router.post('/email-signup', authController.emailSignup);
router.post('/email-login', authController.emailLogin);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);
router.post('/send-verification-code', authController.sendVerificationCode);

module.exports = router;
