const express = require('express');
const imageStorage = require('../services/imageStorage');

const router = express.Router();

/**
 * GET /api/b2-image/* — Serve a private B2 image via presigned URL redirect.
 * No auth required (keys are random hashes, presigned URLs expire after 1 hour).
 */
router.get('/*', async (req, res) => {
  const key = req.params[0];
  if (!key) {
    return res.status(400).json({ error: 'Image key is required' });
  }

  if (!imageStorage.isEnabled()) {
    return res.status(503).json({ error: 'Image storage not configured' });
  }

  try {
    const url = await imageStorage.getPresignedUrl(key);
    res.redirect(302, url);
  } catch (err) {
    console.error('B2 image redirect error:', err.message);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

module.exports = router;
