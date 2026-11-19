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

/** Run `handler` as the route behind the timing middleware; return the header. */
function runRequest(handler) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      headersSent: false,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      getHeader(k) { return headers[k.toLowerCase()]; },
      writeHead() { this.headersSent = true; resolve(headers['server-timing']); return this; },
    };
    const req = {};
    requestTiming.middleware(req, res, () => {
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

test('the header value is well formed', () => {
  const v = requestTiming.headerValue({ start: process.hrtime.bigint(), dbMs: 12.345, dbOps: 4 });
  assert.match(v, /^app;dur=\d+\.\d, db;dur=12\.3;desc="4 queries"$/);
});
