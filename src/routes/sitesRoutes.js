const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const sitesController = require('../controllers/sitesController');
const { authenticateToken } = require('../middleware/auth');
const {
  resolveWorkspaceWithRole: rwr,
  requirePermission: rp,
  requireFeature: rf,
} = require('../middleware/permissions');

router.use(authenticateToken);

const rwrSites = [rwr, rf('sites')];

// GSC OAuth flow (callback is top-level in index.js — static URI for Google redirect)
router.get('/:workspaceNumber/sites/gsc/auth-url',   ...rwrSites, rp('sites', 'manage'), sitesController.getGscAuthUrl);
router.get('/:workspaceNumber/sites/gsc/properties',  ...rwrSites, rp('sites', 'manage'), sitesController.listProperties);
router.get('/:workspaceNumber/sites/gsc/status',      ...rwrSites, rp('sites', 'read'),   sitesController.getConnectionStatus);
router.delete('/:workspaceNumber/sites/gsc/disconnect', ...rwrSites, rp('sites', 'manage'), sitesController.disconnectGsc);
router.patch('/:workspaceNumber/sites/gsc/persist-data', ...rwrSites, rp('sites', 'manage'), sitesController.updatePersistData);

// Site CRUD
router.post('/:workspaceNumber/sites',                ...rwrSites, rp('sites', 'manage'), sitesController.createSite);
router.get('/:workspaceNumber/sites',                  ...rwrSites, rp('sites', 'read'),   sitesController.listSites);
router.get('/:workspaceNumber/sites/:siteId',          ...rwrSites, rp('sites', 'read'),   sitesController.getSite);
router.delete('/:workspaceNumber/sites/:siteId',       ...rwrSites, rp('sites', 'manage'), sitesController.deleteSite);

// Site data endpoints
router.get('/:workspaceNumber/sites/:siteId/overview',   ...rwrSites, rp('sites', 'read'), sitesController.getOverview);
router.get('/:workspaceNumber/sites/:siteId/declining',  ...rwrSites, rp('sites', 'read'), sitesController.getDeclining);
router.get('/:workspaceNumber/sites/:siteId/top-pages',  ...rwrSites, rp('sites', 'read'), sitesController.getTopPages);
router.get('/:workspaceNumber/sites/:siteId/striking-distance', ...rwrSites, rp('sites', 'read'), sitesController.getStrikingDistance);

module.exports = router;
