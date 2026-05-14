/**
 * Internal CFS routes — called by the Go writing-engine via the internal
 * API key. Mounted at /api/internal/cfs in src/index.js.
 *
 * Each route is scoped by (workspaceNumber, contentNumber) in the path.
 * The internalAuth middleware gates ALL of them.
 */

const express = require('express');
const router = express.Router();
const { internalAuth } = require('../middleware/internalAuth');
const contextController = require('../controllers/contextController');

router.use(internalAuth);

router.get('/:workspaceNumber/:contentNumber/list',  contextController.internalList);
router.get('/:workspaceNumber/:contentNumber/read',  contextController.internalRead);
router.get('/:workspaceNumber/:contentNumber/grep',  contextController.internalGrep);
router.post('/:workspaceNumber/:contentNumber/verify', contextController.internalVerify);
router.patch('/:workspaceNumber/:contentNumber/write', contextController.internalWrite);
// M5: drift detection endpoint — Go's ExecuteModeStrategy can hit this
// for an authoritative second-opinion check at terminal turns.
router.post('/:workspaceNumber/:contentNumber/conformance', contextController.internalConformance);

module.exports = router;
