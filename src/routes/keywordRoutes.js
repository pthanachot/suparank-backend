const express = require('express');
const router = express.Router();
const keywordController = require('../controllers/keywordController');
const { authenticateToken } = require('../middleware/auth');

// All keyword routes require authentication
router.use(authenticateToken);

// Search keywords (DataForSEO)
router.post('/:workspaceNumber/keywords/search', keywordController.searchKeywords);

// Get SERP detail for a single keyword (Serper)
router.get('/:workspaceNumber/keywords/detail', keywordController.getKeywordDetail);

// Research history
router.get('/:workspaceNumber/keywords/history', keywordController.getSearchHistory);
router.delete('/:workspaceNumber/keywords/history/:historyId', keywordController.deleteSearchHistory);

// Get supported countries list
router.get('/:workspaceNumber/keywords/countries', keywordController.getCountries);

module.exports = router;
