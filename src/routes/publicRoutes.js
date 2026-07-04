/**
 * Public, unauthenticated endpoints (mounted at /api/public in index.js).
 * Everything here is token-gated (unguessable 64-hex tokens) and returns
 * display-safe payloads only — no auth middleware on purpose.
 */
const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');

// Shared monthly report (Phase 14) — token minted via the share endpoint
router.get('/reports/:token', reportController.publicReport);

module.exports = router;
