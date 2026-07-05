const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { authenticateToken } = require('../middleware/auth');
const { requireFeature: rf } = require('../middleware/permissions');

// Public (no auth) — prices are not secret
router.get('/prices', billingController.getPrices);

// All other billing routes require authentication + feature flag
router.use(authenticateToken);

router.get('/subscription', rf('billing'), billingController.getSubscription);
router.post('/checkout', rf('billing'), billingController.createCheckoutSession);
router.post('/customer-portal', rf('billing'), billingController.createCustomerPortal);
router.post('/revoke-schedule', rf('billing'), billingController.revokeScheduledChange);
router.post('/cancel', rf('billing'), billingController.cancelSubscription);
router.post('/reactivate', rf('billing'), billingController.reactivateSubscription);
router.get('/invoices', rf('billing'), billingController.getInvoices);
router.post('/extra-seats', rf('billing'), billingController.updateExtraSeats);

// Credit top-up packs (one-time purchases → non-expiring general credits)
router.get('/credit-packs', billingController.getCreditPacks);
router.post('/credit-packs/checkout', rf('billing'), billingController.createCreditPackCheckout);

module.exports = router;
