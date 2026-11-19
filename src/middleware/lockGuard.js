/**
 * Lock guard middleware — prevents write operations on locked resources.
 *
 * Locked resources (from downgrade) return 403 RESOURCE_LOCKED.
 * DELETE is always allowed — users can delete locked resources to free slots.
 */

const Content = require('../models/Content');
const { doneLockBody } = require('../services/doneLock');

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
        // clientLocked is Workspace-only (Content lacks the field → undefined,
        // harmless). Selecting it lets the :workspaceId routes (updateWorkspace,
        // setActiveWorkspace) enforce the billing lock consistently with rwr.
        doc = await Model.findById(id).select('locked clientLocked').lean();
      }

      if (doc && (doc.locked || doc.clientLocked)) {
        // A billing-only lock (clientLocked, no downgrade lock) gets the billing
        // contract so the FE can show a "contact your agency" CTA; the downgrade
        // lock keeps the existing RESOURCE_LOCKED / upgrade contract.
        const billingOnly = doc.clientLocked && !doc.locked;
        return res.status(403).json({
          error: billingOnly
            ? 'This workspace is suspended pending payment. Contact your agency to restore access.'
            : 'This resource is locked. Upgrade your plan to unlock it.',
          code: billingOnly ? 'WORKSPACE_CLIENT_LOCKED' : 'RESOURCE_LOCKED',
          // Same field the read gate (contentController.getContent) uses, so
          // both lock gates speak the one contract the editor understands.
          locked: true,
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

/**
 * Refuse to START AI work on an article marked done (the server half of the
 * editor's B28 lock; see services/doneLock). Mount it AFTER the permission
 * checks and BEFORE requireCredits, so a refused run never holds credits.
 *
 * `quiet: true` is for ghost-text autocomplete: a refusal there answers like
 * "no suggestion" (200 { completion: '' }) instead of an error the editor
 * would surface on every typing pause.
 *
 * Fails open on a lookup error, like rejectIfLocked: this is a workflow lock,
 * not an access control, and a DB hiccup must not block every AI request.
 */
function rejectIfDone({ quiet = false } = {}) {
  const guard = async (req, res, next) => {
    try {
      const workspaceId = req.workspace?._id;
      const contentNumber = Number(req.params.contentNumber);
      if (!workspaceId || !Number.isFinite(contentNumber)) return next();
      const doc = await Content.findOne({ workspaceId, contentNumber }, { status: 1 }, { lean: true });
      if (doc && doc.status === 'done') {
        if (quiet) return res.json({ completion: '' });
        return res.status(409).json(doneLockBody('ai'));
      }
      next();
    } catch (err) {
      console.error('[lockGuard] Error checking done status:', err.message);
      next();
    }
  };
  // Marker for the route-wiring tests (which routes carry the done guard).
  guard.doneGuard = quiet ? 'quiet' : true;
  return guard;
}

module.exports = {
  rejectIfLocked,
  contentLockResolver,
  rejectIfDone,
};
