const express = require('express');
const router = express.Router();
const brandController = require('../controllers/brandController');
const clientCheckoutController = require('../controllers/clientCheckoutController');

// Public — the tenant login page must render the right brand BEFORE
// anyone authenticates. Display fields only; cached 5 min.
router.get('/brand', brandController.getTenantBrand);

// Public — brand + resolved orgId for org pinning on custom domains.
router.get('/resolve', brandController.resolveTenant);

// Public — client-facing (tenant-domain) checkout for an agency's plans
// (Phase 16 SaaS mode). Internally gated by the saasMode flag + entitlement +
// host resolution; returns 404 when not live/entitled (no leak).
router.get('/checkout-context', clientCheckoutController.getCheckoutContext);
router.post('/checkout', clientCheckoutController.createClientCheckout);

module.exports = router;
