const mongoose = require('mongoose');

/**
 * Install ObjectId validation onto a router for every known ID parameter.
 *
 * Express 4.x param callbacks are router-local — they don't propagate to
 * mounted sub-routers. So `app.param(...)` on the main app does NOT fire
 * for params extracted by sub-routers. The correct hook is to register
 * on each router that actually defines the parameter.
 *
 * On invalid input, responds 400 with the offending key. Eliminates the
 * CastError-500 bug family at the framework level — no individual handler
 * has to remember.
 *
 * Usage (at top of each route file that uses ID params):
 *   const router = express.Router();
 *   require('../middleware/validateIdParams')(router);
 *   router.get('/:sitemapId', handler);
 *
 * To support a new ID param name, add it to ID_PARAMS below.
 */

// Every ObjectId-shaped param name used across the route tree. Numeric IDs
// (workspaceNumber, contentNumber) are intentionally omitted — those use a
// different scheme and pass through unchecked.
const ID_PARAMS = [
  'avatarId',
  'sitemapId',
  'siteId',
  'monitorId',
  'promptId',
  'competitorId',
  'uploadId',
  'brandVoiceId',
  'historyId',
];

function installIdValidators(router) {
  for (const name of ID_PARAMS) {
    router.param(name, (req, res, next, value) => {
      if (!mongoose.Types.ObjectId.isValid(value)) {
        return res.status(400).json({ error: `Invalid ${name}` });
      }
      return next();
    });
  }
}

module.exports = installIdValidators;
module.exports.ID_PARAMS = ID_PARAMS;
