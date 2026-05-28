const Permission = require('../models/Permission');

// ─── Permission matrix — SOURCE OF TRUTH ────────────────────────────
// Synced to database on every server startup.
// Format: [resource, action, owner, admin, editor, viewer]
// true = allowed, false = denied

const MATRIX = [
  // Workspace
  ['workspace', 'create', true, true, false, false],
  ['workspace', 'read', true, true, true, true],
  ['workspace', 'delete', true, false, false, false],

  // Members
  ['members', 'read', true, true, true, true],
  ['members', 'manage', true, true, false, false],
  ['members', 'changeRole', true, true, false, false],

  // Content
  ['content', 'read', true, true, true, true],
  ['content', 'create', true, true, true, false],
  ['content', 'update', true, true, true, false],
  ['content', 'delete', true, true, true, false],
  ['content', 'comment', true, true, true, true],

  // Analysis & AI
  ['analysis', 'read', true, true, true, true],
  ['analysis', 'use', true, true, true, false],
  ['aiChat', 'use', true, true, true, false],

  // AI Tracker
  ['aiTracker', 'read', true, true, true, true],
  ['aiTracker', 'manage', true, true, false, false],
  ['aiTracker', 'use', true, true, true, false],

  // Keywords
  ['keywords', 'read', true, true, true, true],
  ['keywords', 'use', true, true, true, false],
  ['keywords', 'delete', true, true, true, false],

  // Billing
  ['billing', 'manage', true, false, false, false],

  // Brand Voice (not in user's matrix — defaulting to content-like access)
  ['brandVoice', 'read', true, true, true, true],
  ['brandVoice', 'manage', true, true, false, false],

  // Sites / GSC
  ['sites', 'read', true, true, true, true],
  ['sites', 'manage', true, true, false, false],

  // Sitemap Crawler
  ['sitemap', 'read', true, true, true, true],
  ['sitemap', 'manage', true, true, false, false],
  ['sitemap', 'use', true, true, true, false],
];

const ROLE_NAMES = ['owner', 'admin', 'editor', 'viewer'];

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
