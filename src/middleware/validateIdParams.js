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
// CAUTION: only include param names that are ACTUAL Mongoose ObjectIds.
// `commentId` was wrongly added in an earlier pass — comments use a custom
// string id like `c1781012097288_la17`, NOT an ObjectId. Including it here
// caused validateIdParams to reject every real comment edit/delete with a
// misleading "Invalid commentId" 400. The smoke test caught it.
//
// When adding a new param, verify by inspecting the model — if its `_id`
// field is `String` (or custom), do NOT add it here.
const ID_PARAMS = [
  // Bare :id (used in admin email-template / feedback routes)
  'id',
  // Workspace tools
  'avatarId',
  'brandVoiceId',
  'competitorId',
  'historyId',
  'monitorId',
  'promptId',
  'siteId',
  'sitemapId',
  'uploadId',
  // Org / user / admin
  'domainId',
  'memberId',
  'orgId',
  'sessionId',
  'subId',
  'triggerId',
  'workspaceId',
];

// Numeric-id route params. Smoke test caught these returning 500 on
// non-numeric values because the controller does Number(rawValue) → NaN →
// query throws somewhere downstream.
// `userId` lives here, NOT in ID_PARAMS: every :userId route (all in
// adminRoutes) looks up the numeric public userId via
// `findOne({ userId: parseInt(...) })` — validating it as an ObjectId
// rejected every real admin user operation with 400 "Invalid userId".
const NUMERIC_PARAMS = ['contentNumber', 'workspaceNumber', 'userId'];

function installIdValidators(router) {
  for (const name of ID_PARAMS) {
    router.param(name, (req, res, next, value) => {
      if (!mongoose.Types.ObjectId.isValid(value)) {
        return res.status(400).json({ error: `Invalid ${name}` });
      }
      return next();
    });
  }
  for (const name of NUMERIC_PARAMS) {
    router.param(name, (req, res, next, value) => {
      if (!/^\d+$/.test(value)) {
        return res.status(400).json({ error: `Invalid ${name}` });
      }
      return next();
    });
  }
}

module.exports = installIdValidators;
module.exports.ID_PARAMS = ID_PARAMS;
module.exports.NUMERIC_PARAMS = NUMERIC_PARAMS;
