/**
 * Phase 17 — audit-log consolidation. The end-to-end proof that ties the whole
 * trail together with an IN-MEMORY store (no DB): an admin ACTION (Phase 14
 * instrumentation) → a ROW written via the real record()/create path (Phase
 * 12/13) → VISIBLE through the read API (Phase 15). Plus tamper-resistance: the
 * read routes are GET-only and there is no controller to mutate/delete rows.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const AdminAuditLog = require('../src/models/AdminAuditLog');
const adminController = require('../src/controllers/adminController');
const auditController = require('../src/controllers/adminAuditController');
const router = require('../src/routes/adminRoutes');

const User = require('../src/models/User');
const UserCredit = require('../src/models/UserCredit');
const CreditTransaction = require('../src/models/CreditTransaction');
const OrgMember = require('../src/models/OrgMember');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// ── In-memory AdminAuditLog store wired to record() (create) + read (find) ──
let store;
function matches(row, q) {
  for (const [k, v] of Object.entries(q)) {
    if (k === '$and') continue; // keyset cursor — not exercised here
    if (v && typeof v === 'object' && v.$regex) {
      if (!new RegExp(v.$regex, v.$options).test(String(row[k] ?? ''))) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

const saved = {};
beforeEach(() => {
  store = [];
  saved.create = AdminAuditLog.create;
  saved.find = AdminAuditLog.find;
  AdminAuditLog.create = async (doc) => {
    const row = { _id: 'id' + store.length, createdAt: new Date(Date.now() + store.length), ...doc };
    store.push(row);
    return row;
  };
  AdminAuditLog.find = (query) => {
    const chain = { _limit: undefined };
    chain.sort = () => chain;
    chain.limit = (n) => { chain._limit = n; return chain; };
    chain.lean = async () => {
      let rows = store.filter((r) => matches(r, query || {}));
      rows.sort((a, b) => b.createdAt - a.createdAt); // newest first
      return chain._limit ? rows.slice(0, chain._limit) : rows;
    };
    return chain;
  };
  // manageUserCredits deps
  saved.userFindOne = User.findOne;
  saved.goc = UserCredit.getOrCreateForUser;
  saved.log = CreditTransaction.logTransaction;
  saved.orgFind = OrgMember.findOne;
  User.findOne = async () => ({ _id: 'u1' });
  UserCredit.getOrCreateForUser = async () => ({ freeCredits: 100, save: async () => {} });
  CreditTransaction.logTransaction = async () => {};
  OrgMember.findOne = () => ({ select: () => ({ lean: async () => null }) });
});
afterEach(() => {
  AdminAuditLog.create = saved.create;
  AdminAuditLog.find = saved.find;
  User.findOne = saved.userFindOne;
  UserCredit.getOrCreateForUser = saved.goc;
  CreditTransaction.logTransaction = saved.log;
  OrgMember.findOne = saved.orgFind;
});

const flush = () => new Promise((r) => setImmediate(r)); // let fire-and-forget land

describe('audit E2E: action → row → visible via read API', () => {
  it('manageUserCredits writes a row the read API returns, with correct fields', async () => {
    await adminController.manageUserCredits(
      { params: { userId: '700' }, body: { action: 'add', amount: 50 }, user: { email: 'admin@x.co', userId: 'adminOid' } },
      mockRes()
    );
    await flush(); // the audit write is fire-and-forget (un-awaited by the controller)

    // Read it back through the actual read controller.
    const res = mockRes();
    await auditController.listAuditLog({ query: { action: 'admin.user.credits' } }, res);

    assert.equal(res.body.rows.length, 1, 'exactly one row visible via the read API');
    const row = res.body.rows[0];
    assert.equal(row.action, 'admin.user.credits');
    assert.equal(row.actorEmail, 'admin@x.co');
    assert.equal(row.targetType, 'user');
    assert.equal(row.targetId, '700');
    assert.deepEqual(row.after, { freeCredits: 150 }); // the diff survived the round trip
  });

  it('a FAILED action writes nothing the read API could surface', async () => {
    // bad amount → 400 before any mutation/audit
    await adminController.manageUserCredits(
      { params: { userId: '700' }, body: { action: 'add', amount: -5 }, user: { email: 'admin@x.co' } },
      mockRes()
    );
    await flush();
    const res = mockRes();
    await auditController.listAuditLog({ query: {} }, res);
    assert.equal(res.body.rows.length, 0, 'no audit row for a rejected action');
  });
});

describe('tamper-resistance', () => {
  it('every /audit-log route is GET-only (no mutate/delete verb)', () => {
    const auditRoutes = router.stack
      .filter((l) => l.route && l.route.path.startsWith('/audit-log'))
      .map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
    assert.ok(auditRoutes.length >= 2, 'found the audit-log routes');
    for (const r of auditRoutes) {
      assert.deepEqual(r.methods, ['get'], `${r.path} must be GET-only`);
    }
  });

  it('the audit controller exposes no mutate/delete handler', () => {
    for (const forbidden of ['create', 'update', 'delete', 'remove', 'patch']) {
      assert.equal(typeof auditController[forbidden], 'undefined', `no ${forbidden} handler`);
    }
    assert.equal(typeof auditController.listAuditLog, 'function');
    assert.equal(typeof auditController.exportAuditLog, 'function');
  });

  it('the model is append-only (createdAt, no updatedAt)', () => {
    assert.ok(AdminAuditLog.schema.path('createdAt'));
    assert.equal(AdminAuditLog.schema.path('updatedAt'), undefined);
  });
});
