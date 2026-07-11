const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const { authenticateToken } = require('../middleware/auth');
const adminController = require('../controllers/adminController');
const emailPortalController = require('../controllers/emailPortalController');
const feedbackController = require('../controllers/feedbackController');
const adminSettingsController = require('../controllers/adminSettingsController');
const adminSessionsController = require('../controllers/adminSessionsController');
const adminBackupsController = require('../controllers/adminBackupsController');
const platformAdminController = require('../controllers/platformAdminController');

// Admin gate (union of ADMIN_EMAILS env + SystemSettings.adminEmails; also blocks
// impersonated sessions). See middleware/validateAdmin.
const validateAdmin = require('../middleware/validateAdmin');

// All admin routes require auth + admin email check
const adminMiddleware = [authenticateToken, validateAdmin];

// ─── Admin core routes ──────────────────────────────────────

router.post('/user-lookup', authenticateToken, adminController.userLookup);
router.get('/stats', adminMiddleware, adminController.getDashboardStats);
router.get('/settings', adminMiddleware, adminSettingsController.getSystemSettings);
router.put('/settings', adminMiddleware, adminSettingsController.updateSystemSettings);
router.get('/settings/admins', adminMiddleware, adminSettingsController.listAdmins);
router.post('/settings/admins', adminMiddleware, adminSettingsController.addAdmin);
router.delete('/settings/admins/:email', adminMiddleware, adminSettingsController.removeAdmin);
router.get('/backups', adminMiddleware, adminBackupsController.getBackups);
router.post('/backups/run', adminMiddleware, adminBackupsController.runBackupNow);
router.get('/sessions', adminMiddleware, adminSessionsController.listSessions);
router.delete('/sessions/:sessionId', adminMiddleware, adminSessionsController.revokeSession);
router.post('/users/:userId/revoke-sessions', adminMiddleware, adminSessionsController.revokeAllUserSessions);
router.get('/users', adminMiddleware, adminController.getUsers);
router.get('/subscriptions/stats', adminMiddleware, adminController.getSubscriptionStats);
router.get('/subscriptions', adminMiddleware, adminController.getSubscriptions);
router.get('/organizations', adminMiddleware, adminController.getOrganizations);
router.get('/organizations/:orgId', adminMiddleware, adminController.getOrganizationDetail);
router.put('/organizations/:orgId', adminMiddleware, adminController.updateOrganization);
router.put('/organizations/:orgId/credits', adminMiddleware, adminController.manageOrgCredits);
router.get('/users/:userId', adminMiddleware, adminController.getUserDetail);
router.put('/users/:userId', adminMiddleware, adminController.updateUser);
router.put('/users/:userId/credits', adminMiddleware, adminController.manageUserCredits);
router.put('/users/:userId/quota', adminMiddleware, adminController.manageUserQuota);
router.put('/organizations/:orgId/quota', adminMiddleware, adminController.manageOrgQuota);
router.post('/organizations/:orgId/reset-to-free', adminMiddleware, adminController.resetOrgToFree);
router.put('/organizations/:orgId/plan', adminMiddleware, adminController.overrideOrgPlan);
router.put('/subscriptions/:subId', adminMiddleware, adminController.updateSubscription);
router.get('/credits/stats', adminMiddleware, adminController.getCreditStats);
router.get('/credits/accounts', adminMiddleware, adminController.getCreditAccounts);
router.get('/credits/organizations', adminMiddleware, adminController.getCreditOrganizations);
router.post('/credits/bulk', adminMiddleware, adminController.bulkManageCredits);
router.get('/credits/transactions/export', adminMiddleware, adminController.exportCreditTransactions);
router.delete('/users/:userId', adminMiddleware, adminController.adminDeleteUser);
router.delete('/organizations/:orgId', adminMiddleware, adminController.adminDeleteOrganization);

// ─── Email portal routes ────────────────────────────────────

router.get('/email-portal/subscribers', adminMiddleware, emailPortalController.getSubscribedUsers);
router.post('/email-portal/send', adminMiddleware, emailPortalController.sendBulkEmails);
router.post('/email-portal/test', adminMiddleware, emailPortalController.sendTestEmail);
router.get('/email-portal/logs', adminMiddleware, emailPortalController.getSendLogs);
router.get('/email-portal/stats', adminMiddleware, emailPortalController.getPortalStats);
router.get('/email-portal/templates', adminMiddleware, emailPortalController.getTemplates);
router.post('/email-portal/templates', adminMiddleware, emailPortalController.saveTemplate);
router.delete('/email-portal/templates/:id', adminMiddleware, emailPortalController.deleteTemplate);
router.get('/email-portal/triggers', adminMiddleware, emailPortalController.getTriggers);
router.get('/email-portal/triggers/:triggerId/default', adminMiddleware, emailPortalController.getDefaultTemplate);
router.put('/email-portal/triggers/:triggerId/default', adminMiddleware, emailPortalController.updateDefaultTemplate);

// ─── White-label brand configs ──────────────────────────────

const brandController = require('../controllers/brandController');
router.get('/brand-configs', adminMiddleware, brandController.adminListBrandConfigs);
router.put('/brand-configs/:orgId', adminMiddleware, brandController.adminUpdateBrandConfig);

// ─── Feedback routes ────────────────────────────────────────

router.get('/feedback', adminMiddleware, feedbackController.getFeedbackList);
router.get('/feedback/stats', adminMiddleware, feedbackController.getFeedbackStats);
router.put('/feedback/:id', adminMiddleware, feedbackController.updateFeedback);

// ─── Platform admin: tenant fleet + health board + impersonation (Phase 19B) ──
// Impersonation endpoints self-gate behind IMPERSONATION_ENABLED (dark default).
router.get('/tenants', adminMiddleware, platformAdminController.getTenants);
router.get('/health-board', adminMiddleware, platformAdminController.getHealthBoard);
router.get('/impersonations', adminMiddleware, platformAdminController.listImpersonations);
router.post('/organizations/:orgId/impersonate', adminMiddleware, platformAdminController.startImpersonation);
router.post('/impersonate/:sessionId/stop', adminMiddleware, platformAdminController.stopImpersonation);

module.exports = router;
