const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { ingestObservations } = require('../controllers/observeController');

// Phase 7.3 — product-metrics sink. Authenticated (identity = the user) but no
// permission gate: it's a fire-and-forget analytics batch, not a resource op.
router.use(authenticateToken);
router.post('/', ingestObservations);

module.exports = router;
