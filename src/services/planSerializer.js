/**
 * Plan ↔ Go-side shape conversion.
 *
 * Mongoose's default serialization emits `_id` (ObjectId) for documents, but
 * Go's `state.Plan` expects `id` (string). Apply this helper at every
 * boundary where a Mongoose Plan crosses over to the Go writing-engine:
 *
 *   - Express's PATCH /api/internal/cfs/:ws/:c/write response (UpdatePlan
 *     parses the body and pushes the result back onto session.Plan so the
 *     in-loop completeness validator and ExitPlanMode citation collection
 *     see the post-update state, not the snapshot from request start).
 *
 *   - The M5 push-from-Express path that hydrates session.Plan at request
 *     start (POST /api/session/{id}/plan body shape).
 *
 * Anywhere a Mongoose Plan is sent to Go, route it through this helper.
 */

/**
 * Convert a Mongoose Plan (or POJO) to the Go-side wire shape.
 *
 *  - `_id` → `id` (string)
 *  - drops Mongoose internals (`__v`)
 *  - leaves nested ObjectIds as strings (default JSON serialization handles
 *    contentId / workspaceId because ObjectId#toString is the default
 *    serializer; we explicitly String() them so POJOs also work).
 *
 * Idempotent — calling on a plain object that already has `id` returns
 * an equivalent object.
 *
 * Returns null when given null/undefined so callers can pass through.
 */
function toGoPlan(plan) {
  if (plan == null) return null;
  const obj = typeof plan.toObject === 'function' ? plan.toObject() : plan;

  const out = { ...obj };

  // ID rename
  if (out._id !== undefined && out._id !== null) {
    out.id = String(out._id);
    delete out._id;
  }
  // ObjectId stringification for nested references
  if (out.contentId !== undefined && out.contentId !== null) {
    out.contentId = String(out.contentId);
  }
  if (out.workspaceId !== undefined && out.workspaceId !== null) {
    out.workspaceId = String(out.workspaceId);
  }

  // Drop Mongoose bookkeeping
  delete out.__v;

  return out;
}

module.exports = { toGoPlan };
