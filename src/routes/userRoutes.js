const express = require('express');
const router = express.Router();
require('../middleware/validateIdParams')(router);
const userController = require('../controllers/userController');
const { authenticateToken } = require('../middleware/auth');
const denyImpersonation = require('../middleware/denyImpersonation');

// All user routes require authentication
router.use(authenticateToken);

// updateProfile is allowed while impersonating (support may fix display fields),
// but the email-CHANGE branch inside it self-blocks impersonation — see controller.
router.put('/profile', userController.updateProfile);
router.post('/onboarding', userController.saveOnboarding);
// Account-seizure ops: forbidden while impersonating (see denyImpersonation).
router.post('/change-password', denyImpersonation, userController.changePassword);
router.get('/sessions', userController.getSessions);
router.delete('/sessions/:sessionId', userController.revokeSession);
router.post('/accounts/:provider/connect', denyImpersonation, userController.connectAccount);
router.delete('/accounts/:provider', denyImpersonation, userController.disconnectAccount);
router.delete('/me', denyImpersonation, userController.deleteAccount);
router.post('/me/cancel-deletion', denyImpersonation, userController.cancelDeletion);

module.exports = router;
