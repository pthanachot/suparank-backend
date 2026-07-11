'use strict';

/**
 * Tracker scheduling helpers (Phase 11 review follow-up).
 *
 * The Free-tier scan gate (aiTrackerController.executeScan step 2a) UNSCHEDULES a
 * Free org's trackers by setting nextScanAt=null so cron stops re-picking them.
 * Nothing re-armed them when the org later upgraded to a paid tier, so a
 * converting customer's PRE-EXISTING trackers silently got no automated scans
 * until they manually refreshed or edited a prompt. This re-arms them on paid
 * activation: set nextScanAt=now and let executeScan compute the precise next
 * time (its step 3c/9 reschedule from prompt due-times; a tracker with no due
 * prompts is simply advanced ~1 day out, not scanned — no cost).
 *
 * Idempotent: after the first run no null-nextScanAt tracker remains, so a repeat
 * (renewal webhook, etc.) matches nothing. nextScanAt=null naturally excludes
 * in-flight scans (those retain their past due-time until step 10).
 */

const Workspace = require('../models/Workspace');
const AiTracker = require('../models/AiTracker');

async function rearmTrackersForOrg(orgId, now = new Date()) {
  if (!orgId) return { rearmed: 0 };
  const workspaces = await Workspace.find({ organizationId: orgId }).select('_id').lean();
  if (!workspaces.length) return { rearmed: 0 };
  const wsIds = workspaces.map((w) => w._id);
  const res = await AiTracker.updateMany(
    { workspaceId: { $in: wsIds }, nextScanAt: null },
    { $set: { nextScanAt: now } }
  );
  return { rearmed: res.modifiedCount || 0 };
}

module.exports = { rearmTrackersForOrg };
