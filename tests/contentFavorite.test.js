const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Content = require('../src/models/Content');
const contentController = require('../src/controllers/contentController');

const { ObjectId } = mongoose.Types;

// The content-editors star is PER-USER: favoritedBy holds the members who
// starred a doc, and it must never reach the client — listContents collapses it
// to a boolean for the caller. These pin that contract plus the two easy-to-lose
// details in setFavorite: the atomic operator choice and timestamps:false (the
// list is sorted updatedAt:-1 and renders "last edited" from it, so a bumped
// timestamp would jump the row to the top and claim it was just edited).

const wsId = new ObjectId();
const me = new ObjectId();
const someoneElse = new ObjectId();

const originalFindOneAndUpdate = Content.findOneAndUpdate;
const originalFindSummaries = Content.findSummariesByWorkspace;
const originalFindByNumber = Content.findByNumber;

let updateCall;
let updateResult;
let summaries;

beforeEach(() => {
  updateCall = null;
  updateResult = { _id: new ObjectId() };
  Content.findOneAndUpdate = async (filter, update, options) => {
    updateCall = { filter, update, options };
    return updateResult;
  };
  // findSummariesByWorkspace returns a Query in production; listContents only
  // ever calls .lean() on it, so a thenable with .lean() is a faithful stub.
  Content.findSummariesByWorkspace = () => ({ lean: async () => summaries });
});

afterEach(() => {
  Content.findOneAndUpdate = originalFindOneAndUpdate;
  Content.findSummariesByWorkspace = originalFindSummaries;
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

function mockReq(body = {}) {
  return {
    params: { contentNumber: '5', workspaceNumber: '123' },
    query: {},
    workspace: { _id: wsId },
    user: { userId: me },
    body,
  };
}

describe('setFavorite — per-user star toggle', () => {
  it('favorite:true adds the caller to favoritedBy', async () => {
    const res = mockRes();
    await contentController.setFavorite(mockReq({ favorite: true }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { favorite: true });
    assert.deepEqual(updateCall.update, { $addToSet: { favoritedBy: me } });
  });

  it('favorite:false removes only the caller', async () => {
    const res = mockRes();
    await contentController.setFavorite(mockReq({ favorite: false }), res);

    assert.deepEqual(res.body, { favorite: false });
    assert.deepEqual(updateCall.update, { $pull: { favoritedBy: me } });
  });

  it('anything other than a literal true unstars (no accidental truthiness)', async () => {
    const res = mockRes();
    await contentController.setFavorite(mockReq({ favorite: 'yes' }), res);

    assert.deepEqual(res.body, { favorite: false });
    assert.deepEqual(updateCall.update, { $pull: { favoritedBy: me } });
  });

  it('scopes the write to the caller workspace + contentNumber', async () => {
    await contentController.setFavorite(mockReq({ favorite: true }), mockRes());

    assert.deepEqual(updateCall.filter, { workspaceId: wsId, contentNumber: 5 });
  });

  it('does NOT bump updatedAt', async () => {
    await contentController.setFavorite(mockReq({ favorite: true }), mockRes());

    assert.equal(updateCall.options.timestamps, false,
      'starring must not touch updatedAt — it would reorder the list and fake a recent edit');
  });

  it('404s on an unknown contentNumber', async () => {
    updateResult = null;
    const res = mockRes();
    await contentController.setFavorite(mockReq({ favorite: true }), res);

    assert.equal(res.statusCode, 404);
  });
});

describe('listContents — favoritedBy never reaches the client', () => {
  it('maps favoritedBy to a per-caller boolean and strips the array', async () => {
    summaries = [
      { contentNumber: 1, title: 'mine', favoritedBy: [someoneElse, me] },
      { contentNumber: 2, title: 'theirs', favoritedBy: [someoneElse] },
      { contentNumber: 3, title: 'nobody', favoritedBy: [] },
      { contentNumber: 4, title: 'legacy doc, field absent' },
    ];

    const res = mockRes();
    await contentController.listContents(mockReq(), res);

    assert.deepEqual(res.body.contents.map((c) => c.favorite), [true, false, false, false]);
    for (const c of res.body.contents) {
      assert.ok(!('favoritedBy' in c), `favoritedBy leaked on content ${c.contentNumber}`);
    }
  });

  it('compares by string so ObjectId identity is not required', async () => {
    summaries = [{ contentNumber: 1, favoritedBy: [String(me)] }];

    const res = mockRes();
    await contentController.listContents(mockReq(), res);

    assert.equal(res.body.contents[0].favorite, true);
  });
});

describe('getContent — the full-doc endpoint strips favoritedBy too', () => {
  it('returns the document without favoritedBy, leaving everything else intact', async () => {
    const doc = {
      _id: new ObjectId(),
      workspaceId: wsId,
      contentNumber: 5,
      title: 'Post',
      locked: false,
      blocks: [],
      favoritedBy: [me, someoneElse],
    };
    Content.findByNumber = async () => ({ ...doc, toObject: () => ({ ...doc }) });

    const res = mockRes();
    await contentController.getContent(mockReq(), res);

    assert.equal(res.statusCode, 200);
    assert.ok(!('favoritedBy' in res.body.content), 'favoritedBy must not reach the editor');
    assert.equal(res.body.content.title, 'Post');
    assert.equal(res.body.content.contentNumber, 5);
  });
});
