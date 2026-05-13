/**
 * Lock guard middleware — prevents write operations on locked resources.
 *
 * Locked resources (from downgrade) return 403 RESOURCE_LOCKED.
 * DELETE is always allowed — users can delete locked resources to free slots.
 */

const Content = require('../models/Content');

/**
 * Factory: creates middleware that rejects if the target resource is locked.
 *
 * @param {mongoose.Model} Model - The Mongoose model to check
 * @param {string|Function} idResolver - Either a req.params key (string)
 *   or a function (req) => Promise<ObjectId|null> for custom lookups.
 */
function rejectIfLocked(Model, idResolver) {
  return async (req, res, next) => {
    // DELETE is always allowed — users can delete locked resources
    if (req.method === 'DELETE') return next();

    try {
      let doc;

      if (typeof idResolver === 'function') {
        doc = await idResolver(req);
      } else {
        const id = req.params[idResolver];
        if (!id) return next(); // No ID param — skip check
        doc = await Model.findById(id).select('locked').lean();
      }

      if (doc && doc.locked) {
        return res.status(403).json({
          error: 'This resource is locked. Upgrade your plan to unlock it.',
          code: 'RESOURCE_LOCKED',
        });
      }

      next();
    } catch (err) {
      console.error('[lockGuard] Error checking lock status:', err.message);
      next(); // Fail open — don't block on guard errors
    }
  };
}

/**
 * Content-specific lock resolver.
 * Content is looked up by workspaceId + contentNumber (not by _id).
 */
function contentLockResolver(req) {
  const workspaceId = req.workspace?._id;
  const contentNumber = req.params.contentNumber;
  if (!workspaceId || !contentNumber) return null;
  return Content.findOne({
    workspaceId,
    contentNumber: Number(contentNumber),
  })
    .select('locked')
    .lean();
}

module.exports = {
  rejectIfLocked,
  contentLockResolver,
};
