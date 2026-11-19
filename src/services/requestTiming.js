/**
 * Server-Timing for API responses (QA B32: the article list took 3-6 s in
 * production and there was no way to see where the time went).
 *
 * Authenticated /api responses (see exposeTo) carry:
 *   Server-Timing: app;dur=<ms in Express>, db;dur=<ms in Mongo>;desc="<n> queries"
 * so a production trace is one browser session (DevTools → Network → Timing),
 * not a code change. The Next proxy routes relay it (lib/backendProxy
 * relayHeaders) and add their own "proxy" entry.
 *
 * DB time is collected by a global Mongoose plugin (query, aggregate and
 * save hooks) into the request's AsyncLocalStorage context. Durations of
 * overlapping queries add up, so db can exceed app for parallel queries;
 * the query COUNT is the number that exposes duplicated work.
 */
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const als = new AsyncLocalStorage();
const START = Symbol('srTimingStart');

const QUERY_OPS = [
  'count', 'countDocuments', 'estimatedDocumentCount', 'distinct',
  'find', 'findOne', 'findOneAndDelete', 'findOneAndReplace', 'findOneAndUpdate',
  'deleteOne', 'deleteMany', 'replaceOne', 'updateOne', 'updateMany',
];

function begin(target) { if (als.getStore()) target[START] = process.hrtime.bigint(); }
function end(target) {
  const ctx = als.getStore();
  const t0 = target[START];
  if (!ctx || typeof t0 !== 'bigint') return;
  ctx.dbMs += Number(process.hrtime.bigint() - t0) / 1e6;
  ctx.dbOps += 1;
  target[START] = undefined;
}

function timingPlugin(schema) {
  schema.pre(QUERY_OPS, { document: false, query: true }, function () { begin(this); });
  schema.post(QUERY_OPS, { document: false, query: true }, function () { end(this); });
  schema.pre('aggregate', function () { begin(this); });
  schema.post('aggregate', function () { end(this); });
  // Global plugins also reach embedded schemas, whose save hooks fire once
  // per subdocument: one article save counted as 100+ "queries". Only the
  // top-level document's save is a database operation.
  schema.pre('save', function () { if (!this.$isSubdocument) begin(this); });
  schema.post('save', function () { if (!this.$isSubdocument) end(this); });
  // Model-level bulk writes: the hooks run on the Model, not on a per-call
  // object, so concurrent calls could not be timed apart. Counted, not timed.
  schema.post('insertMany', function () { countOnly(); });
  schema.post('bulkWrite', function () { countOnly(); });
}

function countOnly() { const ctx = als.getStore(); if (ctx) ctx.dbOps += 1; }

/**
 * Re-enter a request's timing context. For middleware that continues the
 * chain from a stream callback (multer/busboy), where AsyncLocalStorage
 * context is lost: `upload.single('file')(req, res, (err) => resume(req, () => next()))`.
 */
function resume(req, fn) {
  const ctx = req && req._srTiming;
  return ctx ? als.run(ctx, fn) : fn();
}

let installed = false;
/** Register the plugin. Must run before any model is compiled (top of index.js). */
function installMongoosePlugin() {
  if (installed) return;
  installed = true;
  mongoose.plugin(timingPlugin);
}

/** The header value for a finished context. */
function headerValue(ctx) {
  const app = Number(process.hrtime.bigint() - ctx.start) / 1e6;
  return `app;dur=${app.toFixed(1)}, db;dur=${ctx.dbMs.toFixed(1)};desc="${ctx.dbOps} queries"`;
}

/**
 * Who gets the header. Only requests already authenticated (req.user set by
 * authenticateToken/optionalAuth), and never the auth routes: there the
 * query count would say whether an account exists (a wrong password for a
 * real account runs 2 queries, an unknown email 1), and the server time
 * would sharpen the same signal. Every request is still measured, for the
 * server-side [timing] log line.
 */
function exposeTo(req) {
  if (!req.user) return false;
  const url = req.originalUrl || req.url || '';
  return !url.startsWith('/api/auth/');
}

/** Express middleware: one timing context per request; header set at writeHead. */
function middleware(req, res, next) {
  const ctx = { start: process.hrtime.bigint(), dbMs: 0, dbOps: 0 };
  req._srTiming = ctx; // read by the slow-request [timing] log line in index.js
  const writeHead = res.writeHead;
  res.writeHead = function patchedWriteHead(...args) {
    try {
      if (!res.headersSent && !res.getHeader('Server-Timing') && exposeTo(req)) res.setHeader('Server-Timing', headerValue(ctx));
    } catch { /* never break a response over a diagnostic header */ }
    return writeHead.apply(this, args);
  };
  als.run(ctx, () => next());
}

module.exports = { installMongoosePlugin, middleware, timingPlugin, headerValue, exposeTo, resume, als, QUERY_OPS };
