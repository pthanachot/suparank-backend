/**
 * Public contact endpoint (mounted at /api/public/contact in index.js).
 *
 * UNAUTHENTICATED by design: this is the only way a prospect who has not signed
 * up can reach support. Deliberately NOT behind PUBLIC_TOOLS_ENABLED — that
 * flag hides the free-tools launch surface, whereas a contact form must work at
 * all times.
 *
 * The authenticated form at /api/contact stays as it is, and signed-in users
 * keep using it so their message is attributed to a real account.
 */
const express = require('express');
const router = express.Router();
const { submitPublicContact } = require('../controllers/publicContactController');

router.post('/', submitPublicContact);

module.exports = router;
