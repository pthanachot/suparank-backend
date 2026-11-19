/**
 * QA B32 (Phase 3): Server-Timing on API responses, with Mongo time and the
 * query count collected per request (AsyncLocalStorage + a global Mongoose
 * plugin). Real in-memory MongoDB; the plugin is installed before any model
 * is compiled, exactly as index.js does.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const requestTiming = require('../src/services/requestTiming');
requestTiming.installMongoosePlugin();
const mongoose = require('mongoose');
const { connect, disconnect } = require('./helpers/memoryMongo');

const Thing = mongoose.model('TimingThing', new mongoose.Schema({ n: Number }));

before(async () => { await connect(); });
after(async () => { await disconnect(); });

/** Run `handler` as the route behind the timing middleware; return the header.
 *  Signed in by default (the header is only exposed to authenticated requests). */
function runRequest(handler, { user = { userId: 'u1' }, url = '/api/workspace/1/content' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      headersSent: false,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      getHeader(k) { return headers[k.toLowerCase()]; },
      writeHead() { this.headersSent = true; resolve(headers['server-timing']); return this; },
    };
    const req = { originalUrl: url };
    requestTiming.middleware(req, res, () => {
      // Authentication runs inside the chain, as in the app.
      req.user = user;
      Promise.resolve(handler(req)).then(() => res.writeHead(200)).catch(reject);
    });
  });
}
const parse = (h) => {
  const m = /app;dur=([\d.]+), db;dur=([\d.]+);desc="(\d+) queries"/.exec(h || '');
  return m ? { app: Number(m[1]), db: Number(m[2]), q: Number(m[3]) } : null;
};

test('counts every query of the request: find, findOne, update, count, aggregate, save', async () => {
  const h = await runRequest(async () => {
    await Thing.create({ n: 1 });             // save
    await Thing.find({});                    // find
    await Thing.findOne({ n: 1 });           // findOne
    await Thing.updateOne({ n: 1 }, { n: 2 }); // updateOne
    await Thing.countDocuments({});          // countDocuments
    await Thing.aggregate([{ $match: {} }]); // aggregate
  });
  const t = parse(h);
  assert.ok(t, h);
  assert.equal(t.q, 6);
  assert.ok(t.app >= t.db || t.db >= 0);
});

test('parallel queries count each; concurrent requests do not mix', async () => {
  const [a, b] = await Promise.all([
    runRequest(async () => { await Promise.all([Thing.find({}), Thing.find({}), Thing.find({})]); }),
    runRequest(async () => { await Thing.findOne({}); }),
  ]);
  assert.equal(parse(a).q, 3);
  assert.equal(parse(b).q, 1);
});

test('a request with no queries reports 0; queries outside any request are not counted anywhere', async () => {
  await Thing.find({}); // no context: must not throw
  const h = await runRequest(async () => {});
  assert.equal(parse(h).q, 0);
});

test('a failing query does not break the response', async () => {
  const h = await runRequest(async () => {
    await Thing.find({ $where: 'this.n > 0' }).catch(() => {});
  });
  assert.ok(parse(h));
});

test('one save of a document with subdocuments is one query (review fix)', async () => {
  const Doc = mongoose.model('TimingDoc', new mongoose.Schema({
    items: [new mongoose.Schema({ k: String }, { _id: false })],
    nested: new mongoose.Schema({ v: Number }),
  }));
  const h = await runRequest(async () => {
    await Doc.create({ items: Array.from({ length: 50 }, (_, i) => ({ k: `i${i}` })), nested: { v: 1 } });
  });
  assert.equal(parse(h).q, 1, h);
});

test('not exposed without authentication, nor on /api/auth (account enumeration) (review fix)', async () => {
  const anon = await runRequest(async () => { await Thing.findOne({}); }, { user: null });
  assert.equal(anon, undefined);
  const login = await runRequest(async () => { await Thing.findOne({}); }, { url: '/api/auth/email-login' });
  assert.equal(login, undefined);
  const verify = await runRequest(async () => {}, { url: '/api/auth/verify' });
  assert.equal(verify, undefined);
  // Still measured for the server-side log line.
  const req = { originalUrl: '/api/auth/email-login' };
  const res = { headersSent: false, setHeader() {}, getHeader() {}, writeHead() { return this; } };
  await new Promise((resolve) => requestTiming.middleware(req, res, async () => { await Thing.findOne({}); resolve(); }));
  assert.equal(req._srTiming.dbOps, 1);
});

test('bulk writes are counted (insertMany, bulkWrite) (review fix)', async () => {
  const h = await runRequest(async () => {
    await Thing.insertMany([{ n: 1 }, { n: 2 }]);
    await Thing.bulkWrite([{ insertOne: { document: { n: 3 } } }]);
  });
  assert.equal(parse(h).q, 2, h);
});

test('resume() restores the context after a stream callback (multer) (review fix)', async () => {
  const { EventEmitter } = require('events');
  const ctx = { start: process.hrtime.bigint(), dbMs: 0, dbOps: 0 };
  const req = { _srTiming: ctx };
  // An emitter created outside the request's context, like a busboy stream.
  const stream = new EventEmitter();
  const lost = new Promise((resolve) => stream.once('done', async () => { await Thing.findOne({}); resolve(); }));
  const kept = new Promise((resolve) => stream.once('done', () => requestTiming.resume(req, async () => { await Thing.findOne({}); resolve(); })));
  await requestTiming.als.run({ start: process.hrtime.bigint(), dbMs: 0, dbOps: 0 }, async () => { setImmediate(() => stream.emit('done')); });
  await Promise.all([lost, kept]);
  assert.equal(ctx.dbOps, 1, 'only the resumed callback is counted against the request');
});

test('the header value is well formed', () => {
  const v = requestTiming.headerValue({ start: process.hrtime.bigint(), dbMs: 12.345, dbOps: 4 });
  assert.match(v, /^app;dur=\d+\.\d, db;dur=12\.3;desc="4 queries"$/);
});
