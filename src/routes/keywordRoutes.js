const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const keywordController = require('../controllers/keywordController');
const { authenticateToken } = require('../middleware/auth');
const { resolveWorkspaceWithRole: rwr, requirePermission: rp, requireFeature: rf } = require('../middleware/permissions');
// Phase 10: granular v4 policy gate (permissions.policy) is authoritative on
// credit/sensitive actions; the CI route-scan guard matches `requirePermission('...')`.
const { requirePermission } = require('../middleware/permissions.policy');
const { requireQuota: rq } = require('../middleware/tierEnforcement');
const { requireCredits: rc } = require('../middleware/creditGate');
const { resolveCredits } = require('../config/creditRules');

// All keyword routes require authentication
router.use(authenticateToken);

// Shared middleware: resolve workspace + check feature flag
const rwrKw = [rwr, rf('keywords')];

// Phase 6: keyword lookup bills 1 credit/row DELIVERED, capped at 50 (Free =
// fixed bundle → 0, count-gated by keywordSearches). The gate can't know the
// delivered row count pre-flight, so it reserves the conservative cap (50 for
// paid); searchKeywords settles to the actual row count via deductForRequest.
const estKeyword = (_req, { tier }) => resolveCredits('keywordLookup', { tier, rows: 50 });

// Search keywords (DataForSEO)
router.post('/:workspaceNumber/keywords/search', ...rwrKw, requirePermission('keywords.search'), rq('keywordSearches', 'maxKeywordLookupsPerMonth', 'keywordLimitType'), rc('keywordLookup', estKeyword), keywordController.searchKeywords);

// Get SERP detail for a single keyword (Serper). NOT credit-billed: the SERP
// fetch maps to serpDeepDive, which is INACTIVE in creditCosts (a distinct
// metered action isn't built) — it stays entitlement-gated (keywordSearches) only.
router.get('/:workspaceNumber/keywords/detail', ...rwrKw, requirePermission('keywords.search'), rq('keywordSearches', 'maxKeywordLookupsPerMonth', 'keywordLimitType'), keywordController.getKeywordDetail);

// Research history
router.get('/:workspaceNumber/keywords/history', ...rwrKw, rp('keywords', 'read'), keywordController.getSearchHistory);
router.delete('/:workspaceNumber/keywords/history/:historyId', ...rwrKw, requirePermission('keywords.deleteHistory'), keywordController.deleteSearchHistory);

// Get cached results (read-only, no DataForSEO call — for viewers loading history)
router.get('/:workspaceNumber/keywords/cached', ...rwrKw, rp('keywords', 'read'), keywordController.getCachedResults);

// Get supported countries list
router.get('/:workspaceNumber/keywords/countries', ...rwrKw, rp('keywords', 'read'), keywordController.getCountries);

module.exports = router;
