const mongoose = require('mongoose');
const Sitemap = require('../models/Sitemap');
const CrawlPage = require('../models/CrawlPage');
const tierService = require('../services/tierService');
const { crawlSite, generateSitemapXml } = require('../services/sitemapCrawlerService');

// ─── Shared helpers ──────────────────────────────────────────────────────────

function ensureValidObjectId(res, id, label) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: `Invalid ${label}` });
    return false;
  }
  return true;
}

function handleMongooseError(res, err) {
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: `Invalid ${err.path || 'id'} format` });
    return true;
  }
  return false;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createSitemap = async (req, res) => {
  try {
    let { url, label, schedule } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Normalize URL: ensure https and strip trailing slash
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);

    // Validate URL format before hitting the DB. Without this, garbage input
    // like "not a url at all" reaches `new URL(url).hostname` below and
    // throws a TypeError that escapes to the generic 500.
    let parsedHostname;
    try {
      parsedHostname = new URL(url).hostname;
      if (!parsedHostname) throw new Error('empty hostname');
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    const orgId = req.workspace.organizationId;

    // Check tier quota
    const count = await Sitemap.countDocuments({ organizationId: orgId });
    const { config } = await tierService.getOrgTierConfig(orgId);
    const maxSitemaps = config.maxSitemaps ?? 3;
    if (count >= maxSitemaps) {
      return res.status(429).json({
        error: `Sitemap limit reached (${maxSitemaps}). Upgrade your plan to add more.`,
        code: 'QUOTA_EXCEEDED',
      });
    }

    // Duplicate check — scoped to THIS workspace (sitemaps belong to a workspace,
    // per listSitemaps/getSitemap). Org-wide dedup would block a sibling client
    // workspace from tracking the same public URL and leak its existence.
    const existing = await Sitemap.findOne({ workspaceId: req.workspace._id, url });
    if (existing) {
      return res.status(409).json({ error: 'This URL is already added' });
    }

    const sitemap = await Sitemap.create({
      organizationId: orgId,
      workspaceId: req.workspace._id,
      url,
      label: label || parsedHostname,
      schedule: schedule || 'weekly',
      nextCrawlAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    // Fire-and-forget: trigger initial crawl
    const maxPages = config.maxCrawlPages ?? 500;
    crawlSite(sitemap._id, { maxPages }).catch((err) => {
      console.error('[sitemap] Initial crawl failed:', err.message);
    });

    res.status(201).json({ sitemap });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('createSitemap error:', err.message);
    res.status(500).json({ error: 'Failed to create sitemap' });
  }
};

const listSitemaps = async (req, res) => {
  try {
    const sitemaps = await Sitemap.find({
      organizationId: req.workspace.organizationId,
      workspaceId: req.workspace._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ sitemaps });
  } catch (err) {
    console.error('listSitemaps error:', err.message);
    res.status(500).json({ error: 'Failed to list sitemaps' });
  }
};

const getSitemap = async (req, res) => {
  try {
    if (!ensureValidObjectId(res, req.params.sitemapId, 'sitemap id')) return;
    const sitemap = await Sitemap.findOne({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
      workspaceId: req.workspace._id,
    }).lean();

    if (!sitemap) return res.status(404).json({ error: 'Sitemap not found' });

    res.json({ sitemap });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('getSitemap error:', err.message);
    res.status(500).json({ error: 'Failed to get sitemap' });
  }
};

const deleteSitemap = async (req, res) => {
  try {
    if (!ensureValidObjectId(res, req.params.sitemapId, 'sitemap id')) return;
    const result = await Sitemap.findOneAndDelete({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
      workspaceId: req.workspace._id,
    });

    if (!result) return res.status(404).json({ error: 'Sitemap not found' });

    // Also delete all crawl pages for this sitemap
    await CrawlPage.deleteMany({ sitemapId: result._id });

    res.json({ message: 'Sitemap deleted' });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('deleteSitemap error:', err.message);
    res.status(500).json({ error: 'Failed to delete sitemap' });
  }
};

// ─── Pages (paginated) ───────────────────────────────────────────────────────

const getSitemapPages = async (req, res) => {
  try {
    if (!ensureValidObjectId(res, req.params.sitemapId, 'sitemap id')) return;
    const sitemap = await Sitemap.findOne({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
      workspaceId: req.workspace._id,
    });

    if (!sitemap) return res.status(404).json({ error: 'Sitemap not found' });

    // Parse query params
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const filter = req.query.filter || 'all'; // all, new, unchanged, removed
    const search = (req.query.search || '').trim();
    const mode = req.query.mode || 'paginated'; // 'paginated' or 'all' (for tree view)

    // Build query
    const query = { sitemapId: sitemap._id };
    if (filter !== 'all') {
      query.diffStatus = filter;
    }
    if (search) {
      query.$or = [
        { url: { $regex: search, $options: 'i' } },
        { title: { $regex: search, $options: 'i' } },
      ];
    }

    // If mode=all, return all pages (for tree view) but cap at 5000
    if (mode === 'all') {
      const pages = await CrawlPage.find(query)
        .sort({ depth: 1, url: 1 })
        .limit(5000)
        .lean();
      const total = await CrawlPage.countDocuments(query);
      return res.json({ pages, total, capped: total > 5000 });
    }

    // Paginated mode
    const skip = (page - 1) * limit;
    const [pages, total] = await Promise.all([
      CrawlPage.find(query)
        .sort({ diffStatus: 1, url: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CrawlPage.countDocuments(query),
    ]);

    res.json({
      pages,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('getSitemapPages error:', err.message);
    res.status(500).json({ error: 'Failed to get pages' });
  }
};

// ─── Crawl actions ────────────────────────────────────────────────────────────

const triggerCrawl = async (req, res) => {
  try {
    if (!ensureValidObjectId(res, req.params.sitemapId, 'sitemap id')) return;
    const { config } = await tierService.getOrgTierConfig(req.workspace.organizationId);
    const maxPages = config.maxCrawlPages ?? 500;

    // Atomically claim the crawl BEFORE responding — prevents race with frontend refetch
    const sitemap = await Sitemap.findOneAndUpdate(
      {
        _id: req.params.sitemapId,
        organizationId: req.workspace.organizationId,
        workspaceId: req.workspace._id,
        crawlStatus: { $in: ['idle', 'completed', 'error'] },
      },
      { $set: { crawlStatus: 'crawling', crawlProgress: 0, crawlError: null } },
      { new: true },
    );

    if (!sitemap) {
      const existing = await Sitemap.findOne({
        _id: req.params.sitemapId,
        organizationId: req.workspace.organizationId,
        workspaceId: req.workspace._id,
      });
      if (!existing) return res.status(404).json({ error: 'Sitemap not found' });
      return res.status(409).json({ error: 'Crawl already in progress' });
    }

    // Fire-and-forget (crawlSite will see status is already 'crawling')
    crawlSite(sitemap._id, { maxPages }).catch((err) => {
      console.error('[sitemap] Manual crawl failed:', err.message);
    });

    res.json({ message: 'Crawl started' });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('triggerCrawl error:', err.message);
    res.status(500).json({ error: 'Failed to trigger crawl' });
  }
};

const exportXml = async (req, res) => {
  try {
    if (!ensureValidObjectId(res, req.params.sitemapId, 'sitemap id')) return;
    const sitemap = await Sitemap.findOne({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
      workspaceId: req.workspace._id,
    }).lean();

    if (!sitemap) return res.status(404).json({ error: 'Sitemap not found' });

    // Read pages from CrawlPage collection (exclude removed pages)
    const pages = await CrawlPage.find({
      sitemapId: sitemap._id,
      diffStatus: { $ne: 'removed' },
    })
      .sort({ priority: -1, url: 1 })
      .lean();

    if (pages.length === 0) {
      return res.status(400).json({ error: 'No pages to export. Run a crawl first.' });
    }

    const xml = generateSitemapXml(pages);
    const hostname = new URL(sitemap.url).hostname;

    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="${hostname}-sitemap.xml"`);
    res.send(xml);
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('exportXml error:', err.message);
    res.status(500).json({ error: 'Failed to export sitemap' });
  }
};

module.exports = {
  createSitemap,
  listSitemaps,
  getSitemap,
  deleteSitemap,
  getSitemapPages,
  triggerCrawl,
  exportXml,
};
