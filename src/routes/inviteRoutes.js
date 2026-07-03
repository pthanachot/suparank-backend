const express = require('express');
const router = express.Router();
const inviteController = require('../controllers/inviteController');
const { authenticateToken } = require('../middleware/auth');

// Public — the accept page must show org/email before login (token is the auth)
router.get('/lookup', inviteController.lookupInvite);

// Logged-in users accepting an invite
router.post('/accept', authenticateToken, inviteController.acceptInvite);

module.exports = router;
