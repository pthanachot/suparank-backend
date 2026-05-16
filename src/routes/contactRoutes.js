const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { submitContact } = require('../controllers/contactController');

router.use(authenticateToken);
router.post('/', submitContact);

module.exports = router;
