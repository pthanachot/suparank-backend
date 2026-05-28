const Sitemap = require('../models/Sitemap');
const CrawlPage = require('../models/CrawlPage');
const tierService = require('../services/tierService');
const { crawlSite, generateSitemapXml } = require('../services/sitemapCrawlerService');

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createSitemap = async (req, res) => {
  try {
    let { url, label, schedule } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    // Normalize URL: ensure https and strip trailing slash
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);

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

    // Duplicate check
    const existing = await Sitemap.findOne({ organizationId: orgId, url });
    if (existing) {
      return res.status(409).json({ error: 'This URL is already added' });
    }

    const sitemap = await Sitemap.create({
      organizationId: orgId,
      workspaceId: req.workspace._id,
      url,
      label: label || new URL(url).hostname,
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
    const sitemap = await Sitemap.findOne({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
    }).lean();

    if (!sitemap) return res.status(404).json({ error: 'Sitemap not found' });

    res.json({ sitemap });
  } catch (err) {
    console.error('getSitemap error:', err.message);
    res.status(500).json({ error: 'Failed to get sitemap' });
  }
};

const deleteSitemap = async (req, res) => {
  try {
    const result = await Sitemap.findOneAndDelete({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
    });

    if (!result) return res.status(404).json({ error: 'Sitemap not found' });

    // Also delete all crawl pages for this sitemap
    await CrawlPage.deleteMany({ sitemapId: result._id });

    res.json({ message: 'Sitemap deleted' });
  } catch (err) {
    console.error('deleteSitemap error:', err.message);
    res.status(500).json({ error: 'Failed to delete sitemap' });
  }
};

// ─── Pages (paginated) ───────────────────────────────────────────────────────

const getSitemapPages = async (req, res) => {
  try {
    const sitemap = await Sitemap.findOne({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
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
    console.error('getSitemapPages error:', err.message);
    res.status(500).json({ error: 'Failed to get pages' });
  }
};

// ─── Crawl actions ────────────────────────────────────────────────────────────

const triggerCrawl = async (req, res) => {
  try {
    const { config } = await tierService.getOrgTierConfig(req.workspace.organizationId);
    const maxPages = config.maxCrawlPages ?? 500;

    // Atomically claim the crawl BEFORE responding — prevents race with frontend refetch
    const sitemap = await Sitemap.findOneAndUpdate(
      {
        _id: req.params.sitemapId,
        organizationId: req.workspace.organizationId,
        crawlStatus: { $in: ['idle', 'completed', 'error'] },
      },
      { $set: { crawlStatus: 'crawling', crawlProgress: 0, crawlError: null } },
      { new: true },
    );

    if (!sitemap) {
      const existing = await Sitemap.findOne({
        _id: req.params.sitemapId,
        organizationId: req.workspace.organizationId,
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
    console.error('triggerCrawl error:', err.message);
    res.status(500).json({ error: 'Failed to trigger crawl' });
  }
};

const exportXml = async (req, res) => {
  try {
    const sitemap = await Sitemap.findOne({
      _id: req.params.sitemapId,
      organizationId: req.workspace.organizationId,
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
