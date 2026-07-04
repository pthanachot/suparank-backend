/**
 * Brevo (Sendinblue) API client for per-tenant sender identity (Phase 11).
 *
 * SENDING stays on the existing nodemailer SMTP relay — this client only
 * manages sender-domain verification (DKIM/Brevo-code DNS records) and
 * sender registration, which raw SMTP cannot do.
 *
 * Env-gated on BREVO_API_KEY: when unset, isConfigured() is false and the
 * email-domain endpoints degrade with an explanatory message (same pattern
 * as cloudflareService).
 *
 * API (verified against developers.brevo.com, 2026-07):
 *   POST   /v3/senders/domains                 create domain, returns dns_records
 *   GET    /v3/senders/domains/{domain}        verification/auth status
 *   PUT    /v3/senders/domains/{domain}/authenticate
 *   DELETE /v3/senders/domains/{domain}
 *   POST   /v3/senders                         register a from-address
 */

const API_BASE = 'https://api.brevo.com/v3';

function isConfigured() {
  return Boolean(process.env.BREVO_API_KEY);
}

async function _call(method, path, body) {
  if (!isConfigured()) {
    throw new Error('Brevo is not configured (BREVO_API_KEY missing)');
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  // DELETE returns 204; some endpoints return empty bodies
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data?.message || data?.error || `Brevo API ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Register a sender domain. Returns Brevo's DNS records to publish
 * (shape: { domain, dns_records: { dkim_record, brevo_code, ... } } —
 * we pass the records through verbatim; the UI renders name/value pairs).
 */
function createSenderDomain(domain) {
  return _call('POST', '/senders/domains', { name: domain });
}

/** Verification/authentication state + the DNS records for display. */
function getSenderDomain(domain) {
  return _call('GET', `/senders/domains/${encodeURIComponent(domain)}`);
}

/** Ask Brevo to (re)check DNS and authenticate the domain. */
function authenticateSenderDomain(domain) {
  return _call('PUT', `/senders/domains/${encodeURIComponent(domain)}/authenticate`);
}

function deleteSenderDomain(domain) {
  return _call('DELETE', `/senders/domains/${encodeURIComponent(domain)}`);
}

/**
 * Register a from-address as a Brevo sender (required before SMTP sends
 * from that address). Idempotent-ish: Brevo 400s on duplicates — callers
 * treat 'already exists' as success.
 */
async function createSender({ name, email }) {
  try {
    return await _call('POST', '/senders', { name, email });
  } catch (err) {
    if (/already exist/i.test(err.message)) return { existed: true };
    throw err;
  }
}

module.exports = {
  isConfigured,
  createSenderDomain,
  getSenderDomain,
  authenticateSenderDomain,
  deleteSenderDomain,
  createSender,
};
