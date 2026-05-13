const express = require('express');
const router = express.Router();
const orgMemberController = require('../controllers/orgMemberController');
const tierController = require('../controllers/tierController');
const creditController = require('../controllers/creditController');
const { authenticateToken } = require('../middleware/auth');
const OrgMember = require('../models/OrgMember');
const { rejectIfLocked } = require('../middleware/lockGuard');

// All org routes require authentication
router.use(authenticateToken);

// Available roles (global, not org-scoped)
router.get('/roles', orgMemberController.listRoles);

// Feature flags (global, not org-scoped)
router.get('/feature-flags', orgMemberController.listFeatureFlags);

// Tier info (org's plan, limits, and current usage)
router.get('/tier-info', tierController.getTierInfo);

// Credit balance and history
router.get('/credits', creditController.getCredits);
router.get('/credits/history', creditController.getCreditHistory);

// Org-scoped member management
router.get('/organizations/:orgId/members', orgMemberController.listMembers);
router.post('/organizations/:orgId/members', orgMemberController.inviteMember);
router.put('/organizations/:orgId/members/:memberId/role', rejectIfLocked(OrgMember, 'memberId'), orgMemberController.changeRole);
router.delete('/organizations/:orgId/members/:memberId', orgMemberController.removeMember);
router.post('/organizations/:orgId/transfer-ownership', orgMemberController.transferOwnership);
router.post('/organizations/:orgId/leave', orgMemberController.leaveOrganization);

module.exports = router;
