const express = require('express');
const router = express.Router();
const workspaceController = require('../controllers/workspaceController');
const contentController = require('../controllers/contentController');
const { authenticateToken } = require('../middleware/auth');

// All workspace routes are protected
router.use(authenticateToken);

// Workspace
router.get('/', workspaceController.getWorkspace);

// Content under workspace: /api/workspace/:workspaceNumber/content
router.get('/:workspaceNumber/content', contentController.listContents);
router.post('/:workspaceNumber/content', contentController.createContent);
router.get('/:workspaceNumber/content/:contentNumber', contentController.getContent);
router.put('/:workspaceNumber/content/:contentNumber', contentController.updateContent);
router.delete('/:workspaceNumber/content/:contentNumber', contentController.deleteContent);

module.exports = router;
