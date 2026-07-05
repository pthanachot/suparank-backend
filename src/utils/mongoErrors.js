/**
 * Robust MongoDB duplicate-key (E11000) detection.
 *
 * A duplicate-key violation does NOT always surface as a top-level
 * `err.code === 11000`. Inside a transaction, or from a bulk/array
 * `Model.create([...], { session })`, it can arrive as a BulkWriteError whose
 * 11000 lives in `err.writeErrors[]` or `err.result`. Callers that branch on
 * duplicate-key (idempotency guards) must check all these shapes or they will
 * misclassify a duplicate as a transient error and spuriously retry / 500.
 */
function isDuplicateKeyError(err) {
  if (!err) return false;
  if (err.code === 11000) return true;
  if (Array.isArray(err.writeErrors) && err.writeErrors.some((e) => e && e.code === 11000)) {
    return true;
  }
  const resultErrors = err.result && err.result.result && err.result.result.writeErrors;
  if (Array.isArray(resultErrors) && resultErrors.some((e) => e && e.code === 11000)) {
    return true;
  }
  if (err.cause && err.cause.code === 11000) return true;
  return false;
}

module.exports = { isDuplicateKeyError };
