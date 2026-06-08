const express = require('express');
const router = express.Router();
const sitemapController = require('../controllers/sitemapController');
const { authenticateToken } = require('../middleware/auth');
const {
  resolveWorkspaceWithRole: rwr,
  requirePermission: rp,
  requireFeature: rf,
} = require('../middleware/permissions');
const validateBody = require('../middleware/validateBody');
const { createSitemapSchema } = require('../validators/sitemapValidators');

router.use(authenticateToken);

const rwrSitemap = [rwr, rf('sitemap')];

// CRUD
// validateBody(createSitemapSchema) replaces the old in-controller "if (!url)
// return 400" checks with a declarative schema. Pattern for rolling out
// across the rest of the API — see src/validators/ and src/middleware/validateBody.js.
router.post('/:workspaceNumber/sitemaps',              ...rwrSitemap, rp('sitemap', 'manage'), validateBody(createSitemapSchema), sitemapController.createSitemap);
router.get('/:workspaceNumber/sitemaps',               ...rwrSitemap, rp('sitemap', 'read'),   sitemapController.listSitemaps);
router.get('/:workspaceNumber/sitemaps/:sitemapId',    ...rwrSitemap, rp('sitemap', 'read'),   sitemapController.getSitemap);
router.delete('/:workspaceNumber/sitemaps/:sitemapId', ...rwrSitemap, rp('sitemap', 'manage'), sitemapController.deleteSitemap);

// Pages (paginated)
router.get('/:workspaceNumber/sitemaps/:sitemapId/pages',    ...rwrSitemap, rp('sitemap', 'read'),   sitemapController.getSitemapPages);

// Crawl actions
router.post('/:workspaceNumber/sitemaps/:sitemapId/crawl',   ...rwrSitemap, rp('sitemap', 'use'),    sitemapController.triggerCrawl);
router.get('/:workspaceNumber/sitemaps/:sitemapId/export',   ...rwrSitemap, rp('sitemap', 'read'),   sitemapController.exportXml);

module.exports = router;
