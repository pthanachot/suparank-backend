/**
 * Monthly report job (Phase 14 cron body, extracted in Phase 9 so the FULL
 * chain — generate → share → email → dedupe marker — is unit-testable).
 * index.js calls runMonthlyReports() from the 1st-of-month 03:30 UTC cron.
 *
 * Contract (unchanged from the inline cron):
 *  - Scope: every org on a PAID tier (active/trialing Subscription with a
 *    non-free planId and an organizationId).
 *  - Dedupe: reportEmailedAt on the snapshot. Emails go out whenever it is
 *    null — a manually generated snapshot still gets its monthly email, a
 *    crash between generate and email retries next run, and re-runs
 *    (deploy/restart on the 1st) never double-send.
 *  - Recipients: org owner + active client-role members of the workspace,
 *    deduped. No recipients → mark emailed (nothing to retry forever).
 *  - Share: rotateShare (revoke + create, 90d) preserves the one-live-link
 *    invariant; links use the org's resolved base URL (Invariant I1).
 *  - Marker set ONLY when ≥1 email actually sent — a total email outage
 *    leaves it null so the next run retries.
 *  - Failure isolation per workspace and per org; the job never throws.
 *
 * All collaborators are called through their module objects so tests can
 * monkey-patch them (repo convention).
 */

const Subscription = require('../models/Subscription');
const ReportSnapshot = require('../models/ReportSnapshot');
const WorkspaceMember = require('../models/WorkspaceMember');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const reportService = require('./reportService');
const domainService = require('./domainService');
const emailPortalController = require('../controllers/emailPortalController');
const emailService = require('../utils/emailService');

const SHARE_TTL_DAYS = 90;

/**
 * Run the monthly report pass. `period` defaults to the previous calendar
 * month (the cron fires just after a month closes); tests pass it
 * explicitly. Returns counters for the cron's summary log.
 */
async function runMonthlyReports({ period = reportService.previousPeriod() } = {}) {
  const result = {
    period,
    orgs: 0,
    workspacesProcessed: 0,
    generated: 0,
    emailed: 0,
    skippedAlreadyEmailed: 0,
    failures: 0,
  };

  const paidSubs = await Subscription.find({
    status: { $in: ['active', 'trialing'] },
    planId: { $ne: 'free' },
    organizationId: { $ne: null },
  })
    .select('organizationId')
    .lean();

  if (paidSubs.length === 0) return result;
  result.orgs = paidSubs.length;

  for (const sub of paidSubs) {
    const orgId = sub.organizationId;
    try {
      const [org, workspaces] = await Promise.all([
        Organization.findById(orgId).select('ownerId name').lean(),
        Workspace.find({ organizationId: orgId }).select('_id name').lean(),
      ]);
      if (!org || workspaces.length === 0) continue;

      const owner = await User.findById(org.ownerId).select('email').lean();
      const baseUrl = await domainService.resolveBaseUrl(orgId); // Invariant I1

      for (const ws of workspaces) {
        try {
          result.workspacesProcessed++;
          let snapshot = await ReportSnapshot.findOne({
            workspaceId: ws._id,
            period,
          })
            .select('_id reportEmailedAt')
            .lean();
          // Skip only when generated AND emailed — a manually generated
          // snapshot (reportEmailedAt null) still gets its monthly email.
          if (snapshot && snapshot.reportEmailedAt) {
            result.skippedAlreadyEmailed++;
            continue;
          }

          if (!snapshot) {
            snapshot = await reportService.generateSnapshot(ws._id, period);
            result.generated++;
          }

          // Recipients: org owner + client-role members of THIS workspace
          const clientMembers = await WorkspaceMember.find({
            workspaceId: ws._id,
            role: 'client',
            status: 'active',
          })
            .select('email')
            .lean();
          const recipients = [
            ...new Set([owner?.email, ...clientMembers.map((m) => m.email)].filter(Boolean)),
          ];
          if (recipients.length === 0) {
            // Nothing to send — mark done so we don't re-check forever.
            await ReportSnapshot.updateOne(
              { _id: snapshot._id },
              { $set: { reportEmailedAt: new Date() } }
            );
            continue;
          }

          // rotateShare (revoke + create) preserves the one-live-link-per-
          // report invariant — a bare createShare here would stack links.
          const { rawToken } = await reportService.rotateShare(snapshot._id, {
            ttlDays: SHARE_TTL_DAYS,
          });
          const reportUrl = `${baseUrl}/r/${rawToken}`;

          let sentCount = 0;
          for (const to of recipients) {
            try {
              const emailOptions = {
                to,
                orgId, // Phase 11 tenant sender identity
                data: {
                  workspaceName: ws.name || 'Workspace',
                  // Human-readable for the client-facing email ('June 2026').
                  // The raw 'YYYY-MM' period is used for all DB/query work.
                  period: reportService.formatPeriodLabel(period),
                  reportUrl,
                },
              };
              await emailPortalController.applyCustomTemplate('monthly_report', emailOptions, orgId);
              await emailService.sendEmail(emailOptions);
              sentCount++;
            } catch (emailErr) {
              console.error(`[monthly-reports] email to ${to} failed:`, emailErr.message);
            }
          }
          // Mark emailed only if at least one send succeeded — a total
          // outage (0 sent) leaves the marker null so the next run retries.
          if (sentCount > 0) {
            result.emailed += sentCount;
            await ReportSnapshot.updateOne(
              { _id: snapshot._id },
              { $set: { reportEmailedAt: new Date() } }
            );
          }
        } catch (wsErr) {
          result.failures++;
          console.error(`[monthly-reports] workspace ${ws._id} failed:`, wsErr.message);
        }
      }
    } catch (orgErr) {
      result.failures++;
      console.error(`[monthly-reports] org ${orgId} failed:`, orgErr.message);
    }
  }

  return result;
}

module.exports = { runMonthlyReports, SHARE_TTL_DAYS };
