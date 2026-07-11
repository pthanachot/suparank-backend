/**
 * Data export controller (Phase 18B). Streams a tar.gz of a workspace's or an
 * org's data for offboarding / GDPR portability. Routes are gated behind the
 * dark `dataExport` feature flag (requireFeature) so this ships inert.
 */

const exportService = require('../services/exportService');
const orgMemberController = require('./orgMemberController');
const auditService = require('../services/auditService');

function _sendArchive(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
}

/** GET /:workspaceNumber/export — requires resolved workspace + read access. */
async function exportWorkspace(req, res) {
  try {
    const { filename, buffer } = await exportService.exportWorkspaceArchive(req.workspace._id);
    auditService.fromReq(req, {
      action: 'data.workspace_exported',
      resourceId: req.workspace._id,
      meta: { filename, bytes: buffer.length },
    });
    return _sendArchive(res, filename, buffer);
  } catch (err) {
    console.error('[export] workspace export failed:', err.message);
    return res.status(500).json({ error: 'Export failed' });
  }
}

/** GET /organizations/:orgId/export — owner or org-wide admin only. */
async function exportOrg(req, res) {
  try {
    const result = await orgMemberController.resolveOrgWithAccess(req, res, true);
    if (!result) return; // resolveOrgWithAccess already sent 403/404
    const { org, callerRole, accessScope } = result;

    // resolveOrgWithAccess(…, true) only checks role==='admin', NOT accessScope.
    // An 'assigned'-scope admin is limited to specific workspaces and must not
    // pull a whole-org export (every other org-wide read enforces this guard —
    // listMembers/listAuditLog). Without it a restricted agency-staff member
    // could exfiltrate every other client's data + the org's client subs.
    if (accessScope === 'assigned' && callerRole !== 'owner') {
      return res.status(403).json({ error: 'You do not have access to a full-organization export' });
    }

    const { filename, buffer } = await exportService.exportOrgArchive(org._id);
    auditService.record({
      organizationId: org._id,
      userId: req.user?.userId,
      actorEmail: req.user?.email,
      impersonatedBy: req.user?.impersonatedBy || null,
      action: 'data.org_exported',
      resourceId: org._id,
      meta: { filename, bytes: buffer.length },
    });
    return _sendArchive(res, filename, buffer);
  } catch (err) {
    console.error('[export] org export failed:', err.message);
    return res.status(500).json({ error: 'Export failed' });
  }
}

module.exports = { exportWorkspace, exportOrg };
