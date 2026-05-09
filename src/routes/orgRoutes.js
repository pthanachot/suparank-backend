const express = require('express');
const router = express.Router();
const orgMemberController = require('../controllers/orgMemberController');
const { authenticateToken } = require('../middleware/auth');

// All org routes require authentication
router.use(authenticateToken);

// Org members
router.get('/members', orgMemberController.listMembers);
router.post('/members', orgMemberController.inviteMember);
router.put('/members/:memberId/role', orgMemberController.changeRole);
router.delete('/members/:memberId', orgMemberController.removeMember);

// Available roles
router.get('/roles', orgMemberController.listRoles);

// Feature flags (for frontend)
router.get('/feature-flags', orgMemberController.listFeatureFlags);

module.exports = router;
