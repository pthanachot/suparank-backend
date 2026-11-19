/**
 * Optimistic concurrency for content saves (QA Nov 2026: B03, backend half).
 *
 * Autosave PUTs the whole document. The save used to be an unconditional
 * $set, so two tabs (or two collaborators) silently overwrote each other —
 * last writer wins, the loser's edits vanish with no signal.
 *
 * Contract:
 *   - Content.revision is a counter, 0 for rows that predate it.
 *   - GET /content/:n and every successful PUT return `content.revision`.
 *   - PUT accepts `baseRevision` (the revision the client last saw). The write
 *     is filtered on it and increments it; a stale baseRevision is a 409
 *     { error: 'revision_conflict', revision, content } with the server copy.
 *   - baseRevision absent → accepted as before (backward compatible), the
 *     revision is still bumped so revision-aware clients notice the write.
 */

class RevisionInputError extends Error {}

/**
 * Parse body.baseRevision. Returns null when absent, a non-negative integer
 * when valid; throws RevisionInputError on anything else (400).
 */
function parseBaseRevision(body) {
  if (!body || body.baseRevision === undefined || body.baseRevision === null) return null;
  const n = typeof body.baseRevision === 'string' && body.baseRevision.trim() !== ''
    ? Number(body.baseRevision)
    : body.baseRevision;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new RevisionInputError('baseRevision must be a non-negative integer');
  }
  return n;
}

/**
 * Same-writer ordering. A tab's own saves can overlap: the tab-hide keepalive
 * flush goes out while an autosave is still in flight, and an aborted PUT can
 * still commit on the server. Each then carries the same baseRevision, so the
 * later one used to 409 against the tab's OWN earlier write and raise the
 * conflict banner for a conflict that does not exist.
 *
 * The client sends `writer: { id, seq }`: a random id per editor session and
 * a counter that grows with every PUT it sends. A stale baseRevision is still
 * accepted when the document's last write came from the SAME writer with a
 * LOWER seq — that write is this writer's own, older state, so writing over it
 * loses nothing. Any write from someone else (or without a writer) clears the
 * marker, so a different tab or collaborator is always a real conflict, and an
 * older same-writer save arriving late (lower seq) can never overwrite newer.
 *
 * Returns null when absent; throws RevisionInputError when malformed.
 */
function parseWriter(body) {
  const w = body?.writer;
  if (w === undefined || w === null) return null;
  const id = typeof w.id === 'string' ? w.id : '';
  const seq = w.seq;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !Number.isInteger(seq) || seq < 1) {
    throw new RevisionInputError('writer must be { id: 8-64 url-safe chars, seq: positive integer }');
  }
  return { id, seq };
}

/**
 * The extra filter for the conditional update. Rows written before the field
 * existed have no `revision` at all and read as 0, so baseRevision 0 must also
 * match a missing field.
 */
function revisionFilter(baseRevision, writer = null) {
  if (baseRevision === null || baseRevision === undefined) return {};
  const base = baseRevision === 0
    ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
    : { revision: baseRevision };
  if (!writer) return base;
  return { $or: [base, { 'lastWriter.id': writer.id, 'lastWriter.seq': { $lt: writer.seq } }] };
}

/** The update document: the caller's $set plus the revision bump and writer marker. */
function revisionUpdate(set, writer = null) {
  if (writer) return { $set: { ...set, lastWriter: { id: writer.id, seq: writer.seq } }, $inc: { revision: 1 } };
  return { $set: set, $unset: { lastWriter: 1 }, $inc: { revision: 1 } };
}

/**
 * The 409 body. `content` must already be in the GET response shape.
 * `lastWriter` lets a client recognise a 409 caused by its own NEWER write
 * (e.g. a late in-flight save after the keepalive flush) and not show a
 * conflict for it.
 */
function conflictBody(serverContent, lastWriter = null) {
  return {
    error: 'revision_conflict',
    message: 'This document was changed somewhere else since you opened it.',
    revision: Number(serverContent?.revision) || 0,
    content: serverContent,
    ...(lastWriter && lastWriter.id ? { lastWriter: { id: lastWriter.id, seq: Number(lastWriter.seq) || 0 } } : {}),
  };
}

module.exports = {
  parseBaseRevision, parseWriter, revisionFilter, revisionUpdate, conflictBody, RevisionInputError,
};
