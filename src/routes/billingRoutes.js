const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { authenticateToken } = require('../middleware/auth');

// All billing routes require authentication
router.use(authenticateToken);

router.get('/subscription', billingController.getSubscription);
router.post('/checkout', billingController.createCheckoutSession);
router.post('/customer-portal', billingController.createCustomerPortal);
router.post('/revoke-schedule', billingController.revokeScheduledChange);
router.post('/cancel', billingController.cancelSubscription);
router.post('/reactivate', billingController.reactivateSubscription);
router.get('/invoices', billingController.getInvoices);

module.exports = router;
