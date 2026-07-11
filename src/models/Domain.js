const mongoose = require('mongoose');

/**
 * Tenant custom domain (white-label Phase 8).
 *
 * One document per connected hostname. A hostname is globally unique —
 * two orgs can never claim the same domain. Lifecycle:
 *
 *   pending_dns  → customer still has to add the CNAME + TXT records
 *   pending_ssl  → DNS verified; Cloudflare is provisioning the cert
 *   active       → serving traffic; host→org resolution uses ONLY this state
 *   failed       → was active but the CNAME no longer points at us
 *
 * statusDetail carries a human-readable explanation of why the domain is
 * stuck in its current state (missing TXT, wrong CNAME target, CF error…).
 */
const domainSchema = new mongoose.Schema(
  {
    hostname: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending_dns', 'pending_ssl', 'active', 'failed', 'suspended'],
      default: 'pending_dns',
    },
    statusDetail: { type: String, default: '' },
    // 32-hex token the customer publishes as a TXT record to prove control
    verificationToken: { type: String, required: true },
    // Primary domain: the org's canonical base URL for emailed links
    isPrimary: { type: Boolean, default: false },
    lastCheckedAt: { type: Date, default: null },
    // Cloudflare Custom Hostname id (empty until SSL provisioning starts)
    cloudflareId: { type: String, default: '' },
  },
  { timestamps: true }
);

domainSchema.index({ organizationId: 1 });

module.exports = mongoose.model('Domain', domainSchema);
