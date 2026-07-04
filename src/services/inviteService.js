/**
 * Invite lifecycle: create (+ email), validate, accept.
 *
 * Acceptance is shared by two callers:
 *   - POST /api/invites/accept (existing, logged-in user)
 *   - signup (email + Google) with an inviteToken — which SKIPS
 *     bootstrapNewUser so invited users don't get a stray personal org.
 */

const crypto = require('crypto');
const Invite = require('../models/Invite');
const Organization = require('../models/Organization');
const OrgMember = require('../models/OrgMember');
const WorkspaceMember = require('../models/WorkspaceMember');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const { applyCustomTemplate } = require('../controllers/emailPortalController');
const { sendEmail } = require('../utils/emailService');
const auditService = require('./auditService');
const domainService = require('./domainService');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Create (or replace) a pending invite and email the accept link.
 * Returns the invite doc. The raw token exists only in the emailed URL.
 */
async function createInvite({ org, email, role, accessScope, workspaceIds = [], invitedBy, inviterName }) {
  const normalizedEmail = email.trim().toLowerCase();
  const rawToken = crypto.randomBytes(32).toString('hex');

  // Re-inviting replaces the previous pending invite (fresh token + expiry)
  await Invite.deleteOne({ organizationId: org._id, email: normalizedEmail });

  const invite = await Invite.create({
    email: normalizedEmail,
    organizationId: org._id,
    role,
    accessScope,
    workspaceIds,
    tokenHash: Invite.hashToken(rawToken),
    invitedBy,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });

  // Invariant I1: tenant-facing links use the org's custom domain when active
  const baseUrl = await domainService.resolveBaseUrl(org._id);
  const acceptUrl = `${baseUrl}/accept-invite?token=${rawToken}`;

  const emailOptions = {
    to: normalizedEmail,
    orgId: org._id, // Phase 11 sender identity
    data: {
      inviterName: inviterName || 'A team member',
      orgName: org.name,
      role,
      acceptUrl,
    },
  };
  await applyCustomTemplate('member_invite', emailOptions, org._id);
  // Template resolution failing (transient DB error) must not send a
  // subject-less shell — the invite email IS the deliverable. Hardcoded
  // fallback mirrors the default template.
  if (!emailOptions.subject) {
    emailOptions.subject = `You've been invited to join ${org.name}`;
    emailOptions.html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:16px;">You're invited</h2>
  <p style="color:#555;font-size:16px;line-height:1.6;">${inviterName || 'A team member'} has invited you to join <strong>${org.name}</strong> as ${role}.</p>
  <div style="text-align:center;margin:32px 0;">
    <a href="${acceptUrl}" style="background:#111;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Accept invitation</a>
  </div>
  <p style="color:#888;font-size:14px;">This invitation expires in 7 days.</p>
</div>`;
    delete emailOptions.data;
  }
  await sendEmail(emailOptions);

  return invite;
}

function findValidInvite(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  return Invite.findValidByToken(rawToken);
}

/**
 * Convert an invite into a membership for `user`.
 * Caller must have verified that invite.email matches the user's email.
 *
 * Returns { org, alreadyMember, workspace } — `workspace` is the workspace
 * set as the user's active one (null when unchanged).
 */
async function acceptInvite(invite, user) {
  const org = await Organization.findById(invite.organizationId).lean();
  if (!org) {
    await Invite.deleteOne({ _id: invite._id });
    const err = new Error('The organization for this invite no longer exists');
    err.code = 'INVITE_ORG_GONE';
    throw err;
  }

  // Owner accepting their own org's invite — nothing to create
  if (org.ownerId.equals(user._id)) {
    await Invite.deleteOne({ _id: invite._id });
    return { org, alreadyMember: true, workspace: null };
  }

  let alreadyMember = false;
  try {
    await OrgMember.create({
      organizationId: org._id,
      ownerId: org.ownerId,
      userId: user._id,
      email: user.email,
      role: invite.accessScope === 'assigned' && invite.role === 'client' ? 'viewer' : invite.role,
      accessScope: invite.accessScope,
      status: 'active',
      invitedAt: invite.createdAt,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    alreadyMember = true; // keep their existing membership untouched
  }

  // Per-workspace grants (validate the workspaces still belong to the org —
  // they may have been deleted or moved since the invite was sent)
  let grantedWorkspaces = [];
  if (!alreadyMember && invite.accessScope === 'assigned' && invite.workspaceIds.length > 0) {
    grantedWorkspaces = await Workspace.find({
      _id: { $in: invite.workspaceIds },
      organizationId: org._id,
    })
      .select('_id')
      .lean();
    if (grantedWorkspaces.length > 0) {
      await WorkspaceMember.insertMany(
        grantedWorkspaces.map((ws) => ({
          workspaceId: ws._id,
          organizationId: org._id,
          userId: user._id,
          email: user.email,
          role: invite.role,
          status: 'active',
          invitedBy: invite.invitedBy,
        })),
        { ordered: false }
      ).catch((err) => {
        if (err.code !== 11000) throw err; // ignore duplicate grants
      });
    }
  }

  // Point the user at a workspace they can actually open
  let activeWorkspace = null;
  if (invite.accessScope === 'assigned') {
    activeWorkspace = grantedWorkspaces[0] || null;
  } else if (!user.activeWorkspaceId) {
    activeWorkspace =
      (await Workspace.findOne({ organizationId: org._id, isDefault: true }).select('_id').lean()) ||
      (await Workspace.findOne({ organizationId: org._id }).select('_id').lean());
  }
  if (activeWorkspace) {
    await User.updateOne({ _id: user._id }, { $set: { activeWorkspaceId: activeWorkspace._id } });
  }

  await Invite.deleteOne({ _id: invite._id });

  if (!alreadyMember) {
    auditService.record({
      organizationId: org._id,
      userId: user._id,
      actorEmail: user.email,
      action: 'member.join',
      resource: 'member',
      resourceId: user._id,
      meta: {
        email: user.email,
        role: invite.role,
        accessScope: invite.accessScope,
        via: 'invite',
      },
    });
  }

  return { org, alreadyMember, workspace: activeWorkspace };
}

module.exports = { createInvite, findValidInvite, acceptInvite, INVITE_TTL_MS };
