/**
 * Server-side "marked done" lock (QA gap: the lock used to live only in the
 * browser, so another tab, a stale page or a direct API call could still change
 * a finished article).
 *
 * The rule, in one place:
 *   - A done article's CONTENT (blocks, title, slug, description) cannot change.
 *   - Everything else still saves: score/word count, version snapshots,
 *     published URL, comments, favorites, folder, and the status itself.
 *   - Moving the status away from "done" (Reopen as draft) is always allowed,
 *     even in the same request that carries the body. That is how the editor's
 *     Reopen button works (it PUTs the whole document with the new status).
 *   - A save whose content is identical to what is stored is not a change, so
 *     an ordinary autosave of a done article (score, versions) never fails.
 *   - AI runs cannot start on a done article (see lockGuard.rejectIfDone).
 */

const DONE_CODE = 'ARTICLE_DONE';
const CONTENT_FIELDS = ['title', 'slug', 'description', 'blocks'];

const MESSAGES = {
  edit: 'This article is marked done. Reopen it as a draft to edit it.',
  ai: 'This article is marked done. Reopen it as a draft to use the AI on it.',
};

/** The 409 body every done-lock refusal uses. `done: true` mirrors the
 *  `locked: true` flag the downgrade lock sends, so clients can branch on it. */
function doneLockBody(kind = 'edit') {
  return { error: MESSAGES[kind] || MESSAGES.edit, code: DONE_CODE, done: true, status: 'done' };
}

/** True when this update moves the article out of "done". */
function isReopen(updates) {
  return updates.status !== undefined && updates.status !== null && updates.status !== 'done';
}

/** True when the update names any content field (whether or not it differs). */
function touchesContent(updates) {
  return CONTENT_FIELDS.some((f) => updates[f] !== undefined);
}

/** JSON with sorted keys and undefined dropped, so key order and absent
 *  optional fields never count as a difference. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Cast blocks through the Content model so both sides of a comparison carry
 * the same defaults (text: '', faqItems: []) and drop the same unknown fields.
 * The stored copy is cast the same way, so legacy rows compare fairly too.
 */
function castBlocks(Model, blocks) {
  const doc = new Model({ blocks: Array.isArray(blocks) ? blocks : [] });
  return doc.toObject({ depopulate: true, versionKey: false }).blocks || [];
}

/**
 * Does this update change the article's content compared with `current`
 * (a lean or hydrated Content with the CONTENT_FIELDS selected)?
 * Only fields present in the update are compared.
 */
function changesContent(Model, current, updates) {
  for (const f of ['title', 'slug', 'description']) {
    if (updates[f] === undefined) continue;
    const next = updates[f] === null ? '' : String(updates[f]);
    const prev = current[f] === undefined || current[f] === null ? '' : String(current[f]);
    if (next !== prev) return true;
  }
  if (updates.blocks !== undefined) {
    const next = canonical(castBlocks(Model, updates.blocks));
    const prev = canonical(castBlocks(Model, current.blocks));
    if (next !== prev) return true;
  }
  return false;
}

module.exports = {
  DONE_CODE,
  CONTENT_FIELDS,
  doneLockBody,
  isReopen,
  touchesContent,
  changesContent,
  canonical,
};
