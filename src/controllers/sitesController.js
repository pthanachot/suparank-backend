const Site = require('../models/Site');
const GscConnection = require('../models/GscConnection');
const gscService = require('../services/gscService');
const tierService = require('../services/tierService');

// ─── OAuth ─────────────────────────────────────────────────────────────────

const getGscAuthUrl = async (req, res) => {
  try {
    const orgId = req.workspace.organizationId;
    const force = req.query.force === 'true';

    if (!force) {
      const existing = await GscConnection.findOne({ organizationId: orgId });
      if (existing && existing.refreshToken) {
        return res.json({ alreadyConnected: true, googleEmail: existing.googleEmail });
      }
    }

    const authUrl = gscService.generateAuthUrl(orgId, req.params.workspaceNumber);
    res.json({ authUrl });
  } catch (err) {
    console.error('getGscAuthUrl error:', err.message);
    res.status(500).json({ error: 'Failed to generate auth URL' });
  }
};

const handleGscCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state' });
    }
    const { orgId, workspaceNumber } = await gscService.exchangeCodeAndStore(code, state, req.user.userId);

    // Token exchange succeeded — everything below is best-effort.
    // If listing properties or site lock/unlock fails, we still
    // return success so the frontend doesn't show a false "exchange_failed" error.
    let properties = [];
    try {
      properties = await gscService.listProperties(orgId);

      // Unlock sites that belong to the new account, lock the rest
      const validPropertyIds = properties.map((p) => p.siteUrl);
      if (validPropertyIds.length > 0) {
        await Promise.all([
          Site.updateMany(
            { organizationId: orgId, gscPropertyId: { $in: validPropertyIds } },
            { $set: { locked: false } }
          ),
          Site.updateMany(
            { organizationId: orgId, gscPropertyId: { $nin: validPropertyIds } },
            { $set: { locked: true } }
          ),
        ]);
      } else {
        // New account has no properties — lock all existing sites
        await Site.updateMany({ organizationId: orgId }, { $set: { locked: true } });
      }
    } catch (propErr) {
      console.error('handleGscCallback: post-exchange cleanup failed (non-fatal):', propErr.message);
      // Properties will be fetched separately when the modal opens at step 2
    }

    res.json({ success: true, properties, workspaceNumber });
  } catch (err) {
    console.error('handleGscCallback error:', err.message);
    if (err.code === 'SCOPE_DENIED') {
      return res.status(403).json({ error: 'Search Console permission not granted', code: 'SCOPE_DENIED' });
    }
    res.status(500).json({ error: 'OAuth exchange failed' });
  }
};

const listProperties = async (req, res) => {
  try {
    const orgId = req.workspace.organizationId;
    const properties = await gscService.listProperties(orgId);
    res.json({ properties });
  } catch (err) {
    if (err.code === 'GSC_NOT_CONNECTED') {
      return res.status(400).json({ error: 'GSC not connected', code: 'GSC_NOT_CONNECTED' });
    }
    console.error('listProperties error:', err.message);
    res.status(500).json({ error: 'Failed to list properties' });
  }
};

const getConnectionStatus = async (req, res) => {
  try {
    const conn = await GscConnection.findOne({ organizationId: req.workspace.organizationId });
    res.json({
      connected: !!(conn && conn.refreshToken),
      googleEmail: conn?.googleEmail || null,
      persistData: conn?.persistData !== false,
    });
  } catch (err) {
    console.error('getConnectionStatus error:', err.message);
    res.status(500).json({ error: 'Failed to check connection status' });
  }
};

const disconnectGsc = async (req, res) => {
  try {
    const orgId = req.workspace.organizationId;
    await gscService.revokeAndDisconnect(orgId);
    // Lock all sites — they become read-only placeholders until reconnect
    await Site.updateMany({ organizationId: orgId }, { $set: { locked: true } });
    res.json({ message: 'GSC disconnected', connected: false });
  } catch (err) {
    console.error('disconnectGsc error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect GSC' });
  }
};

const updatePersistData = async (req, res) => {
  try {
    const orgId = req.workspace.organizationId;
    const { persistData } = req.body;
    if (typeof persistData !== 'boolean') {
      return res.status(400).json({ error: 'persistData must be a boolean' });
    }

    await GscConnection.findOneAndUpdate(
      { organizationId: orgId },
      { $set: { persistData } }
    );

    // When toggling OFF: clear snapshotStats from all org sites
    if (!persistData) {
      await Site.updateMany(
        { organizationId: orgId },
        { $set: { snapshotStats: null, syncStatus: 'idle', syncError: null } }
      );
    }

    // When toggling ON: trigger a fresh sync for all org sites
    if (persistData) {
      const sites = await Site.find({ organizationId: orgId, locked: false }).select('_id');
      for (const s of sites) {
        gscService.refreshSiteStats(s._id).catch((err) => {
          console.error(`[sites] Re-sync failed for ${s._id}:`, err.message);
        });
      }
    }

    res.json({ persistData });
  } catch (err) {
    console.error('updatePersistData error:', err.message);
    res.status(500).json({ error: 'Failed to update persist data preference' });
  }
};

// ─── Site CRUD ─────────────────────────────────────────────────────────────

const createSite = async (req, res) => {
  try {
    const { gscPropertyId, url, label, gscPropertyType, syncFrequency } = req.body;
    if (!url || !gscPropertyId) {
      return res.status(400).json({ error: 'url and gscPropertyId are required' });
    }

    const orgId = req.workspace.organizationId;

    // Check tier quota (concurrent limit)
    const siteCount = await Site.countDocuments({ organizationId: orgId });
    const { config } = await tierService.getOrgTierConfig(orgId);
    if (config.maxSites != null && siteCount >= config.maxSites) {
      return res.status(429).json({
        error: `Site limit reached (${config.maxSites}). Upgrade your plan to add more sites.`,
        code: 'QUOTA_EXCEEDED',
      });
    }

    // Check duplicate
    const existing = await Site.findOne({ organizationId: orgId, url });
    if (existing) {
      return res.status(409).json({ error: 'This site is already connected' });
    }

    // Enforce tier sync frequency — downgrade to weekly if tier doesn't allow daily
    const allowedFreq = config.sitesSyncFrequency || 'weekly';
    const effectiveFreq = (syncFrequency === 'daily' && allowedFreq !== 'daily') ? 'weekly' : (syncFrequency || allowedFreq);

    const site = await Site.create({
      organizationId: orgId,
      workspaceId: req.workspace._id,
      url,
      label: label || url,
      gscPropertyId,
      gscPropertyType: gscPropertyType || 'URL_PREFIX',
      syncFrequency: effectiveFreq,
      verified: true,
    });

    // Save persistData preference if provided (first site setup)
    if (typeof req.body.persistData === 'boolean') {
      await GscConnection.findOneAndUpdate(
        { organizationId: orgId },
        { $set: { persistData: req.body.persistData } }
      );
    }

    // Trigger initial stats refresh only if persist data is ON
    const conn = await GscConnection.findOne({ organizationId: orgId });
    if (conn?.persistData !== false) {
      gscService.refreshSiteStats(site._id).catch((err) => {
        console.error('[sites] Initial stats refresh failed:', err.message);
      });
    }

    res.status(201).json({ site });
  } catch (err) {
    console.error('createSite error:', err.message);
    res.status(500).json({ error: 'Failed to create site' });
  }
};

const listSites = async (req, res) => {
  try {
    const sites = await Site.find({ workspaceId: req.workspace._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ sites });
  } catch (err) {
    console.error('listSites error:', err.message);
    res.status(500).json({ error: 'Failed to list sites' });
  }
};

const getSite = async (req, res) => {
  try {
    const site = await Site.findOne({
      _id: req.params.siteId,
      workspaceId: req.workspace._id,
    }).lean();
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ site });
  } catch (err) {
    console.error('getSite error:', err.message);
    res.status(500).json({ error: 'Failed to get site' });
  }
};

const deleteSite = async (req, res) => {
  try {
    const site = await Site.findOneAndDelete({
      _id: req.params.siteId,
      workspaceId: req.workspace._id,
    });
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({ message: 'Site disconnected' });
  } catch (err) {
    console.error('deleteSite error:', err.message);
    res.status(500).json({ error: 'Failed to delete site' });
  }
};

// ─── Data endpoints ────────────────────────────────────────────────────────

const getOverview = async (req, res) => {
  try {
    const site = await Site.findOne({ _id: req.params.siteId, workspaceId: req.workspace._id });
    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (site.locked) return res.status(403).json({ error: 'Site is locked. Reconnect the matching GSC account.', code: 'SITE_LOCKED' });

    const dateRange = req.query.dateRange || '28d';
    const data = await gscService.getOverviewData(
      req.workspace.organizationId,
      site.gscPropertyId,
      dateRange
    );
    res.json(data);
  } catch (err) {
    if (err.code === 'GSC_NOT_CONNECTED') {
      return res.status(400).json({ error: 'GSC access revoked. Please reconnect.', code: 'GSC_REVOKED' });
    }
    console.error('getOverview error:', err.message);
    res.status(500).json({ error: 'Failed to fetch overview data' });
  }
};

const getDeclining = async (req, res) => {
  try {
    const site = await Site.findOne({ _id: req.params.siteId, workspaceId: req.workspace._id });
    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (site.locked) return res.status(403).json({ error: 'Site is locked. Reconnect the matching GSC account.', code: 'SITE_LOCKED' });

    const data = await gscService.getDecliningPages(
      req.workspace.organizationId,
      site.gscPropertyId
    );
    res.json(data);
  } catch (err) {
    if (err.code === 'GSC_NOT_CONNECTED') {
      return res.status(400).json({ error: 'GSC access revoked. Please reconnect.', code: 'GSC_REVOKED' });
    }
    console.error('getDeclining error:', err.message);
    res.status(500).json({ error: 'Failed to fetch declining pages' });
  }
};

const getTopPages = async (req, res) => {
  try {
    const site = await Site.findOne({ _id: req.params.siteId, workspaceId: req.workspace._id });
    if (!site) return res.status(404).json({ error: 'Site not found' });
    if (site.locked) return res.status(403).json({ error: 'Site is locked. Reconnect the matching GSC account.', code: 'SITE_LOCKED' });

    const dateRange = req.query.dateRange || '28d';
    const data = await gscService.getTopPages(
      req.workspace.organizationId,
      site.gscPropertyId,
      dateRange
    );
    res.json(data);
  } catch (err) {
    if (err.code === 'GSC_NOT_CONNECTED') {
      return res.status(400).json({ error: 'GSC access revoked. Please reconnect.', code: 'GSC_REVOKED' });
    }
    console.error('getTopPages error:', err.message);
    res.status(500).json({ error: 'Failed to fetch top pages' });
  }
};

module.exports = {
  getGscAuthUrl,
  handleGscCallback,
  listProperties,
  getConnectionStatus,
  disconnectGsc,
  updatePersistData,
  createSite,
  listSites,
  getSite,
  deleteSite,
  getOverview,
  getDeclining,
  getTopPages,
};
