/**
 * Organization-level config — global limits that apply to user accounts,
 * not to any specific tier or organization.
 *
 * SOURCE OF TRUTH. To change values, edit this file and restart the server.
 * No database sync needed — these are plain constants used directly in code.
 */

const ORG_CONFIG = {
  // Max organizations a single user can own. null = unlimited.
  maxOrganizationsPerUser: 1,
};

module.exports = { ORG_CONFIG };
