const Permission = require('../models/Permission');

// ─── Permission matrix (matches user's exact specification) ─────────
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
];

const ROLE_NAMES = ['owner', 'admin', 'editor', 'viewer'];

async function seedPermissions() {
  let created = 0;
  let skipped = 0;

  for (const [resource, action, ...roleFlags] of MATRIX) {
    for (let i = 0; i < ROLE_NAMES.length; i++) {
      const role = ROLE_NAMES[i];
      const allowed = roleFlags[i];

      const result = await Permission.updateOne(
        { role, resource, action },
        { $setOnInsert: { role, resource, action, allowed } },
        { upsert: true }
      );
      if (result.upsertedCount > 0) created++;
      else skipped++;
    }
  }

  console.log(`[seedPermissions] ${created} created, ${skipped} already existed`);
}

module.exports = { seedPermissions, MATRIX, ROLE_NAMES };
