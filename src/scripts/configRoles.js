const Role = require('../models/Role');

// SOURCE OF TRUTH — synced to database on every server startup.
const ROLES = [
  {
    name: 'owner',
    displayName: 'Owner',
    level: 0,
    description: 'Full access. Manages billing, members, and all workspaces.',
    isSystem: true,
  },
  {
    name: 'admin',
    displayName: 'Admin',
    level: 1,
    description: 'Manages members and roles. Can add workspaces but not delete. Cannot manage billing.',
    isSystem: true,
  },
  {
    name: 'editor',
    displayName: 'Editor',
    level: 2,
    description: 'Creates, edits, and deletes content. Uses AI and analysis tools. Cannot manage members or workspaces.',
    isSystem: true,
  },
  {
    name: 'viewer',
    displayName: 'Viewer',
    level: 3,
    description: 'Read-only access to content and workspaces.',
    isSystem: true,
  },
  {
    name: 'client',
    displayName: 'Client',
    level: 4,
    description:
      'External client access. Reads content, reports, and AI visibility for assigned workspaces only; can comment. No editing, AI usage, or team visibility.',
    isSystem: true,
  },
];

async function syncRoles() {
  let upserted = 0;
  let updated = 0;

  const configNames = ROLES.map((r) => r.name);

  for (const role of ROLES) {
    const result = await Role.updateOne(
      { name: role.name },
      { $set: role },
      { upsert: true }
    );
    if (result.upsertedCount > 0) upserted++;
    else if (result.modifiedCount > 0) updated++;
  }

  // Remove roles no longer in config
  const removed = await Role.deleteMany({ name: { $nin: configNames }, isSystem: true });

  console.log(`[syncRoles] ${upserted} created, ${updated} updated, ${removed.deletedCount} removed`);
}

module.exports = { syncRoles, ROLES };
