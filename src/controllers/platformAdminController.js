/**
 * Platform-admin console (Phase 19B). All routes are behind adminMiddleware
 * (authenticateToken + validateAdmin), so req.user is a verified platform admin
 * and never an impersonated session (validateAdmin rejects those).
 *
 *   GET  /api/admin/tenants?page&limit&search      — fleet list
 *   GET  /api/admin/health-board                   — WL health signals
 *   GET  /api/admin/impersonations                 — live impersonation sessions
 *   POST /api/admin/organizations/:orgId/impersonate  — start "login as" owner
 *   POST /api/admin/impersonate/:sessionId/stop       — end an impersonation
 *
 * Impersonation is OPT-IN: dark unless IMPERSONATION_ENABLED==='true'.
 */

const platformAdminService = require('../services/platformAdminService');
const impersonationService = require('../services/impersonationService');

const impersonationEnabled = () => process.env.IMPERSONATION_ENABLED === 'true';

// Expected refusal codes → HTTP status + message.
const IMPERSONATE_ERRORS = {
  org_not_found: [404, 'Organization not found'],
  no_owner: [404, 'Organization has no owner to impersonate'],
  org_busy: [409, 'Organization is mid-lifecycle (suspending/purging/restoring); try again later'],
  self: [400, 'You cannot impersonate yourself'],
  target_is_admin: [403, 'Cannot impersonate a platform admin'],
  target_inactive: [409, 'Target account is not active'],
  not_found: [404, 'Impersonation session not found'],
};

const getTenants = async (req, res) => {
  try {
    const { page, limit, search } = req.query;
    res.json(await platformAdminService.getTenantList({ page, limit, search: search || '' }));
  } catch (error) {
    console.error('[admin] getTenants error:', error.message);
    res.status(500).json({ error: 'Failed to load tenant list' });
  }
};

const getHealthBoard = async (req, res) => {
  try {
    res.json(await platformAdminService.getHealthBoard());
  } catch (error) {
    console.error('[admin] getHealthBoard error:', error.message);
    res.status(500).json({ error: 'Failed to load health board' });
  }
};

const listImpersonations = async (req, res) => {
  if (!impersonationEnabled()) return res.status(404).json({ error: 'Not found' });
  try {
    res.json({ sessions: await impersonationService.listActiveImpersonations() });
  } catch (error) {
    console.error('[admin] listImpersonations error:', error.message);
    res.status(500).json({ error: 'Failed to list impersonations' });
  }
};

const startImpersonation = async (req, res) => {
  if (!impersonationEnabled()) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await impersonationService.startImpersonation({
      adminUser: req.user,
      orgId: req.params.orgId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (result.error) {
      const [status, message] = IMPERSONATE_ERRORS[result.error] || [400, 'Cannot start impersonation'];
      return res.status(status).json({ error: message });
    }
    res.json(result);
  } catch (error) {
    console.error('[admin] startImpersonation error:', error.message);
    res.status(500).json({ error: 'Failed to start impersonation' });
  }
};

const stopImpersonation = async (req, res) => {
  if (!impersonationEnabled()) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await impersonationService.stopImpersonation({
      adminUser: req.user,
      sessionId: req.params.sessionId,
      ip: req.ip,
    });
    if (result.error) {
      const [status, message] = IMPERSONATE_ERRORS[result.error] || [400, 'Cannot stop impersonation'];
      return res.status(status).json({ error: message });
    }
    res.json(result);
  } catch (error) {
    console.error('[admin] stopImpersonation error:', error.message);
    res.status(500).json({ error: 'Failed to stop impersonation' });
  }
};

module.exports = { getTenants, getHealthBoard, listImpersonations, startImpersonation, stopImpersonation };
