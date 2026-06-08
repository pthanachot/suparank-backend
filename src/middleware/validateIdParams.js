const mongoose = require('mongoose');

/**
 * Auto-validate any req.params key matching the ID pattern against
 * Mongoose's ObjectId check. Lets us delete the per-controller guards
 * (ensureValidObjectId) we've been sprinkling everywhere.
 *
 * Matches the convention: param keys ending in 'Id' (avatarId, sitemapId,
 * monitorId, etc.) and the bare 'id' key. Skips numeric route params like
 * 'workspaceNumber' which are not ObjectIds.
 *
 * On invalid, responds 400 with the offending key — clients get a clear
 * signal instead of the previous "500 Failed to do X" generic catch.
 *
 * Mount globally BEFORE route handlers:
 *   app.use(validateIdParams);
 *
 * Or per-router if global is too aggressive.
 */
const ID_KEY_RE = /Id$/;

function validateIdParams(req, res, next) {
  for (const [key, value] of Object.entries(req.params || {})) {
    // Skip non-Id-looking params (workspaceNumber, contentNumber, etc.)
    if (key !== 'id' && !ID_KEY_RE.test(key)) continue;
    // Skip if value happens to be all-digit (numeric ID — different scheme)
    if (typeof value === 'string' && /^\d+$/.test(value)) continue;
    if (!mongoose.Types.ObjectId.isValid(value)) {
      return res.status(400).json({ error: `Invalid ${key}` });
    }
  }
  return next();
}

module.exports = validateIdParams;
