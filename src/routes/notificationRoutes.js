const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');

// The bell polls this endpoint every ~90s from every open tab, so it is EXEMPT
// from the global per-IP limiter (see the skip in index.js) — an office behind
// one NAT would otherwise share a single bucket and 429 the whole feature — and
// is capped per-user here instead. Generous (a poll is ~0.7/min; 60 leaves room
// for manual refreshes). Mirrors autocompleteLimiter in workspaceRoutes.
const feedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.userId || req.ip),
});

router.use(authenticateToken); // req.user is set before feedLimiter's keyGenerator runs
router.get('/', feedLimiter, notificationController.getFeed);
router.post('/seen', feedLimiter, notificationController.markSeen);

module.exports = router;
