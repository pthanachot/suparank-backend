const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Content = require('../src/models/Content');
const contextController = require('../src/controllers/contextController');
const planController = require('../src/controllers/planController');
const analysisController = require('../src/controllers/analysisController');

const { ObjectId } = mongoose.Types;

// B4: locked content (paid-created, then downgraded to free) must be inaccessible
// to EVERY user-facing AI/analysis/plan/context route — not just getContent. Each
// controller resolves content through its own resolveContent helper; the audit
// found the plan + context resolvers ungated, and the same one-line gate was
// applied across the whole content-serving surface. These pin the shared-resolver
// gate for a representative handler in each of the plan-named controllers plus one
// of the extended ones (analysis), all keyed on Content.findByNumber.

const wsId = new ObjectId();
const originalFindByNumber = Content.findByNumber;

let findByNumberResult;
beforeEach(() => {
  Content.findByNumber = async () => findByNumberResult;
});
afterEach(() => {
  Content.findByNumber = originalFindByNumber;
});

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq() {
  return {
    params: { contentNumber: '5', workspaceNumber: '123' },
    workspace: { _id: wsId },
    user: { userId: new ObjectId() },
    body: {},
  };
}

// Handlers whose FIRST action is resolveContent(req,res) — so the lock gate
// fires before any engine/credit work. On the lock path each returns 403 and
// never reaches its heavy logic (which would need the engine mocked).
const gated = [
  ['contextController.userList', contextController.userList],
  ['planController.enter', planController.enter],
  ['analysisController.reanalyze', analysisController.reanalyze],
];

describe('B4 content.locked gate — shared resolveContent surface', () => {
  for (const [name, handler] of gated) {
    it(`${name} → 403 { locked: true } on locked content`, async () => {
      findByNumberResult = { _id: new ObjectId(), workspaceId: wsId, locked: true };
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
      assert.equal(res.statusCode, 403, `${name} should 403 on locked content`);
      assert.equal(res.body.locked, true, `${name} must carry the locked:true contract`);
    });

    it(`${name} → 404 when the content does not exist (gate does not misfire)`, async () => {
      findByNumberResult = null;
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
      assert.equal(res.statusCode, 404, `${name} should 404 when content is missing`);
    });
  }
});
