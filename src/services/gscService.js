const { google } = require('googleapis');
const crypto = require('crypto');
const GscConnection = require('../models/GscConnection');
const { encrypt, decrypt } = GscConnection;
const Site = require('../models/Site');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const EMAIL_SCOPES = ['openid', 'email'];
const STATE_SECRET = process.env.GSC_TOKEN_ENCRYPTION_KEY; // reuse for HMAC

// ─── In-memory cache (5-minute TTL) ────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── OAuth helpers ─────────────────────────────────────────────────────────

function getOAuth2Client(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

function encryptState(payload) {
  const json = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', STATE_SECRET).update(json).digest('hex');
  const encoded = Buffer.from(json).toString('base64url');
  return `${encoded}.${hmac}`;
}

function decryptState(state) {
  const [encoded, hmac] = state.split('.');
  const json = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = crypto.createHmac('sha256', STATE_SECRET).update(json).digest('hex');
  if (hmac !== expected) throw new Error('Invalid state signature');
  return JSON.parse(json);
}

const GSC_REDIRECT_URI = `${FRONTEND_URL}/api/gsc/callback`;

function generateAuthUrl(orgId, workspaceNumber) {
  const client = getOAuth2Client(GSC_REDIRECT_URI);
  const state = encryptState({
    orgId: orgId.toString(),
    workspaceNumber,
    nonce: crypto.randomBytes(16).toString('hex'),
  });
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [GSC_SCOPE, ...EMAIL_SCOPES],
    prompt: 'consent',
    state,
  });
}

async function exchangeCodeAndStore(code, state, userId) {
  const { orgId, workspaceNumber } = decryptState(state);
  const client = getOAuth2Client(GSC_REDIRECT_URI);
  const { tokens } = await client.getToken(code);

  // Reject if the user didn't grant the Search Console scope
  const grantedScopes = tokens.scope ? tokens.scope.split(' ') : [];
  if (!grantedScopes.includes(GSC_SCOPE)) {
    // Revoke the partial token so it doesn't linger at Google
    try {
      if (tokens.access_token) await client.revokeToken(tokens.access_token);
    } catch { /* best-effort */ }
    const err = new Error('Search Console permission was not granted');
    err.code = 'SCOPE_DENIED';
    throw err;
  }

  // Get Google email from id_token if available
  let googleEmail = null;
  if (tokens.id_token) {
    try {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      googleEmail = ticket.getPayload()?.email || null;
    } catch {
      // Not critical — email is just for display
    }
  }

  await GscConnection.findOneAndUpdate(
    { organizationId: orgId },
    {
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scopes: tokens.scope ? tokens.scope.split(' ') : [GSC_SCOPE],
      googleEmail,
      connectedBy: userId,
      connectedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  return { orgId, workspaceNumber };
}

async function getAuthenticatedClient(orgId) {
  const conn = await GscConnection.findOne({ organizationId: orgId });
  if (!conn || !conn.refreshToken) {
    throw Object.assign(new Error('GSC not connected'), { code: 'GSC_NOT_CONNECTED' });
  }

  const client = getOAuth2Client(''); // redirect_uri not needed for API calls
  client.setCredentials({
    access_token: decrypt(conn.accessToken),
    refresh_token: decrypt(conn.refreshToken),
    expiry_date: conn.tokenExpiresAt?.getTime(),
  });

  // Auto-save refreshed tokens
  client.on('tokens', async (newTokens) => {
    const update = { lastRefreshedAt: new Date() };
    if (newTokens.access_token) update.accessToken = encrypt(newTokens.access_token);
    if (newTokens.refresh_token) update.refreshToken = encrypt(newTokens.refresh_token);
    if (newTokens.expiry_date) update.tokenExpiresAt = new Date(newTokens.expiry_date);
    await GscConnection.updateOne({ organizationId: orgId }, { $set: update });
  });

  return google.searchconsole({ version: 'v1', auth: client });
}

// ─── Disconnect / Revoke ──────────────────────────────────────────────────

async function revokeAndDisconnect(orgId) {
  const conn = await GscConnection.findOne({ organizationId: orgId });
  if (!conn) return;

  // Best-effort revoke the token at Google
  if (conn.refreshToken) {
    try {
      const token = decrypt(conn.refreshToken);
      const client = getOAuth2Client('');
      await client.revokeToken(token);
    } catch (err) {
      // Token may already be invalid — continue with local cleanup
      console.warn('[gsc] Token revoke failed (may already be revoked):', err.message);
    }
  }

  await GscConnection.deleteOne({ organizationId: orgId });
}

// ─── GSC API queries ───────────────────────────────────────────────────────

async function listProperties(orgId) {
  const searchconsole = await getAuthenticatedClient(orgId);
  const res = await searchconsole.sites.list();
  return (res.data.siteEntry || []).map((s) => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
}

async function querySearchAnalytics(orgId, siteUrl, params) {
  const searchconsole = await getAuthenticatedClient(orgId);
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: params.startDate,
      endDate: params.endDate,
      dimensions: params.dimensions || [],
      rowLimit: params.rowLimit || 1000,
      startRow: params.startRow || 0,
      ...(params.dimensionFilterGroups ? { dimensionFilterGroups: params.dimensionFilterGroups } : {}),
    },
  });
  return res.data;
}

// ─── Date helpers ──────────────────────────────────────────────────────────

const GSC_DATA_LAG_DAYS = 3;

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function parseDateRange(range) {
  const map = { '7d': 7, '28d': 28, '3m': 90, '6m': 180, '12m': 365 };
  const days = map[range] || 28;
  return {
    startDate: formatDate(daysAgo(days + GSC_DATA_LAG_DAYS)),
    endDate: formatDate(daysAgo(GSC_DATA_LAG_DAYS)),
  };
}

// ─── High-level data functions ─────────────────────────────────────────────

async function getOverviewData(orgId, siteUrl, dateRange) {
  const cacheKey = `overview:${orgId}:${siteUrl}:${dateRange}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { startDate, endDate } = parseDateRange(dateRange);

  const [timeSeriesRes, topKeywordsRes] = await Promise.all([
    querySearchAnalytics(orgId, siteUrl, {
      startDate,
      endDate,
      dimensions: ['date'],
      rowLimit: 500,
    }),
    querySearchAnalytics(orgId, siteUrl, {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: 10,
    }),
  ]);

  const rows = timeSeriesRes.rows || [];
  const result = {
    timeSeries: {
      dates: rows.map((r) => r.keys[0]),
      clicks: rows.map((r) => r.clicks),
      impressions: rows.map((r) => r.impressions),
      ctr: rows.map((r) => +(r.ctr * 100).toFixed(2)),
      position: rows.map((r) => +r.position.toFixed(1)),
    },
    topKeywords: (topKeywordsRes.rows || []).map((r) => ({
      keyword: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: +(r.ctr * 100).toFixed(2),
      position: +r.position.toFixed(1),
    })),
    totals: {
      clicks: rows.reduce((s, r) => s + r.clicks, 0),
      impressions: rows.reduce((s, r) => s + r.impressions, 0),
      ctr: rows.length > 0 ? +(rows.reduce((s, r) => s + r.ctr, 0) / rows.length * 100).toFixed(2) : 0,
      position: rows.length > 0 ? +(rows.reduce((s, r) => s + r.position, 0) / rows.length).toFixed(1) : 0,
    },
  };

  cacheSet(cacheKey, result);
  return result;
}

async function getDecliningPages(orgId, siteUrl) {
  const cacheKey = `declining:${orgId}:${siteUrl}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Period A: last 28 days, Period B: last 7 days
  const periodA = {
    startDate: formatDate(daysAgo(28 + GSC_DATA_LAG_DAYS)),
    endDate: formatDate(daysAgo(GSC_DATA_LAG_DAYS)),
  };
  const periodB = {
    startDate: formatDate(daysAgo(7 + GSC_DATA_LAG_DAYS)),
    endDate: formatDate(daysAgo(GSC_DATA_LAG_DAYS)),
  };

  const [dataA, dataB] = await Promise.all([
    querySearchAnalytics(orgId, siteUrl, { ...periodA, dimensions: ['page'], rowLimit: 5000 }),
    querySearchAnalytics(orgId, siteUrl, { ...periodB, dimensions: ['page'], rowLimit: 5000 }),
  ]);

  const mapA = new Map((dataA.rows || []).map((r) => [r.keys[0], r]));
  const mapB = new Map((dataB.rows || []).map((r) => [r.keys[0], r]));

  const declining = [];
  for (const [page, rowA] of mapA) {
    const rowB = mapB.get(page);
    if (!rowB) continue;

    // Normalize 28d to weekly rate for fair comparison
    const weeklyA = (rowA.clicks / 28) * 7;
    const weeklyB = rowB.clicks;

    if (weeklyA > 0 && weeklyB < weeklyA * 0.8) {
      const delta = Math.round(((weeklyB - weeklyA) / weeklyA) * 100);
      declining.push({
        page,
        clicks28: rowA.clicks,
        clicks7: rowB.clicks,
        delta,
        impressions: rowB.impressions,
      });
    }
  }

  declining.sort((a, b) => a.delta - b.delta);

  // Fetch top keyword for each declining page (batch query)
  const topPages = declining.slice(0, 20);
  if (topPages.length > 0) {
    try {
      const kwRes = await querySearchAnalytics(orgId, siteUrl, {
        ...periodB,
        dimensions: ['page', 'query'],
        rowLimit: 10000,
      });
      const kwMap = new Map();
      for (const row of (kwRes.rows || [])) {
        const p = row.keys[0];
        if (!kwMap.has(p) || row.clicks > kwMap.get(p).clicks) {
          kwMap.set(p, { keyword: row.keys[1], clicks: row.clicks });
        }
      }
      for (const dp of topPages) {
        dp.topKeyword = kwMap.get(dp.page)?.keyword || null;
      }
    } catch {
      // keyword enrichment is optional
    }
  }

  const result = { pages: topPages };
  cacheSet(cacheKey, result);
  return result;
}

async function getTopPages(orgId, siteUrl, dateRange) {
  const cacheKey = `topPages:${orgId}:${siteUrl}:${dateRange}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { startDate, endDate } = parseDateRange(dateRange);

  const [pagesRes, kwRes] = await Promise.all([
    querySearchAnalytics(orgId, siteUrl, {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 50,
    }),
    querySearchAnalytics(orgId, siteUrl, {
      startDate,
      endDate,
      dimensions: ['page', 'query'],
      rowLimit: 25000,
    }),
  ]);

  // Count unique keywords per page
  const kwCountMap = new Map();
  for (const row of (kwRes.rows || [])) {
    const page = row.keys[0];
    kwCountMap.set(page, (kwCountMap.get(page) || 0) + 1);
  }

  const result = {
    pages: (pagesRes.rows || []).map((r, i) => ({
      rank: i + 1,
      page: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: +(r.ctr * 100).toFixed(2),
      position: +r.position.toFixed(1),
      keywordsCount: kwCountMap.get(r.keys[0]) || 0,
    })),
  };

  cacheSet(cacheKey, result);
  return result;
}

async function refreshSiteStats(siteId) {
  const site = await Site.findById(siteId);
  if (!site) return;

  // Respect org-level persistData preference
  const conn = await GscConnection.findOne({ organizationId: site.organizationId });
  if (conn && conn.persistData === false) return;

  try {
    await Site.updateOne({ _id: siteId }, { $set: { syncStatus: 'syncing' } });

    const { startDate, endDate } = parseDateRange('28d');

    const [totalsRes, pagesCountRes, kwCountRes, trendRes] = await Promise.all([
      querySearchAnalytics(site.organizationId, site.gscPropertyId, {
        startDate, endDate, dimensions: [],
      }),
      querySearchAnalytics(site.organizationId, site.gscPropertyId, {
        startDate, endDate, dimensions: ['page'], rowLimit: 25000,
      }),
      querySearchAnalytics(site.organizationId, site.gscPropertyId, {
        startDate, endDate, dimensions: ['query'], rowLimit: 25000,
      }),
      querySearchAnalytics(site.organizationId, site.gscPropertyId, {
        startDate, endDate, dimensions: ['date'], rowLimit: 500,
      }),
    ]);

    const totals = totalsRes.rows?.[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const trendRows = trendRes.rows || [];

    // Build 7-point sparkline from daily data
    const clicksByDay = trendRows.map((r) => r.clicks);
    const chunkSize = Math.max(1, Math.floor(clicksByDay.length / 7));
    const clicksTrend = [];
    for (let i = 0; i < 7; i++) {
      const start = i * chunkSize;
      const end = i === 6 ? clicksByDay.length : (i + 1) * chunkSize;
      const chunk = clicksByDay.slice(start, end);
      clicksTrend.push(chunk.length > 0 ? chunk.reduce((s, v) => s + v, 0) : 0);
    }

    const trendDirection = clicksTrend.length >= 2
      ? (clicksTrend[clicksTrend.length - 1] > clicksTrend[0] ? 'up' : clicksTrend[clicksTrend.length - 1] < clicksTrend[0] ? 'down' : 'flat')
      : 'flat';

    await Site.updateOne({ _id: siteId }, {
      $set: {
        syncStatus: 'idle',
        syncError: null,
        lastSyncAt: new Date(),
        snapshotStats: {
          clicks: totals.clicks,
          impressions: totals.impressions,
          ctr: +(totals.ctr * 100).toFixed(2),
          position: +totals.position.toFixed(1),
          clicksTrend,
          trendDirection,
          pagesCount: pagesCountRes.rows?.length || 0,
          keywordsCount: kwCountRes.rows?.length || 0,
          updatedAt: new Date(),
        },
      },
    });

    console.log(`[sites] Stats refreshed for site ${siteId}`);
  } catch (err) {
    console.error(`[sites] Stats refresh failed for ${siteId}:`, err.message);
    await Site.updateOne({ _id: siteId }, {
      $set: { syncStatus: 'error', syncError: err.message },
    });
  }
}

module.exports = {
  generateAuthUrl,
  exchangeCodeAndStore,
  decryptState,
  revokeAndDisconnect,
  listProperties,
  getOverviewData,
  getDecliningPages,
  getTopPages,
  refreshSiteStats,
};
