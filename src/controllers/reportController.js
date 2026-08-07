/**
 * Monthly workspace reports (Phase 14).
 *
 * Workspace-scoped (after resolveWorkspaceWithRole + requirePermission):
 *   GET    /:workspaceNumber/reports                    analysis:read
 *   POST   /:workspaceNumber/reports/generate           analysis:use
 *   GET    /:workspaceNumber/reports/:period            analysis:read
 *   POST   /:workspaceNumber/reports/:period/share      members:manage
 *   DELETE /:workspaceNumber/reports/:period/share      members:manage
 *   GET    /:workspaceNumber/reports/:period/pdf        analysis:read
 *
 * Public (no auth, mounted under /api/public):
 *   GET /reports/:token
 */

const ReportSnapshot = require('../models/ReportSnapshot');
const reportService = require('../services/reportService');
const reportPdfService = require('../services/reportPdfService');
const domainService = require('../services/domainService');
const auditService = require('../services/auditService');

/** Report payload shape shared by generate/get and the public resolver. */
function _serialize(snapshot) {
  return {
    period: snapshot.period,
    generatedAt: snapshot.generatedAt,
    ...(snapshot.data || {}),
  };
}

/** Find the workspace's snapshot for :period, replying 400/404 on failure. */
async function _findSnapshotForPeriod(req, res) {
  const { period } = req.params;
  if (!reportService.isValidPeriod(period)) {
    res.status(400).json({ error: 'Invalid period — expected YYYY-MM' });
    return null;
  }
  const snapshot = await ReportSnapshot.findOne({
    workspaceId: req.workspace._id,
    period,
  });
  if (!snapshot) {
    res.status(404).json({ error: 'No report for this period — generate it first' });
    return null;
  }
  return snapshot;
}

// ─── LIST ────────────────────────────────────────────────────────

const listReports = async (req, res) => {
  try {
    const [snapshots, sharedIds] = await Promise.all([
      reportService.getSnapshots(req.workspace._id),
      reportService.findSharedReportIds(req.workspace._id),
    ]);

    res.json({
      reports: snapshots.map((s) => ({
        period: s.period,
        generatedAt: s.generatedAt,
        hasShare: sharedIds.has(String(s._id)),
      })),
    });
  } catch (error) {
    console.error('List reports error:', error);
    res.status(500).json({ error: 'Failed to load reports' });
  }
};

// ─── GENERATE ────────────────────────────────────────────────────

const generateReport = async (req, res) => {
  try {
    const period = req.body?.period || reportService.currentPeriod();
    const regenerate = req.body?.regenerate === true;
    let commentary = req.body?.commentary;
    if (commentary !== undefined) {
      if (typeof commentary !== 'string') {
        return res.status(400).json({ error: 'commentary must be a string' });
      }
      commentary = commentary.trim();
      if (commentary.length > reportService.COMMENTARY_MAX_LENGTH) {
        return res.status(400).json({
          error: `commentary must be at most ${reportService.COMMENTARY_MAX_LENGTH} characters`,
        });
      }
    }

    // Phase 5 fast path: a commentary edit of an EXISTING snapshot must not
    // re-aggregate — outcomes and the GSC fallback are current-state reads,
    // so regenerating a past period would rewrite its numbers under the old
    // heading. A full refresh is an explicit ask: { regenerate: true }.
    if (commentary !== undefined && !regenerate) {
      let updated;
      try {
        updated = await reportService.updateCommentary(req.workspace._id, period, commentary);
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      if (updated) {
        auditService.fromReq(req, {
          action: 'report.generate',
          resourceId: updated._id,
          meta: { period, commentaryOnly: true },
        });
        return res.json({ report: _serialize(updated) });
      }
      // No snapshot for this period yet — fall through to a full generation
      // (which bakes the commentary alongside the fresh aggregate).
    }

    let snapshot;
    try {
      snapshot = await reportService.generateSnapshot(req.workspace._id, period, { commentary });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    auditService.fromReq(req, {
      action: 'report.generate',
      resourceId: snapshot._id,
      meta: { period },
    });

    res.json({ report: _serialize(snapshot) });
  } catch (error) {
    console.error('Generate report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
};

// ─── GET ONE ─────────────────────────────────────────────────────

const getReport = async (req, res) => {
  try {
    const snapshot = await _findSnapshotForPeriod(req, res);
    if (!snapshot) return;
    res.json({ report: _serialize(snapshot) });
  } catch (error) {
    console.error('Get report error:', error);
    res.status(500).json({ error: 'Failed to load report' });
  }
};

// ─── SHARE ───────────────────────────────────────────────────────

const createShareLink = async (req, res) => {
  try {
    const snapshot = await _findSnapshotForPeriod(req, res);
    if (!snapshot) return;

    // One live public link per report — re-sharing replaces the old one
    // (mirrors invite semantics), so DELETE reliably kills all access.
    const { share, rawToken } = await reportService.rotateShare(snapshot._id, {
      createdBy: req.user.userId,
    });

    // Invariant I1: tenant-facing links use the org's custom domain
    const baseUrl = await domainService.resolveBaseUrl(req.workspace.organizationId);

    auditService.fromReq(req, {
      action: 'report.share',
      resourceId: snapshot._id,
      meta: { period: snapshot.period, expiresAt: share.expiresAt },
    });

    res.json({
      url: `${baseUrl}/r/${rawToken}`,
      expiresAt: share.expiresAt,
    });
  } catch (error) {
    console.error('Share report error:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
};

const revokeShareLink = async (req, res) => {
  try {
    const snapshot = await _findSnapshotForPeriod(req, res);
    if (!snapshot) return;

    await reportService.revokeShares(snapshot._id);

    auditService.fromReq(req, {
      action: 'report.share_revoked',
      resourceId: snapshot._id,
      meta: { period: snapshot.period },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Revoke report share error:', error);
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
};

// ─── PDF ─────────────────────────────────────────────────────────

const downloadPdf = async (req, res) => {
  try {
    const snapshot = await _findSnapshotForPeriod(req, res);
    if (!snapshot) return;

    let buffer;
    try {
      buffer = await reportPdfService.generatePdf(snapshot._id);
    } catch (err) {
      // 501 unavailable/misconfigured, 429 concurrency cap, 502 render error
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }

    const filename = `report-${req.workspace.workspaceNumber}-${snapshot.period}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Report PDF error:', error);
    res.status(500).json({ error: 'Failed to render report PDF' });
  }
};

// ─── PUBLIC (no auth) ────────────────────────────────────────────

const publicReport = async (req, res) => {
  // Tokenized public data — must never be cached by intermediaries
  res.setHeader('Cache-Control', 'no-store');
  try {
    const resolved = await reportService.resolvePublicReport(req.params.token);
    if (!resolved) {
      return res.status(404).json({ error: 'This report link is invalid or has expired' });
    }
    res.json(resolved);
  } catch (error) {
    console.error('Public report error:', error);
    res.status(500).json({ error: 'Failed to load report' });
  }
};

module.exports = {
  listReports,
  generateReport,
  getReport,
  createShareLink,
  revokeShareLink,
  downloadPdf,
  publicReport,
};
