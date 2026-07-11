/**
 * seatService — the v4.1 seat model (Phase 9).
 *
 * Two distinct membership classes, counted against two distinct tier limits.
 * The split is by ROLE (who can edit), per GEO-PRICING-v4 Table 1 ("Editor
 * seats · free client viewers") and the note that the `client` Viewer role is
 * what counts against the client-viewer allowance:
 *  - EDITOR SEAT (maxSeats, billable, +$10 extra on Pro/Agency): a member who can
 *    EDIT — role admin or editor, whether org-wide (accessScope 'all') or scoped
 *    to specific workspaces (accessScope 'assigned'). The owner is always exactly
 *    one seat (implicit, not an OrgMember row).
 *  - CLIENT VIEWER (clientViewers: 0/3/10/∞, FREE): a read-only member — role
 *    viewer or client (a white-label external client's org row is floored to
 *    'viewer'). A client viewer does NOT consume an editor seat.
 *
 * Counting by role (not accessScope) is deliberate: an accessScope-based split
 * would let an `assigned` member with a workspace-EDITOR role edit content while
 * counting as a free viewer — an editor-seat bypass. `EDITOR_ROLES` = the seat
 * bucket; everything else (viewer/client, incl. floored clients) is a free viewer.
 */

const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');
const Invite = require('../models/Invite');

const EDITOR_ROLES = ['admin', 'editor'];

/**
 * Live seat/viewer usage for an org, INCLUDING pending (unexpired) invites so an
 * in-flight invite can't be double-spent past a cap. Locked members (downgrade)
 * don't occupy capacity.
 *
 * A member consumes an EDITOR SEAT iff they can EDIT ANYWHERE — org-wide role
 * admin/editor OR ANY per-workspace `WorkspaceMember.role` of admin/editor. This
 * is the robust definition: edit authority for an `accessScope:'assigned'` member
 * is resolved from `WorkspaceMember.role` (permissions.resolveWorkspaceWithRole),
 * NOT `OrgMember.role`, so counting `OrgMember.role` alone would let a workspace-
 * editor granted post-invite (via setMemberWorkspaces) or a demoted-but-still-
 * editing member (via changeRole) edit for free. Counting the effective
 * capability closes those desync bypasses at the source. Everyone else (view-only
 * viewer/client) is a free client viewer.
 *
 * @returns {Promise<{ seatsUsed: number, viewersUsed: number }>}
 *   seatsUsed  — edit-capable members + admin/editor pending invites + 1 (owner)
 *   viewersUsed — view-only members + viewer/client pending invites (no owner)
 */
async function getSeatUsage(orgId) {
  const now = new Date();
  const [members, wsEditorUserIds, seatInvites, viewerInvites] = await Promise.all([
    OrgMember.find({ organizationId: orgId, locked: { $ne: true } }).select('userId role').lean(),
    WorkspaceMember.find({ organizationId: orgId, role: { $in: EDITOR_ROLES }, status: { $ne: 'inactive' } }).distinct('userId'),
    Invite.countDocuments({ organizationId: orgId, expiresAt: { $gt: now }, role: { $in: EDITOR_ROLES } }),
    Invite.countDocuments({ organizationId: orgId, expiresAt: { $gt: now }, role: { $nin: EDITOR_ROLES } }),
  ]);
  const wsEditors = new Set(wsEditorUserIds.map((id) => id.toString()));
  let seatMembers = 0;
  let viewerMembers = 0;
  for (const m of members) {
    const canEdit = EDITOR_ROLES.includes(m.role) || wsEditors.has(m.userId.toString());
    if (canEdit) seatMembers++;
    else viewerMembers++;
  }
  return {
    seatsUsed: seatMembers + seatInvites + 1, // +1: owner is always one seat
    viewersUsed: viewerMembers + viewerInvites,
  };
}

/** True if an invited/assigned role consumes an editor SEAT (vs a free viewer). */
function roleConsumesSeat(role) {
  return EDITOR_ROLES.includes(role);
}

module.exports = { getSeatUsage, roleConsumesSeat, EDITOR_ROLES };
