const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
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
router.put('/organizations/:orgId/members/:memberId/scope', rejectIfLocked(OrgMember, 'memberId'), orgMemberController.updateMemberScope);
router.put('/organizations/:orgId/members/:memberId/workspaces', rejectIfLocked(OrgMember, 'memberId'), orgMemberController.setMemberWorkspaces);
router.delete('/organizations/:orgId/members/:memberId', orgMemberController.removeMember);
router.delete('/organizations/:orgId/invites/:inviteId', orgMemberController.revokeInvite);
router.get('/organizations/:orgId/audit-log', orgMemberController.listAuditLog);

// White-label brand settings
const brandController = require('../controllers/brandController');
router.get('/organizations/:orgId/brand', brandController.getOrgBrand);
router.put('/organizations/:orgId/brand', brandController.updateOrgBrand);

// Tenant custom domains — behind the 'customDomains' feature flag
// (enabled+implemented in configFeatureFlags.js; ships dark until launch).
const domainController = require('../controllers/domainController');
const { requireFeature } = require('../middleware/permissions');
const rfDomains = requireFeature('customDomains');
router.get('/organizations/:orgId/domains', rfDomains, domainController.listDomains);
router.post('/organizations/:orgId/domains', rfDomains, domainController.addDomain);
router.post('/organizations/:orgId/domains/:domainId/verify', rfDomains, domainController.verifyDomain);
router.put('/organizations/:orgId/domains/:domainId/primary', rfDomains, domainController.setPrimaryDomain);
router.delete('/organizations/:orgId/domains/:domainId', rfDomains, domainController.deleteDomain);

// White-label email — sender domain (Phase 11), behind the whiteLabelEmail flag
const emailDomainController = require('../controllers/emailDomainController');
const rfWlEmail = requireFeature('whiteLabelEmail');
router.get('/organizations/:orgId/email-domain', rfWlEmail, emailDomainController.getEmailDomain);
router.put('/organizations/:orgId/email-domain', rfWlEmail, emailDomainController.setEmailDomain);
router.post('/organizations/:orgId/email-domain/verify', rfWlEmail, emailDomainController.verifyEmailDomain);
router.delete('/organizations/:orgId/email-domain', rfWlEmail, emailDomainController.removeEmailDomain);

// White-label email — per-tenant templates (Phase 12), behind the whiteLabelEmail flag
const tenantEmailTemplateController = require('../controllers/tenantEmailTemplateController');
router.get('/organizations/:orgId/email-templates', rfWlEmail, tenantEmailTemplateController.listEmailTemplates);
router.put('/organizations/:orgId/email-templates/:triggerId', rfWlEmail, tenantEmailTemplateController.updateEmailTemplate);
router.delete('/organizations/:orgId/email-templates/:triggerId', rfWlEmail, tenantEmailTemplateController.resetEmailTemplate);

router.post('/organizations/:orgId/transfer-ownership', orgMemberController.transferOwnership);
router.post('/organizations/:orgId/leave', orgMemberController.leaveOrganization);

module.exports = router;
