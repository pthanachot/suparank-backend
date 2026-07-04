/**
 * Cloudflare "Custom Hostnames" (SSL for SaaS) client — Phase 8.
 *
 * Env-gated: the whole feature degrades gracefully when the three env vars
 * are missing (dev machines, self-hosters). Callers MUST gate on
 * isConfigured() — every method throws a clear error when unconfigured
 * rather than firing an unauthenticated request at Cloudflare.
 *
 *   CLOUDFLARE_API_TOKEN  scoped token with SSL and Certificates:Edit
 *   CLOUDFLARE_ZONE_ID    the zone that hosts the fallback origin
 *   CF_FALLBACK_ORIGIN    hostname customers CNAME to (e.g. wl.suparank.ai)
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

function _config() {
  return {
    token: process.env.CLOUDFLARE_API_TOKEN || '',
    zoneId: process.env.CLOUDFLARE_ZONE_ID || '',
    fallbackOrigin: process.env.CF_FALLBACK_ORIGIN || '',
  };
}

/** True when all three Cloudflare env vars are set. */
function isConfigured() {
  const { token, zoneId, fallbackOrigin } = _config();
  return Boolean(token && zoneId && fallbackOrigin);
}

async function _request(method, path, body) {
  if (!isConfigured()) {
    throw new Error(
      'Cloudflare is not configured (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID and CF_FALLBACK_ORIGIN are required)'
    );
  }
  const { token, zoneId } = _config();

  const res = await fetch(`${API_BASE}/zones/${zoneId}/custom_hostnames${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body (gateway error page) — fall through to status check
  }

  if (!res.ok || (data && data.success === false)) {
    const cfMessage =
      (data?.errors || [])
        .map((e) => e?.message)
        .filter(Boolean)
        .join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API error: ${cfMessage}`);
  }

  return data?.result ?? null;
}

/**
 * Register a custom hostname (SSL via HTTP DV validation — works because
 * the customer's CNAME already points traffic at our edge).
 * Returns { id, sslStatus }.
 */
async function createCustomHostname(hostname) {
  const result = await _request('POST', '', {
    hostname,
    ssl: { method: 'http', type: 'dv' },
  });
  return { id: result?.id || '', sslStatus: result?.ssl?.status || '' };
}

/** Poll a custom hostname. Returns { sslStatus, status }. */
async function getCustomHostname(id) {
  const result = await _request('GET', `/${id}`);
  return { sslStatus: result?.ssl?.status || '', status: result?.status || '' };
}

/** Remove a custom hostname (on domain delete). */
async function deleteCustomHostname(id) {
  await _request('DELETE', `/${id}`);
  return true;
}

module.exports = {
  isConfigured,
  createCustomHostname,
  getCustomHostname,
  deleteCustomHostname,
};
