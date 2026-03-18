const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Public routes
router.post('/email-signup', authController.emailSignup);
router.post('/email-login', authController.emailLogin);

module.exports = router;
