const express = require('express');
const router = express.Router();
const workspaceController = require('../controllers/workspaceController');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

router.get('/', workspaceController.listWorkspaces);
router.post('/', workspaceController.createWorkspace);
router.put('/:workspaceId', workspaceController.updateWorkspace);
router.delete('/:workspaceId', workspaceController.deleteWorkspace);
router.put('/:workspaceId/activate', workspaceController.setActiveWorkspace);
router.get('/:workspaceId/members', workspaceController.getMembers);
router.post('/:workspaceId/members', workspaceController.addMember);
router.delete('/:workspaceId/members/:memberId', workspaceController.removeMember);

module.exports = router;
