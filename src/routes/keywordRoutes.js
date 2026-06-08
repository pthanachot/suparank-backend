const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const keywordController = require('../controllers/keywordController');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');
const { requireQuota: rq } = require('../middleware/tierEnforcement');

// All keyword routes require authentication
router.use(authenticateToken);

// Shared middleware: resolve workspace + check feature flag
const rwrKw = [rwr, rf('keywords')];

// Search keywords (DataForSEO)
router.post('/:workspaceNumber/keywords/search', ...rwrKw, rp('keywords', 'use'), rq('keywordSearches', 'maxKeywordLookupsPerMonth', 'keywordLimitType'), keywordController.searchKeywords);

// Get SERP detail for a single keyword (Serper)
router.get('/:workspaceNumber/keywords/detail', ...rwrKw, rp('keywords', 'use'), rq('keywordSearches', 'maxKeywordLookupsPerMonth', 'keywordLimitType'), keywordController.getKeywordDetail);

// Research history
router.get('/:workspaceNumber/keywords/history', ...rwrKw, rp('keywords', 'read'), keywordController.getSearchHistory);
router.delete('/:workspaceNumber/keywords/history/:historyId', ...rwrKw, rp('keywords', 'delete'), keywordController.deleteSearchHistory);

// Get cached results (read-only, no DataForSEO call — for viewers loading history)
router.get('/:workspaceNumber/keywords/cached', ...rwrKw, rp('keywords', 'read'), keywordController.getCachedResults);

// Get supported countries list
router.get('/:workspaceNumber/keywords/countries', ...rwrKw, rp('keywords', 'read'), keywordController.getCountries);

module.exports = router;
