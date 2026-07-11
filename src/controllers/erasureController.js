/**
 * Data erasure controller (Phase 18C). Hard-deletes a workspace or an entire org
 * for client-erasure / GDPR right-to-erasure requests. Routes are gated behind
 * the dark `dataErasure` feature flag (requireFeature) so this ships inert.
 *
 * Guardrails (this is irreversible):
 *   - Workspace erase: caller must be workspace owner OR admin.
 *   - Org erase: caller must be the org OWNER (dropping a whole org is drastic).
 *   - Both require a body `confirm` that exactly matches the target's name, so a
 *     misdirected or accidental request can't destroy the wrong tenant.
 * Callers should export (Phase 18B) first — erasure does not archive.
 */

const deletionService = require('../services/deletionService');
const orgMemberController = require('./orgMemberController');
const auditService = require('../services/auditService');

/** DELETE /:workspaceNumber/erase — owner/admin, name-confirmed. Runs after rwr. */
async function eraseWorkspace(req, res) {
  try {
    const role = req.workspaceRole;
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only a workspace owner or admin can erase a workspace' });
    }

    // Capture identity BEFORE deletion (the record is about to disappear).
    const wsId = req.workspace._id;
    const orgId = req.workspace.organizationId;
    const wsName = req.workspace.name || '';

    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim() : '';
    if (!confirm || confirm !== wsName) {
      return res.status(400).json({
        error: 'Confirmation required: send { confirm: "<exact workspace name>" } to erase',
      });
    }

    const counts = await deletionService.deleteWorkspaceData(wsId);
    const partial = !!counts.errors;
    auditService.record({
      organizationId: orgId,
      userId: req.user?.userId,
      actorEmail: req.user?.email,
      impersonatedBy: req.user?.impersonatedBy || null,
      action: 'data.workspace_erased',
      resourceId: wsId,
      meta: { workspaceName: wsName, counts, partial },
    });
    if (partial) {
      // Some collections failed to delete — do NOT certify a completed erasure.
      // Deletion is idempotent, so the caller can safely retry to finish.
      return res.status(500).json({
        erased: false,
        partial: true,
        error: 'Erasure incomplete — some data could not be deleted; retry to complete',
        counts,
      });
    }
    return res.json({ erased: true, scope: 'workspace', counts });
  } catch (err) {
    console.error('[erasure] workspace erase failed:', err.message);
    return res.status(500).json({ error: 'Erasure failed' });
  }
}

/** DELETE /organizations/:orgId/erase — org OWNER only, name-confirmed. */
async function eraseOrg(req, res) {
  try {
    const result = await orgMemberController.resolveOrgWithAccess(req, res, true);
    if (!result) return; // resolveOrgWithAccess already sent 403/404
    const { org, callerRole } = result;

    // Erasing an entire org is owner-only — an admin (even org-wide) cannot do it.
    if (callerRole !== 'owner') {
      return res.status(403).json({ error: 'Only the organization owner can erase the organization' });
    }
    // A personal org is the user's account root and must not be erased here.
    if (org.isPersonal) {
      return res.status(400).json({ error: 'A personal organization cannot be erased' });
    }

    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim() : '';
    if (!confirm || confirm !== (org.name || '')) {
      return res.status(400).json({
        error: 'Confirmation required: send { confirm: "<exact organization name>" } to erase',
      });
    }

    const counts = await deletionService.deleteOrgData(org._id);
    const partial = !!counts.errors;
    auditService.record({
      organizationId: org._id,
      userId: req.user?.userId,
      actorEmail: req.user?.email,
      impersonatedBy: req.user?.impersonatedBy || null,
      action: 'data.org_erased',
      resourceId: org._id,
      meta: { orgName: org.name, counts, partial },
    });
    if (partial) {
      return res.status(500).json({
        erased: false,
        partial: true,
        error: 'Erasure incomplete — some data could not be deleted; retry to complete',
        counts,
      });
    }
    return res.json({ erased: true, scope: 'organization', counts });
  } catch (err) {
    console.error('[erasure] org erase failed:', err.message);
    return res.status(500).json({ error: 'Erasure failed' });
  }
}

module.exports = { eraseWorkspace, eraseOrg };
