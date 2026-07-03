const User = require('../models/User');
const Organization = require('../models/Organization');
const inviteService = require('../services/inviteService');

// ─── LOOKUP INVITE ───────────────────────────────────────────────
// GET /api/invites/lookup?token=...   (public — the token IS the auth)
// Powers the /accept-invite page before the user is logged in.

const lookupInvite = async (req, res) => {
  try {
    const invite = await inviteService.findValidInvite(req.query.token);
    if (!invite) {
      return res.status(404).json({ error: 'This invite is invalid or has expired' });
    }

    const org = await Organization.findById(invite.organizationId).select('name').lean();
    const userExists = !!(await User.exists({ email: invite.email }));

    res.json({
      email: invite.email,
      orgName: org?.name || 'an organization',
      role: invite.role,
      accessScope: invite.accessScope,
      workspaceCount: invite.workspaceIds.length,
      userExists,
      expiresAt: invite.expiresAt,
    });
  } catch (error) {
    console.error('Lookup invite error:', error);
    res.status(500).json({ error: 'Failed to look up invite' });
  }
};

// ─── ACCEPT INVITE ───────────────────────────────────────────────
// POST /api/invites/accept  (authenticated)  Body: { token }
// For logged-in users; signup-time acceptance lives in authController.

const acceptInvite = async (req, res) => {
  try {
    const invite = await inviteService.findValidInvite(req.body.token);
    if (!invite) {
      return res.status(404).json({ error: 'This invite is invalid or has expired' });
    }

    const user = await User.findById(req.user.userId).select('email activeWorkspaceId').lean();
    if (!user || user.email !== invite.email) {
      return res.status(403).json({
        error: 'This invite was sent to a different email address. Log in with the invited email to accept it.',
        code: 'INVITE_EMAIL_MISMATCH',
      });
    }

    const result = await inviteService.acceptInvite(invite, user);

    res.json({
      organization: { _id: result.org._id, name: result.org.name },
      alreadyMember: result.alreadyMember,
      activeWorkspaceId: result.workspace?._id || user.activeWorkspaceId || null,
    });
  } catch (error) {
    if (error.code === 'INVITE_ORG_GONE') {
      return res.status(410).json({ error: error.message });
    }
    console.error('Accept invite error:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
};

module.exports = { lookupInvite, acceptInvite };
