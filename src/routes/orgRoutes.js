const express = require('express');
const router = express.Router();
const orgMemberController = require('../controllers/orgMemberController');
const { authenticateToken } = require('../middleware/auth');

// All org routes require authentication
router.use(authenticateToken);

// Available roles (global, not org-scoped)
router.get('/roles', orgMemberController.listRoles);

// Feature flags (global, not org-scoped)
router.get('/feature-flags', orgMemberController.listFeatureFlags);

// Org-scoped member management
router.get('/organizations/:orgId/members', orgMemberController.listMembers);
router.post('/organizations/:orgId/members', orgMemberController.inviteMember);
router.put('/organizations/:orgId/members/:memberId/role', orgMemberController.changeRole);
router.delete('/organizations/:orgId/members/:memberId', orgMemberController.removeMember);

module.exports = router;
