const Permission = require('../models/Permission');

// ─── Permission matrix — SOURCE OF TRUTH ────────────────────────────
// Synced to database on every server startup.
// Format: [resource, action, owner, admin, editor, viewer, client]
// true = allowed, false = denied
// 'client' = external agency-client access (white-label): read + comment
// on assigned workspaces only; no editing, AI usage, or team visibility.

const MATRIX = [
  // Workspace
  ['workspace', 'create', true, true, false, false, false],
  ['workspace', 'read', true, true, true, true, true],
  ['workspace', 'delete', true, false, false, false, false],

  // Members
  ['members', 'read', true, true, true, true, false],
  ['members', 'manage', true, true, false, false, false],
  ['members', 'changeRole', true, true, false, false, false],

  // Content
  ['content', 'read', true, true, true, true, true],
  ['content', 'create', true, true, true, false, false],
  ['content', 'update', true, true, true, false, false],
  ['content', 'delete', true, true, true, false, false],
  ['content', 'comment', true, true, true, true, true],

  // Analysis & AI
  ['analysis', 'read', true, true, true, true, true],
  ['analysis', 'use', true, true, true, false, false],
  ['aiChat', 'use', true, true, true, false, false],

  // AI Tracker
  ['aiTracker', 'read', true, true, true, true, true],
  ['aiTracker', 'manage', true, true, false, false, false],
  ['aiTracker', 'use', true, true, true, false, false],

  // Keywords
  ['keywords', 'read', true, true, true, true, true],
  ['keywords', 'use', true, true, true, false, false],
  ['keywords', 'delete', true, true, true, false, false],

  // Billing
  ['billing', 'manage', true, false, false, false, false],

  // Brand Voice (not in user's matrix — defaulting to content-like access)
  ['brandVoice', 'read', true, true, true, true, false],
  ['brandVoice', 'manage', true, true, false, false, false],

  // Sites / GSC
  ['sites', 'read', true, true, true, true, false],
  ['sites', 'manage', true, true, false, false, false],

  // Sitemap Crawler
  ['sitemap', 'read', true, true, true, true, false],
  ['sitemap', 'manage', true, true, false, false, false],
  ['sitemap', 'use', true, true, true, false, false],
];

const ROLE_NAMES = ['owner', 'admin', 'editor', 'viewer', 'client'];

async function syncPermissions() {
  let upserted = 0;
  let updated = 0;

  // Build set of valid keys for cleanup
  const validKeys = new Set();

  for (const [resource, action, ...roleFlags] of MATRIX) {
    for (let i = 0; i < ROLE_NAMES.length; i++) {
      const role = ROLE_NAMES[i];
      const allowed = roleFlags[i];
      validKeys.add(`${role}:${resource}:${action}`);

      const result = await Permission.updateOne(
        { role, resource, action },
        { $set: { role, resource, action, allowed } },
        { upsert: true }
      );
      if (result.upsertedCount > 0) upserted++;
      else if (result.modifiedCount > 0) updated++;
    }
  }

  // Remove permissions no longer in config
  const allPerms = await Permission.find({}).select('role resource action').lean();
  const staleIds = allPerms
    .filter((p) => !validKeys.has(`${p.role}:${p.resource}:${p.action}`))
    .map((p) => p._id);
  let removedCount = 0;
  if (staleIds.length > 0) {
    const removed = await Permission.deleteMany({ _id: { $in: staleIds } });
    removedCount = removed.deletedCount;
  }

  console.log(`[syncPermissions] ${upserted} created, ${updated} updated, ${removedCount} removed`);
}

module.exports = { syncPermissions, MATRIX, ROLE_NAMES };
