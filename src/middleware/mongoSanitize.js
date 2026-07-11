'use strict';

/**
 * Phase 20 — MongoDB operator-injection guard (zero-dependency).
 *
 * Recursively removes any object key beginning with '$' from req.body / req.query
 * / req.params. Those keys are the NoSQL-injection vector: a JSON body or query
 * like `{ "email": { "$ne": null } }` can turn an equality lookup into an operator
 * query (auth bypass, data disclosure). This is defense-in-depth — Mongoose schema
 * casting already neutralizes operator objects on typed paths — but it closes any
 * untyped / dynamically-built query fragment.
 *
 * We strip keys rather than the `express-mongo-sanitize` package because that
 * package is unmaintained and breaks on Express 5's read-only req.query. Values
 * are never touched (only keys), so legitimate payloads are unaffected.
 */

// Strip forbidden keys in place at ANY depth; returns the same reference.
// Iterative (explicit stack) so a deeply-nested payload can't overflow the call
// stack, and cycle-guarded (WeakSet) as belt-and-suspenders — JSON bodies never
// contain cycles, but req.body isn't always JSON-sourced. Removes MongoDB operator
// keys ('$...') and prototype-pollution keys ('__proto__'/'constructor'/'prototype').
function isForbidden(key) {
  return key.charCodeAt(0) === 36 /* '$' */ || key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function strip(root) {
  if (root === null || typeof root !== 'object') return root;
  const seen = new WeakSet([root]);
  const stack = [root];
  while (stack.length) {
    const obj = stack.pop();
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === 'object' && !seen.has(item)) { seen.add(item); stack.push(item); }
      }
      continue;
    }
    for (const key of Object.keys(obj)) {
      if (isForbidden(key)) {
        delete obj[key];
      } else {
        const v = obj[key];
        if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); stack.push(v); }
      }
    }
  }
  return root;
}

function mongoSanitize(req, _res, next) {
  if (req.body && typeof req.body === 'object') strip(req.body);
  if (req.params && typeof req.params === 'object') strip(req.params);
  // Express 4's req.query is a getter that RE-PARSES on each access, so mutating
  // the returned object doesn't persist. Sanitize once and pin it as a data
  // property so every downstream read sees the cleaned object.
  if (req.query && typeof req.query === 'object') {
    const cleaned = strip(req.query);
    Object.defineProperty(req, 'query', {
      value: cleaned,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  next();
}

module.exports = mongoSanitize;
module.exports._strip = strip; // exported for unit tests
