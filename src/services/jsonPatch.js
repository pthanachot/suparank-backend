/**
 * Minimal RFC 6902 JSON Patch applier (add / replace / remove only).
 *
 * Scoped to the subset needed by plan-mode updates. Does NOT implement
 * move/copy/test — those aren't whitelisted in planValidator.PATCH_ALLOWED_OPS.
 *
 * Mutates the target object in place AND returns it for chaining. Caller is
 * responsible for marking Mongoose Mixed paths (evidenceMap) modified after.
 */

// Defense-in-depth: even though planValidator.PATCH_ALLOWED_PATHS doesn't
// permit these keys, the JSON Patch utility itself should refuse them. Any
// future caller bypassing the validator (or a regex widened by mistake)
// would otherwise be a prototype-pollution vector.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function parsePointer(path) {
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new Error(`Invalid JSON Pointer: "${path}"`);
  }
  const segments = path
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      throw new Error(`Forbidden segment "${seg}" in path "${path}"`);
    }
  }
  return segments;
}

function applyOp(target, op) {
  if (!op || typeof op !== 'object') {
    throw new Error('op must be an object');
  }
  const segments = parsePointer(op.path);

  if (segments.length === 0) {
    // Root replace
    if (op.op === 'replace') {
      // Cannot replace the root object reference itself; caller must do that.
      // We treat it as "assign all keys" which is rarely what's wanted — reject.
      throw new Error('replace at root is not supported');
    }
    throw new Error(`${op.op} at root is not supported`);
  }

  const lastKey = segments[segments.length - 1];
  let parent = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (parent === null || parent === undefined) {
      throw new Error(`Path "${op.path}" traverses through null/undefined at segment ${i}`);
    }
    if (Array.isArray(parent)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
        throw new Error(`Path "${op.path}" has invalid array index "${key}" at segment ${i}`);
      }
      parent = parent[idx];
    } else if (typeof parent === 'object') {
      parent = parent[key];
    } else {
      throw new Error(`Path "${op.path}" traverses through non-object at segment ${i}`);
    }
  }

  if (parent === null || parent === undefined) {
    throw new Error(`Path "${op.path}" parent is null/undefined`);
  }

  if (Array.isArray(parent)) {
    if (lastKey === '-') {
      if (op.op === 'add') {
        parent.push(op.value);
        return target;
      }
      throw new Error(`"${op.op}" cannot target array append "-"`);
    }
    const idx = Number(lastKey);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
      throw new Error(`Invalid array index "${lastKey}" in path "${op.path}"`);
    }
    if (op.op === 'add') {
      parent.splice(idx, 0, op.value);
    } else if (op.op === 'replace') {
      if (idx >= parent.length) throw new Error(`replace target out of bounds: ${op.path}`);
      parent[idx] = op.value;
    } else if (op.op === 'remove') {
      if (idx >= parent.length) throw new Error(`remove target out of bounds: ${op.path}`);
      parent.splice(idx, 1);
    } else {
      throw new Error(`Unsupported op "${op.op}"`);
    }
    return target;
  }

  if (typeof parent !== 'object') {
    throw new Error(`Path "${op.path}" parent is not an object`);
  }

  if (op.op === 'add' || op.op === 'replace') {
    parent[lastKey] = op.value;
  } else if (op.op === 'remove') {
    delete parent[lastKey];
  } else {
    throw new Error(`Unsupported op "${op.op}"`);
  }
  return target;
}

/**
 * Apply an ordered array of ops to a target object. Mutates target in place.
 * If any op throws, partial mutations from earlier ops are preserved — caller
 * should validate ops first via planValidator.validateOps to avoid this.
 */
function applyPatch(target, ops) {
  for (const op of ops) applyOp(target, op);
  return target;
}

module.exports = { applyPatch, applyOp, parsePointer };
