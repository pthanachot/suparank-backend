const express = require('express');
const router = express.Router();
const workspaceController = require('../controllers/workspaceController');
const { authenticateToken } = require('../middleware/auth');
const Workspace = require('../models/Workspace');
const { rejectIfLocked } = require('../middleware/lockGuard');

router.use(authenticateToken);

router.get('/', workspaceController.listWorkspaces);
router.post('/', workspaceController.createWorkspace);
router.put('/:workspaceId', rejectIfLocked(Workspace, 'workspaceId'), workspaceController.updateWorkspace);
router.delete('/:workspaceId', workspaceController.deleteWorkspace);
router.put('/:workspaceId/activate', rejectIfLocked(Workspace, 'workspaceId'), workspaceController.setActiveWorkspace);
router.put('/:workspaceId/move', workspaceController.moveWorkspace);
router.get('/:workspaceId/members', workspaceController.getMembers);
router.post('/:workspaceId/members', workspaceController.addMember);
router.delete('/:workspaceId/members/:memberId', workspaceController.removeMember);

module.exports = router;
