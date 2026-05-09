const express = require('express');
const router = express.Router();
const keywordController = require('../controllers/keywordController');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');

// All keyword routes require authentication
router.use(authenticateToken);

// Shared middleware: resolve workspace + check feature flag
const rwrKw = [rwr, rf('keywords')];

// Search keywords (DataForSEO)
router.post('/:workspaceNumber/keywords/search', ...rwrKw, rp('keywords', 'use'), keywordController.searchKeywords);

// Get SERP detail for a single keyword (Serper)
router.get('/:workspaceNumber/keywords/detail', ...rwrKw, rp('keywords', 'use'), keywordController.getKeywordDetail);

// Research history
router.get('/:workspaceNumber/keywords/history', ...rwrKw, rp('keywords', 'read'), keywordController.getSearchHistory);
router.delete('/:workspaceNumber/keywords/history/:historyId', ...rwrKw, rp('keywords', 'delete'), keywordController.deleteSearchHistory);

// Get supported countries list
router.get('/:workspaceNumber/keywords/countries', ...rwrKw, rp('keywords', 'read'), keywordController.getCountries);

module.exports = router;
