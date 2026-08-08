const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { ingestObservations } = require('../controllers/observeController');

// Wave 0 (§3.1): /api/observe is EXEMPT from the global per-IP limiter (see the
// skip in index.js) — every browser reaches the backend through the Next proxy
// on ONE shared IP, so telemetry batches from a single busy editor session
// would burn the shared bucket and 429 the whole app for everyone. Capped
// per-user here instead. The client flushes at most one ≤50-event batch per 5s
// (~12/min) — but each TAB has its own queue and timer, so a multi-tab editor
// user can legitimately reach ~12/min per tab. 60/min (the bell's cap) covers
// several tabs + unload beacons without letting a broken client hammer the DB.
// Mirrors feedLimiter in notificationRoutes.
const observeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.userId || req.ip),
});

// Phase 7.3 — product-metrics sink. Authenticated (identity = the user) but no
// permission gate: it's a fire-and-forget analytics batch, not a resource op.
router.use(authenticateToken); // req.user is set before observeLimiter's keyGenerator runs
router.post('/', observeLimiter, ingestObservations);

module.exports = router;
