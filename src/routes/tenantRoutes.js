const express = require('express');
const router = express.Router();
const brandController = require('../controllers/brandController');

// Public — the tenant login page must render the right brand BEFORE
// anyone authenticates. Display fields only; cached 5 min.
router.get('/brand', brandController.getTenantBrand);

// Public — brand + resolved orgId for org pinning on custom domains.
router.get('/resolve', brandController.resolveTenant);

module.exports = router;
