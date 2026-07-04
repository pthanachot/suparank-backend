/**
 * Per-tenant sender identity (Phase 11).
 *
 * Fallback ladder for an org's outbound email FROM:
 *   1. verified sender domain  → "FromName <no-reply@agency-domain>"
 *   2. custom name only        → "FromName <platform address>"
 *   3. otherwise               → null (caller uses the platform default)
 *
 * Gated on the whiteLabelEmail launch flag AND the org's white-label
 * entitlement. ALWAYS fail-open to null — a broken identity lookup must
 * never block an email send.
 */

const flagService = require('./flagService');

function platformFromAddress() {
  const defaultFrom = process.env.EMAIL_FROM || 'SupaRank <no-reply@suparank.com>';
  return defaultFrom.match(/<(.+)>/)?.[1] || 'no-reply@suparank.ai';
}

/**
 * Returns { fromName, fromEmail } or null (use platform default).
 */
async function resolveSenderIdentity(orgId) {
  try {
    if (!orgId) return null;
    if (!(await flagService.isFlagLive('whiteLabelEmail'))) return null;

    // Lazy require — brandService pulls tierService/models; keep this module
    // loadable from emailService (utils) without a require cycle.
    const brandService = require('./brandService');
    const { entitled, config } = await brandService.getBrandForOrg(orgId);
    if (!entitled || !config) return null;

    const fromName = config.emailFromName || config.productName || '';
    const domainVerified =
      config.emailDomain?.status === 'verified' && config.emailDomain?.domain;

    if (domainVerified) {
      return {
        fromName: fromName || 'Notifications',
        fromEmail: `no-reply@${config.emailDomain.domain}`,
      };
    }
    if (fromName) {
      // Agency's name on the platform's verified address — deliverable
      // without their DNS setup, still de-SupaRanks the inbox line.
      return { fromName, fromEmail: platformFromAddress() };
    }
    return null;
  } catch (err) {
    console.error('[emailIdentity] resolve failed:', err.message);
    return null;
  }
}

module.exports = { resolveSenderIdentity, platformFromAddress };
