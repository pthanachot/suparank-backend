const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { submitFeedback } = require('../controllers/feedbackController');

router.use(authenticateToken);
router.post('/', submitFeedback);

module.exports = router;
