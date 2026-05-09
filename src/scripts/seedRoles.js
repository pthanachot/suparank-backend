const Role = require('../models/Role');

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
];

async function seedRoles() {
  let created = 0;
  let skipped = 0;

  for (const role of ROLES) {
    const result = await Role.updateOne(
      { name: role.name },
      { $setOnInsert: role },
      { upsert: true }
    );
    if (result.upsertedCount > 0) created++;
    else skipped++;
  }

  console.log(`[seedRoles] ${created} created, ${skipped} already existed`);
}

module.exports = { seedRoles, ROLES };
