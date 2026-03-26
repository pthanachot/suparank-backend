const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/auth');

// All user routes require authentication
router.use(authenticateToken);

router.put('/profile', userController.updateProfile);
router.post('/change-password', userController.changePassword);
router.get('/sessions', userController.getSessions);
router.delete('/sessions/:sessionId', userController.revokeSession);
router.post('/accounts/:provider/connect', userController.connectAccount);
router.delete('/accounts/:provider', userController.disconnectAccount);

module.exports = router;
