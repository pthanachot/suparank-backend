const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const organizationController = require('../controllers/organizationController');
const { authenticateToken } = require('../middleware/auth');

// All organization routes require authentication
router.use(authenticateToken);

router.get('/', organizationController.listOrganizations);
router.post('/', organizationController.createOrganization);
router.get('/:orgId', organizationController.getOrganization);
router.put('/:orgId', organizationController.updateOrganization);
router.delete('/:orgId', organizationController.deleteOrganization);

module.exports = router;
