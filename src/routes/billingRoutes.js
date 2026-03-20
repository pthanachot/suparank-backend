const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { authenticateToken } = require('../middleware/auth');

// All billing routes require authentication
router.use(authenticateToken);

router.get('/subscription', billingController.getSubscription);
router.post('/checkout', billingController.createCheckoutSession);
router.post('/customer-portal', billingController.createCustomerPortal);

module.exports = router;
