const User = require('../models/User');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');
const Workspace = require('../models/Workspace');
const mongoose = require('mongoose');
const Invite = require('../models/Invite');
const AuditLog = require('../models/AuditLog');
const inviteService = require('../services/inviteService');
const auditService = require('../services/auditService');

/** Audit shorthand for org-scoped member operations (fire-and-forget). */
function auditOrg(req, org, action, resourceId, meta) {
  auditService.record({
    organizationId: org._id,
    userId: req.user.userId,
    actorEmail: req.user.email,
    action,
    resourceId,
    meta,
    ip: req.ip,
    impersonatedBy: req.user.impersonatedBy || null,
  });
}
const Subscription = require('../models/Subscription');
const Role = require('../models/Role');
const FeatureFlag = require('../models/FeatureFlag');
const tierService = require('../services/tierService');
const seatService = require('../services/seatService');
const { ORG_CONFIG } = require('../scripts/configOrganization');

// ─── Helper: resolve org + check caller is owner/admin ──────

async function resolveOrgWithAccess(req, res, requireOwnerOrAdmin = false) {
  const { orgId } = req.params;
  if (!orgId) {
    res.status(400).json({ error: 'Organization ID is required' });
    return null;
  }

  const org = await Organization.findById(orgId).lean();
  if (!org) {
    res.status(404).json({ error: 'Organization not found' });
    return null;
  }

  const isOwner = org.ownerId.equals(req.user.userId);
  if (isOwner) return { org, callerRole: 'owner' };

  const membership = await OrgMember.findMembershipByOrg(org._id, req.user.userId);
  if (!membership) {
    res.status(403).json({ error: 'You do not have access to this organization' });
    return null;
  }

  const scope = membership.accessScope || 'all';
  if (requireOwnerOrAdmin && (membership.role !== 'admin' || scope === 'assigned')) {
    // Org-wide owner/admin operations (invite, changeRole, remove, scope,
    // workspace assignment, audit log) require FULL-org access. A workspace-
    // scoped ('assigned') admin manages only their assigned workspaces — they
    // must NOT run org-wide member/audit ops or self-escalate their own scope.
    // Mirrors the explicit assigned-caller guards in listMembers/listAuditLog.
    res.status(403).json({ error: 'Only organization owners or full-access admins can perform this action' });
    return null;
  }

  return { org, callerRole: membership.role, accessScope: scope };
}

// ─── LIST MEMBERS ────────────────────────────────────────────────
// GET /api/organizations/:orgId/members
// Returns the org owner + all org members with roles.

const listMembers = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res);
    if (!result) return;
    const { org, callerRole, accessScope } = result;

    // Scoped members (agency clients / restricted staff) must not
    // enumerate the org roster — they only ever see their own membership.
    if (accessScope === 'assigned' && callerRole !== 'owner') {
      return res
        .status(403)
        .json({ error: 'You do not have access to the member list' });
    }

    const members = await OrgMember.find({ organizationId: org._id })
      .sort({ createdAt: 1 })
      .lean();

    // Workspace assignments per member (for accessScope 'assigned' rows)
    const assignments = await WorkspaceMember.find({ organizationId: org._id })
      .select('userId workspaceId role')
      .lean();
    const assignmentsByUser = {};
    for (const a of assignments) {
      const key = a.userId.toString();
      if (!assignmentsByUser[key]) assignmentsByUser[key] = [];
      assignmentsByUser[key].push({ workspaceId: a.workspaceId, role: a.role });
    }

    // ── Enforce seat-based locking based on current tier ──
    const { config } = await tierService.getOrgTierConfig(org._id);
    let effectiveMaxSeats = null;
    if (config?.maxSeats != null) {
      const sub = await Subscription.findOne({
        organizationId: org._id,
        status: { $in: ['active', 'trialing'] },
      }).lean();
      const extraSeats = sub?.purchasedExtraSeats || 0;
      effectiveMaxSeats = config.maxSeats + extraSeats;
    }
    // Owner takes 1 seat (implicit, not in OrgMember)
    const memberSlots = effectiveMaxSeats != null ? Math.max(0, effectiveMaxSeats - 1) : null;
    const clientViewersCap = config?.clientViewers; // null/undefined = unlimited

    // Phase 9: lock excess per SEAT CLASS, oldest-first (members are createdAt-
    // asc), independently — editor seats (admin/editor) against maxSeats, client
    // viewers (viewer/client) against clientViewers. Split by ROLE (who can edit),
    // consistent with seatService + downgradeService.lockMembers, so a free client
    // viewer never counts against an editor seat (and an assigned editor does).
    const isViewer = (m) => !seatService.roleConsumesSeat(m.role);
    const lockedIds = new Set();
    let seatIdx = 0;
    let viewerIdx = 0;
    for (const m of members) {
      if (isViewer(m)) {
        if (clientViewersCap != null && viewerIdx >= clientViewersCap) lockedIds.add(m._id.toString());
        viewerIdx++;
      } else {
        if (memberSlots != null && seatIdx >= memberSlots) lockedIds.add(m._id.toString());
        seatIdx++;
      }
    }

    // Populate user info for each member
    const userIds = members.map((m) => m.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select('email profile.name profile.picture')
      .lean();
    const userMap = {};
    for (const u of users) {
      userMap[u._id.toString()] = u;
    }

    // Persist lock state to DB if it differs from computed state
    {
      const toLock = [];
      const toUnlock = [];
      for (const m of members) {
        const shouldLock = lockedIds.has(m._id.toString());
        if (shouldLock && !m.locked) toLock.push(m._id);
        if (!shouldLock && m.locked) toUnlock.push(m._id);
      }
      if (toLock.length > 0) {
        await OrgMember.updateMany({ _id: { $in: toLock } }, { $set: { locked: true } });
      }
      if (toUnlock.length > 0) {
        await OrgMember.updateMany({ _id: { $in: toUnlock } }, { $set: { locked: false } });
      }
    }

    const enriched = members.map((m) => {
      const u = userMap[m.userId.toString()];
      const locked = lockedIds.has(m._id.toString());
      return {
        _id: m._id,
        userId: m.userId,
        // Prefer the live User.email — OrgMember.email is denormalized at
        // invite time and goes stale when the user later changes their
        // email via Profile settings.
        email: u?.email || m.email,
        name: u?.profile?.name || '',
        picture: u?.profile?.picture || '',
        role: m.role,
        status: m.status,
        locked,
        invitedAt: m.invitedAt,
        accessScope: m.accessScope || 'all',
        workspaceAssignments: assignmentsByUser[m.userId.toString()] || [],
      };
    });

    // Pending invites (not yet accepted; expired ones are TTL-deleted)
    const pendingInvites = await Invite.find({
      organizationId: org._id,
      expiresAt: { $gt: new Date() },
    })
      .select('email role accessScope workspaceIds expiresAt createdAt')
      .sort({ createdAt: 1 })
      .lean();

    // Get owner info
    const owner = await User.findById(org.ownerId)
      .select('email profile.name profile.picture')
      .lean();

    res.json({
      organization: { _id: org._id, name: org.name, slug: org.slug },
      invites: pendingInvites,
      owner: {
        userId: org.ownerId,
        email: owner?.email || '',
        name: owner?.profile?.name || '',
        picture: owner?.profile?.picture || '',
        role: 'owner',
      },
      members: enriched,
    });
  } catch (error) {
    console.error('List org members error:', error);
    res.status(500).json({ error: 'Failed to list members' });
  }
};

// ─── INVITE MEMBER ───────────────────────────────────────────────
// POST /api/organizations/:orgId/members
// Body: { email, role, accessScope?, workspaceIds? }
//   accessScope 'all' (default): role applies org-wide.
//   accessScope 'assigned': access limited to workspaceIds (required);
//   role is applied per-workspace via WorkspaceMember rows, and may be
//   'client' (external client access — never valid org-wide).

const ORG_WIDE_ROLES = ['admin', 'editor', 'viewer'];
const WORKSPACE_ROLES = ['admin', 'editor', 'viewer', 'client'];

/**
 * Validates that every id in workspaceIds is a workspace of this org.
 * Returns the workspace docs, or null after writing the error response.
 */
async function resolveOrgWorkspaces(res, orgId, workspaceIds) {
  if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) {
    res.status(400).json({ error: 'workspaceIds is required for assigned access' });
    return null;
  }
  const workspaces = await Workspace.find({
    _id: { $in: workspaceIds },
    organizationId: orgId,
  })
    .select('_id')
    .lean();
  if (workspaces.length !== new Set(workspaceIds.map(String)).size) {
    res.status(400).json({ error: 'One or more workspaces do not belong to this organization' });
    return null;
  }
  return workspaces;
}

const inviteMember = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org, callerRole } = result;

    const { email, role, workspaceIds } = req.body;
    const accessScope = req.body.accessScope === 'assigned' ? 'assigned' : 'all';
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const validRoles = accessScope === 'assigned' ? WORKSPACE_ROLES : ORG_WIDE_ROLES;
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    // Phase 10 — "Admin grants ≤ Editor": inviting an admin grants the admin role,
    // so it is Owner-only, same as changeRole. A non-owner admin may invite
    // editor/viewer/client but not another admin.
    if (callerRole !== 'owner' && role === 'admin') {
      return res.status(403).json({
        error: 'Only the organization owner can grant the admin role.',
        code: 'OWNER_ONLY',
      });
    }

    let grantedWorkspaces = null;
    if (accessScope === 'assigned') {
      grantedWorkspaces = await resolveOrgWorkspaces(res, org._id, workspaceIds);
      if (!grantedWorkspaces) return;
    }

    // v4.1 seat model (Phase 9): an admin/editor invite consumes an EDITOR SEAT
    // (maxSeats + purchased extra); a viewer/client invite is a FREE CLIENT
    // VIEWER (clientViewers cap) and does NOT consume a seat. The split is by
    // ROLE (who can edit), NOT accessScope — an assigned workspace-editor is a
    // seat, not a free viewer. Counts include pending invites (via seatService).
    const { config, tier } = await tierService.getOrgTierConfig(org._id);
    const { seatsUsed, viewersUsed } = await seatService.getSeatUsage(org._id);
    if (!seatService.roleConsumesSeat(role)) {
      // Free client viewer — separate cap (null = unlimited, e.g. Agency).
      if (config?.clientViewers != null && viewersUsed >= config.clientViewers) {
        return res.status(429).json({
          error: `Your ${config.displayName || tier} plan allows ${config.clientViewers} client viewer(s).`,
          code: 'QUOTA_EXCEEDED',
          quota: { limit: config.clientViewers, used: viewersUsed, tier, limitKey: 'clientViewers' },
        });
      }
    } else if (config?.maxSeats != null) {
      const sub = await Subscription.findOne({
        organizationId: org._id,
        status: { $in: ['active', 'trialing'] },
      }).lean();
      const extraSeats = sub?.purchasedExtraSeats || 0;
      const effectiveMaxSeats = config.maxSeats + extraSeats;
      if (seatsUsed >= effectiveMaxSeats) {
        return res.status(429).json({
          error: `Your ${config.displayName || tier} plan allows ${effectiveMaxSeats} seat(s).${extraSeats > 0 ? '' : ' Upgrade or purchase extra seats for more.'}`,
          code: 'QUOTA_EXCEEDED',
          quota: { limit: effectiveMaxSeats, used: seatsUsed, tier, limitKey: 'maxSeats' },
        });
      }
    }

    const targetUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (!targetUser) {
      // No account yet — create a pending invite and email the accept link.
      const inviter = await User.findById(req.user.userId).select('profile.name email').lean();
      const invite = await inviteService.createInvite({
        org,
        email,
        role,
        accessScope,
        workspaceIds: accessScope === 'assigned' ? grantedWorkspaces.map((ws) => ws._id) : [],
        invitedBy: req.user.userId,
        inviterName: inviter?.profile?.name || inviter?.email,
      });
      auditOrg(req, org, 'invite.send', invite._id, {
        email: invite.email,
        role,
        accessScope,
        workspaceCount: invite.workspaceIds.length,
      });
      return res.status(201).json({
        invite: {
          _id: invite._id,
          email: invite.email,
          role: invite.role,
          accessScope: invite.accessScope,
          workspaceIds: invite.workspaceIds,
          status: 'invited',
          expiresAt: invite.expiresAt,
        },
      });
    }
    if (targetUser._id.equals(org.ownerId)) {
      return res.status(400).json({ error: 'Cannot invite the organization owner' });
    }

    // Check if already a member of this org
    const existing = await OrgMember.findOne({
      organizationId: org._id,
      userId: targetUser._id,
    });
    if (existing) {
      return res.status(409).json({ error: 'This user is already a member' });
    }

    const member = await OrgMember.create({
      organizationId: org._id,
      ownerId: org.ownerId,
      userId: targetUser._id,
      email: targetUser.email,
      // 'client' is a workspace-level role only; the org-level row for a
      // scoped member is floored to 'viewer' (it grants nothing by itself).
      role: accessScope === 'assigned' && role === 'client' ? 'viewer' : role,
      accessScope,
      status: 'active',
      invitedAt: new Date(),
    });

    if (accessScope === 'assigned') {
      await WorkspaceMember.insertMany(
        grantedWorkspaces.map((ws) => ({
          workspaceId: ws._id,
          organizationId: org._id,
          userId: targetUser._id,
          email: targetUser.email,
          role,
          status: 'active',
          invitedBy: req.user.userId,
        }))
      );
    }

    // Notify the (existing) user — membership is already active, the link
    // just takes them to the app. Fire-and-forget.
    try {
      const inviter = await User.findById(req.user.userId).select('profile.name email').lean();
      const { applyCustomTemplate } = require('./emailPortalController');
      const { sendEmail } = require('../utils/emailService');
      // Invariant I1: tenant-facing links use the org's custom domain when active
      const baseUrl = await require('../services/domainService').resolveBaseUrl(org._id);
      const { htmlEscape, subjectSafe } = require('../utils/htmlEscape');
      // Escaped for the same reason as inviteService.createInvite: inviterName
      // and orgName are free text controlled by the sender, applyCustomTemplate
      // substitutes them raw, and the recipient is someone else. See the note
      // there for the full rationale.
      const emailOptions = {
        to: targetUser.email,
        orgId: org._id, // Phase 11 sender identity
        data: {
          inviterName: htmlEscape(inviter?.profile?.name || inviter?.email || 'A team member'),
          orgName: htmlEscape(org.name),
          role: htmlEscape(role),
          acceptUrl: htmlEscape(`${baseUrl}/login`),
        },
      };
      await applyCustomTemplate('member_invite', emailOptions, org._id);
      // The default subject embeds {{orgName}}, so decode entities back for the
      // plain-text Subject header.
      if (emailOptions.subject) emailOptions.subject = subjectSafe(emailOptions.subject);
      // Template resolution can fail transiently — never dispatch a
      // subject-less shell (this notification is best-effort anyway)
      if (emailOptions.subject) {
        sendEmail(emailOptions).catch((err) =>
          console.error('[invite] notification email failed:', err.message)
        );
      }
    } catch (err) {
      console.error('[invite] notification email failed:', err.message);
    }

    auditOrg(req, org, 'member.add', targetUser._id, {
      email: targetUser.email,
      role,
      accessScope,
    });
    res.status(201).json({
      member: {
        _id: member._id,
        userId: targetUser._id,
        email: targetUser.email,
        name: targetUser.profile?.name || '',
        picture: targetUser.profile?.picture || '',
        role: member.role,
        status: member.status,
        invitedAt: member.invitedAt,
        accessScope,
        workspaceAssignments:
          accessScope === 'assigned'
            ? grantedWorkspaces.map((ws) => ({ workspaceId: ws._id, role }))
            : [],
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'This user is already a member' });
    }
    console.error('Invite org member error:', error);
    res.status(500).json({ error: 'Failed to invite member' });
  }
};

// ─── CHANGE ROLE ─────────────────────────────────────────────────
// PUT /api/organizations/:orgId/members/:memberId/role
// Body: { role }

const changeRole = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org, callerRole } = result;

    const { memberId } = req.params;
    const { role } = req.body;

    const validRoles = ['admin', 'editor', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }

    const member = await OrgMember.findOne({
      _id: memberId,
      organizationId: org._id,
    });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Phase 10 — "Admin grants ≤ Editor": ADMIN management is Owner-only. A
    // non-owner admin may assign editor/viewer but must NOT grant the admin role
    // (privilege escalation) nor modify an existing admin (incl. demoting a peer
    // or the owner-appointed admin). Only the Owner administers admins.
    if (callerRole !== 'owner' && (role === 'admin' || member.role === 'admin')) {
      return res.status(403).json({
        error: 'Only the organization owner can grant or modify the admin role.',
        code: 'OWNER_ONLY',
      });
    }

    // Phase 9: PROMOTING a free viewer/client to an editor seat consumes a seat —
    // enforce the same cap as invite, else the seat limit is trivially bypassed
    // (invite cheap as viewer → promote to editor for free). Only guard the
    // viewer→seat transition; demotions and lateral seat changes are unaffected.
    if (seatService.roleConsumesSeat(role) && !seatService.roleConsumesSeat(member.role) && !member.locked) {
      const { config, tier } = await tierService.getOrgTierConfig(org._id);
      if (config?.maxSeats != null) {
        const sub = await Subscription.findOne({
          organizationId: org._id,
          status: { $in: ['active', 'trialing'] },
        }).lean();
        const effectiveMaxSeats = config.maxSeats + (sub?.purchasedExtraSeats || 0);
        // seatsUsed excludes this member (still a viewer) — a full seat count
        // means there's no room to promote them into.
        const { seatsUsed } = await seatService.getSeatUsage(org._id);
        if (seatsUsed >= effectiveMaxSeats) {
          return res.status(429).json({
            error: `Your ${config.displayName || tier} plan allows ${effectiveMaxSeats} seat(s). Purchase an extra seat or free one before promoting.`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: effectiveMaxSeats, used: seatsUsed, tier, limitKey: 'maxSeats' },
          });
        }
      }
    }

    member.role = role;
    await member.save();

    auditOrg(req, org, 'member.change_role', member.userId, { email: member.email, role });
    res.json({ member: { _id: member._id, userId: member.userId, role: member.role } });
  } catch (error) {
    console.error('Change role error:', error);
    res.status(500).json({ error: 'Failed to change role' });
  }
};

// ─── REMOVE MEMBER ───────────────────────────────────────────────
// DELETE /api/organizations/:orgId/members/:memberId

const removeMember = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org, callerRole } = result;

    const { memberId } = req.params;

    const member = await OrgMember.findOne({
      _id: memberId,
      organizationId: org._id,
    });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Phase 10 — "only the Owner administers admins": removing an admin is a
    // strictly-more-destructive form of modifying one, so a non-owner admin may
    // not remove an admin peer (mirrors the changeRole guard).
    if (callerRole !== 'owner' && member.role === 'admin') {
      return res.status(403).json({
        error: 'Only the organization owner can remove an admin.',
        code: 'OWNER_ONLY',
      });
    }

    await member.deleteOne();

    // Remove any per-workspace grants along with the membership
    await WorkspaceMember.deleteMany({
      organizationId: org._id,
      userId: member.userId,
    });

    auditOrg(req, org, 'member.remove', member.userId, { email: member.email });
    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Remove org member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

// ─── REVOKE INVITE ───────────────────────────────────────────────
// DELETE /api/org/organizations/:orgId/invites/:inviteId

const revokeInvite = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org } = result;

    const invite = await Invite.findOneAndDelete({
      _id: req.params.inviteId,
      organizationId: org._id,
    });
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    auditOrg(req, org, 'invite.revoke', invite._id, { email: invite.email });
    res.json({ message: 'Invite revoked' });
  } catch (error) {
    console.error('Revoke invite error:', error);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
};

// ─── UPDATE MEMBER SCOPE ─────────────────────────────────────────
// PUT /api/organizations/:orgId/members/:memberId/scope
// Body: { accessScope: 'all' | 'assigned' }
// Switching to 'all' keeps any WorkspaceMember rows (inert but preserved,
// so switching back restores the previous assignments).

const updateMemberScope = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org, callerRole } = result;

    const { memberId } = req.params;
    const { accessScope } = req.body;
    if (!['all', 'assigned'].includes(accessScope)) {
      return res.status(400).json({ error: "accessScope must be 'all' or 'assigned'" });
    }

    const member = await OrgMember.findOne({ _id: memberId, organizationId: org._id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Phase 10 — "only the Owner administers admins": re-scoping an admin is
    // modifying an admin. Critically, flipping an assigned admin to 'all' would
    // undo the assigned-admin isolation guard — so it is Owner-only.
    if (callerRole !== 'owner' && member.role === 'admin') {
      return res.status(403).json({
        error: 'Only the organization owner can change an admin\'s access scope.',
        code: 'OWNER_ONLY',
      });
    }

    member.accessScope = accessScope;
    await member.save();

    auditOrg(req, org, 'member.change_scope', member.userId, { email: member.email, accessScope });
    res.json({
      member: { _id: member._id, userId: member.userId, role: member.role, accessScope },
    });
  } catch (error) {
    console.error('Update member scope error:', error);
    res.status(500).json({ error: 'Failed to update member scope' });
  }
};

// ─── SET MEMBER WORKSPACES ───────────────────────────────────────
// PUT /api/organizations/:orgId/members/:memberId/workspaces
// Body: { assignments: [{ workspaceId, role }] }
// Replace-all semantics: grants not in the list are removed.

const setMemberWorkspaces = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org, callerRole } = result;

    const { memberId } = req.params;
    const { assignments } = req.body;
    if (!Array.isArray(assignments)) {
      return res.status(400).json({ error: 'assignments must be an array' });
    }
    // Phase 10 — "Admin grants ≤ Editor" at workspace scope too: a per-workspace
    // 'admin' grant makes the member resolve as workspaceRole 'admin' there
    // (unlocking admin-tier actions), so granting it is Owner-only — mirrors the
    // changeRole/inviteMember guard, which would otherwise be bypassable here.
    if (callerRole !== 'owner' && assignments.some((a) => a?.role === 'admin')) {
      return res.status(403).json({
        error: 'Only the organization owner can grant the admin role.',
        code: 'OWNER_ONLY',
      });
    }
    for (const a of assignments) {
      if (!a?.workspaceId || !WORKSPACE_ROLES.includes(a.role)) {
        return res.status(400).json({
          error: `Each assignment needs a workspaceId and a role (one of: ${WORKSPACE_ROLES.join(', ')})`,
        });
      }
    }

    const member = await OrgMember.findOne({ _id: memberId, organizationId: org._id });
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Phase 10 — "only the Owner administers admins": setting an admin's workspace
    // grants IS modifying an admin. Without this, a non-owner admin could pass an
    // empty/viewer-only assignment list for an assigned-scope admin target — the
    // guard above only inspects the assignments, not the target — and the seat sync
    // below would demote OrgMember.role admin→viewer while deleteMany strips every
    // grant, locking the admin peer out. Owner-only, mirroring the sibling handlers.
    if (callerRole !== 'owner' && member.role === 'admin') {
      return res.status(403).json({
        error: 'Only the organization owner can change an admin\'s workspace assignments.',
        code: 'OWNER_ONLY',
      });
    }

    if (assignments.length > 0) {
      const valid = await resolveOrgWorkspaces(
        res,
        org._id,
        assignments.map((a) => a.workspaceId)
      );
      if (!valid) return;
    }

    // Phase 9: an assigned member's SEAT CLASS follows their workspace grants —
    // any admin/editor grant makes them edit-capable (an editor seat); all
    // view-only grants (viewer/client) keep them a free client viewer. Keep
    // OrgMember.role in sync so seat counting stays accurate, and enforce the
    // seat cap when this PROMOTES a free member into a seat — otherwise the seat
    // limit is bypassable by assigning a cheap viewer an editor workspace role.
    let syncedRole = member.role;
    if ((member.accessScope || 'all') === 'assigned') {
      const grantsEdit = assignments.some((a) => seatService.roleConsumesSeat(a.role));
      const wasSeat = seatService.roleConsumesSeat(member.role);
      if (grantsEdit && !wasSeat) {
        if (!member.locked) {
          const { config, tier } = await tierService.getOrgTierConfig(org._id);
          if (config?.maxSeats != null) {
            const sub = await Subscription.findOne({
              organizationId: org._id,
              status: { $in: ['active', 'trialing'] },
            }).lean();
            const effectiveMaxSeats = config.maxSeats + (sub?.purchasedExtraSeats || 0);
            const { seatsUsed } = await seatService.getSeatUsage(org._id);
            if (seatsUsed >= effectiveMaxSeats) {
              return res.status(429).json({
                error: `Your ${config.displayName || tier} plan allows ${effectiveMaxSeats} seat(s). Purchase an extra seat or free one first.`,
                code: 'QUOTA_EXCEEDED',
                quota: { limit: effectiveMaxSeats, used: seatsUsed, tier, limitKey: 'maxSeats' },
              });
            }
          }
        }
        syncedRole = 'editor';
      } else if (!grantsEdit && wasSeat) {
        syncedRole = 'viewer'; // no longer edit-capable → frees the seat
      }
    }

    // Replace-all: upsert the given grants, remove the rest
    const keepIds = assignments.map((a) => a.workspaceId);
    await WorkspaceMember.deleteMany({
      organizationId: org._id,
      userId: member.userId,
      workspaceId: { $nin: keepIds },
    });
    for (const a of assignments) {
      await WorkspaceMember.updateOne(
        { workspaceId: a.workspaceId, userId: member.userId },
        {
          $set: { role: a.role, status: 'active' },
          $setOnInsert: {
            organizationId: org._id,
            email: member.email,
            invitedBy: req.user.userId,
          },
        },
        { upsert: true }
      );
    }

    // Persist the synced seat class (see above) so OrgMember.role tracks the
    // member's effective edit capability for seat counting.
    if (syncedRole !== member.role) {
      member.role = syncedRole;
      await member.save();
    }

    auditOrg(req, org, 'member.set_workspaces', member.userId, {
      email: member.email,
      workspaceCount: assignments.length,
    });
    res.json({
      member: {
        _id: member._id,
        userId: member.userId,
        accessScope: member.accessScope || 'all',
        workspaceAssignments: assignments,
      },
    });
  } catch (error) {
    console.error('Set member workspaces error:', error);
    res.status(500).json({ error: 'Failed to update workspace assignments' });
  }
};

// ─── AUDIT LOG ───────────────────────────────────────────────────
// GET /api/org/organizations/:orgId/audit-log
//   ?limit=&before=&beforeId=&action=&workspaceId=
// Owner or org-wide admin only — scoped ('assigned') members must not
// see other clients' activity. Cursor pagination via (before, beforeId)
// from the last entry of the previous page; _id breaks same-millisecond
// ties so no entry is ever skipped. `action` without a dot filters by
// resource ('member' → all member.*), with a dot matches exactly.

const listAuditLog = async (req, res) => {
  try {
    const result = await resolveOrgWithAccess(req, res, true);
    if (!result) return;
    const { org, callerRole, accessScope } = result;

    // Same isolation rule as listMembers: assigned-scope members —
    // even admins — must not read org-wide data across client workspaces.
    if (accessScope === 'assigned' && callerRole !== 'owner') {
      return res
        .status(403)
        .json({ error: 'You do not have access to the activity log' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const filter = { organizationId: org._id };

    // Cursor: strictly-older createdAt, OR same createdAt with smaller _id
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!Number.isNaN(before.getTime())) {
        const beforeId = req.query.beforeId;
        if (beforeId && mongoose.Types.ObjectId.isValid(String(beforeId))) {
          filter.$or = [
            { createdAt: { $lt: before } },
            { createdAt: before, _id: { $lt: new mongoose.Types.ObjectId(String(beforeId)) } },
          ];
        } else {
          filter.createdAt = { $lt: before };
        }
      }
    }

    if (req.query.action) {
      const action = String(req.query.action);
      if (action.includes('.')) {
        filter.action = action; // exact match, e.g. 'member.add'
      } else {
        // Category filter — every entry's resource equals its action prefix
        filter.resource = action;
      }
    }

    if (req.query.workspaceId) {
      const wsId = String(req.query.workspaceId);
      if (!mongoose.Types.ObjectId.isValid(wsId)) {
        return res.status(400).json({ error: 'Invalid workspaceId' });
      }
      filter.workspaceId = wsId;
    }

    // Fetch one extra to compute hasMore without a count query
    const entries = await AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = entries.length > limit;
    if (hasMore) entries.pop();

    res.json({ entries, hasMore });
  } catch (error) {
    console.error('List audit log error:', error);
    res.status(500).json({ error: 'Failed to load activity' });
  }
};

// ─── LIST ROLES ──────────────────────────────────────────────────
// GET /api/org/roles — returns available roles for assignment

const listRoles = async (req, res) => {
  try {
    const roles = await Role.find({ isSystem: true })
      .sort({ level: 1 })
      .select('name displayName description level')
      .lean();
    // Exclude 'owner' — it's implicit, not assignable
    res.json({ roles: roles.filter((r) => r.name !== 'owner') });
  } catch (error) {
    console.error('List roles error:', error);
    res.status(500).json({ error: 'Failed to list roles' });
  }
};

// ─── LIST FEATURE FLAGS ─────────────────────────────────────────
// GET /api/org/feature-flags — returns enabled flags for frontend

const listFeatureFlags = async (req, res) => {
  try {
    const flags = await FeatureFlag.find({ enabled: true })
      .select('key displayName description implemented conditions')
      .lean();
    res.json({ flags });
  } catch (error) {
    console.error('List feature flags error:', error);
    res.status(500).json({ error: 'Failed to list feature flags' });
  }
};

// ─── TRANSFER OWNERSHIP ─────────────────────────────────────────
// POST /api/organizations/:orgId/transfer-ownership
// Body: { newOwnerMemberId, selfRole }
// Only the current owner can transfer ownership.

const transferOwnership = async (req, res) => {
  try {
    const { orgId } = req.params;
    const { newOwnerMemberId, selfRole } = req.body;

    const org = await Organization.findById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    // Only current owner can transfer
    if (!org.ownerId.equals(req.user.userId)) {
      return res.status(403).json({ error: 'Only the owner can transfer ownership' });
    }

    const validRoles = ['admin', 'editor', 'viewer'];
    if (!validRoles.includes(selfRole)) {
      return res.status(400).json({ error: `selfRole must be one of: ${validRoles.join(', ')}` });
    }

    // Find the successor member
    const successor = await OrgMember.findOne({ _id: newOwnerMemberId, organizationId: org._id });
    if (!successor) return res.status(404).json({ error: 'Successor member not found' });

    const successorUserId = successor.userId;
    const oldOwnerId = org.ownerId;

    // ── Block transfer to users with pending account deletion ──
    const successorUser = await User.findById(successorUserId).select('status').lean();
    if (successorUser?.status === 'pending_deletion') {
      return res.status(400).json({ error: 'Cannot transfer ownership to a user with pending account deletion' });
    }

    // ── Check if successor can own another org (global limit from configOrganization.js) ──
    const maxOrgs = ORG_CONFIG.maxOrganizationsPerUser;
    if (maxOrgs != null) {
      const successorOwnedCount = await Organization.countDocuments({ ownerId: successorUserId });
      if (successorOwnedCount >= maxOrgs) {
        return res.status(429).json({
          error: `The new owner already owns ${successorOwnedCount} organization(s). The limit is ${maxOrgs}.`,
          code: 'QUOTA_EXCEEDED',
          quota: { limit: maxOrgs, used: successorOwnedCount, limitKey: 'maxOrganizationsPerUser' },
        });
      }
    }

    // 1. Update org owner to successor
    org.ownerId = successorUserId;
    await org.save();

    // 2. Remove successor's OrgMember record (owner is implicit, not in OrgMember)
    await OrgMember.findByIdAndDelete(successor._id);

    // 3. Create OrgMember record for the old owner with their chosen role
    const oldOwnerUser = await User.findById(oldOwnerId).select('email').lean();
    await OrgMember.create({
      organizationId: org._id,
      ownerId: successorUserId,
      userId: oldOwnerId,
      email: oldOwnerUser?.email || '',
      role: selfRole,
      status: 'active',
      invitedAt: new Date(),
    });

    auditOrg(req, org, 'org.transfer_ownership', successorUserId, {
      newOwnerEmail: successor.email,
      oldOwnerRole: selfRole,
    });
    res.json({ message: 'Ownership transferred successfully' });
  } catch (error) {
    console.error('Transfer ownership error:', error);
    res.status(500).json({ error: 'Failed to transfer ownership' });
  }
};

// ─── LEAVE ORGANIZATION ─────────────────────────────────────
const leaveOrganization = async (req, res) => {
  try {
    const { orgId } = req.params;
    const org = await Organization.findById(orgId).lean();
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Owner cannot leave — must transfer ownership first
    if (org.ownerId.equals(req.user.userId)) {
      return res.status(400).json({
        error: 'As the owner, you must transfer ownership before leaving the organization.',
      });
    }

    const membership = await OrgMember.findOne({
      organizationId: org._id,
      userId: req.user.userId,
    });
    if (!membership) {
      return res.status(404).json({ error: 'You are not a member of this organization' });
    }

    await OrgMember.findByIdAndDelete(membership._id);
    await WorkspaceMember.deleteMany({
      organizationId: org._id,
      userId: req.user.userId,
    });
    auditOrg(req, org, 'member.leave', req.user.userId, { email: membership.email });
    res.json({ message: 'You have left the organization' });
  } catch (error) {
    console.error('Leave organization error:', error);
    res.status(500).json({ error: 'Failed to leave organization' });
  }
};

module.exports = { resolveOrgWithAccess, listMembers, inviteMember, changeRole, removeMember, revokeInvite, updateMemberScope, setMemberWorkspaces, listAuditLog, listRoles, listFeatureFlags, transferOwnership, leaveOrganization };
