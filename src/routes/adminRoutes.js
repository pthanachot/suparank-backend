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
const announcementController = require('../controllers/announcementController');

// Admin gate (env-only: ADMIN_EMAILS + ADMIN_EMAILS_2..5; also blocks
// impersonated sessions). See middleware/validateAdmin.
const validateAdmin = require('../middleware/validateAdmin');

// All admin routes require auth + admin email check
const adminMiddleware = [authenticateToken, validateAdmin];

// ─── Admin core routes ──────────────────────────────────────

router.post('/user-lookup', authenticateToken, adminController.userLookup);
router.get('/stats', adminMiddleware, adminController.getDashboardStats);
router.get('/settings', adminMiddleware, adminSettingsController.getSystemSettings);
router.put('/settings', adminMiddleware, adminSettingsController.updateSystemSettings);
// Admin identity is env-only (Phase 2): managed via ADMIN_EMAILS / ADMIN_EMAILS_2..5
// in Railway. Listing stays read-only; the add/remove endpoints are retired (410).
router.get('/settings/admins', adminMiddleware, adminSettingsController.listAdmins);
// Per-org image COGS — the view that says whether /image is behaving after it
// is switched on. Images bill per unit, so a runaway tenant is invisible on
// every token-based chart.
router.get('/image-spend', adminMiddleware, adminSettingsController.getImageSpend);
// Wave 0 (§3.6): first reader for the durable telemetry rollups.
// ?days=30&event=&orgId= — newest first, capped.
const { getUsageRollups } = require('../controllers/observeController');
router.get('/usage-rollups', adminMiddleware, getUsageRollups);
// Wave 4 (§7): the Usage dashboard's read endpoints.
const adminUsageController = require('../controllers/adminUsageController');
router.get('/usage/overview', adminMiddleware, adminUsageController.getUsageOverview);
router.get('/usage/funnels', adminMiddleware, adminUsageController.getUsageFunnels);
router.get('/usage/series', adminMiddleware, adminUsageController.getUsageSeries);
router.get('/usage/conversion', adminMiddleware, adminUsageController.getUsageConversion);
router.get('/usage/retention', adminMiddleware, adminUsageController.getUsageRetention);
const adminEmailsGone = (req, res) =>
  res.status(410).json({
    error:
      'Admin accounts are managed via Railway environment variables (ADMIN_EMAILS…ADMIN_EMAILS_5) and can no longer be changed here.',
  });
router.post('/settings/admins', adminMiddleware, adminEmailsGone);
router.delete('/settings/admins/:email', adminMiddleware, adminEmailsGone);
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

// ─── Admin audit log (Phase 15 — read/export the platform-admin trail) ──
const adminAuditController = require('../controllers/adminAuditController');
router.get('/audit-log', adminMiddleware, adminAuditController.listAuditLog);
router.get('/audit-log/export', adminMiddleware, adminAuditController.exportAuditLog);

// ─── Feedback routes ────────────────────────────────────────

router.get('/feedback', adminMiddleware, feedbackController.getFeedbackList);
router.get('/feedback/stats', adminMiddleware, feedbackController.getFeedbackStats);
router.put('/feedback/:id', adminMiddleware, feedbackController.updateFeedback);

// ─── Announcements (platform broadcast → the notification bell) ──
router.get('/announcements', adminMiddleware, announcementController.listAnnouncements);
router.post('/announcements', adminMiddleware, announcementController.createAnnouncement);
router.patch('/announcements/:id', adminMiddleware, announcementController.updateAnnouncement);

// ─── Platform admin: tenant fleet + health board + impersonation (Phase 19B) ──
// Impersonation endpoints self-gate behind IMPERSONATION_ENABLED (dark default).
router.get('/tenants', adminMiddleware, platformAdminController.getTenants);
router.get('/health-board', adminMiddleware, platformAdminController.getHealthBoard);
router.get('/impersonations', adminMiddleware, platformAdminController.listImpersonations);
router.post('/organizations/:orgId/impersonate', adminMiddleware, platformAdminController.startImpersonation);
router.post('/impersonate/:sessionId/stop', adminMiddleware, platformAdminController.stopImpersonation);

module.exports = router;
