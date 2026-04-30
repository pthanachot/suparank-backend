/**
 * Tests for brandVoiceController.js — avatar CRUD, image upload/delete,
 * workspace validation, and avatar markdown generation.
 *
 * Tests pure/deterministic logic without requiring a database connection.
 * Mocks Mongoose models and external services.
 */

// ── Mock setup ─────────────────────────────────────────────────

const mockSave = jest.fn().mockResolvedValue({});
const mockLean = jest.fn();

const mockWorkspace = { _id: 'ws-1', workspaceNumber: 42, userId: 'user-1' };
const mockAvatar = {
  _id: 'av-1',
  workspace: 'ws-1',
  name: 'Test Writer',
  emoji: '✍️',
  role: 'Blogger',
  experience: '5 years',
  tagline: 'Writes like a friend',
  traits: ['witty', 'concise'],
  writingQuirks: 'Uses analogies',
  toneOverrides: { formality: 30, warmth: 70, humor: null },
  vocabulary: { uses: ['leverage'], avoids: ['synergy'] },
  openingStyle: 'contrarian',
  sample: 'Here is a sample.',
  background: 'Tech background',
  avatarImage: '',
  active: true,
  uploads: [],
  content: '# Test Writer',
  b2Key: 'brand-voice/ws-1/avatars/av-1/avatar.md',
  toObject: function () { return { ...this }; },
  save: mockSave,
};

// Mock Workspace model
jest.mock('../src/models/Workspace', () => ({
  findOne: jest.fn().mockResolvedValue(mockWorkspace),
}));

// Mock Avatar model
jest.mock('../src/models/Avatar', () => {
  const mock = {
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([mockAvatar]) }) }),
    findOne: jest.fn().mockResolvedValue({ ...mockAvatar, save: mockSave, toObject: mockAvatar.toObject }),
    findOneAndDelete: jest.fn().mockResolvedValue(mockAvatar),
    findOneAndUpdate: jest.fn().mockResolvedValue(mockAvatar),
    findById: jest.fn().mockResolvedValue({ ...mockAvatar, save: mockSave, toObject: mockAvatar.toObject }),
    create: jest.fn().mockResolvedValue({ ...mockAvatar, save: mockSave }),
  };
  return mock;
});

// Mock BrandVoice model
jest.mock('../src/models/BrandVoice', () => ({
  findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
}));

// Mock BrandVoiceTestLog
jest.mock('../src/models/BrandVoiceTestLog', () => ({
  countDocuments: jest.fn().mockResolvedValue(0),
  create: jest.fn().mockResolvedValue({}),
}));

// Mock imageStorage
jest.mock('../src/services/imageStorage', () => ({
  uploadBuffer: jest.fn().mockResolvedValue('brand-voice/ws-1/avatars/av-1/avatar.md'),
  uploadImage: jest.fn().mockResolvedValue('/api/b2-image/images/ws-1/avatar-av-1/123-abc.jpg'),
  deleteObject: jest.fn().mockResolvedValue(undefined),
}));

// Mock writingEngine
jest.mock('../src/services/writingEngine', () => ({
  createSession: jest.fn().mockResolvedValue('session-1'),
  pushDocument: jest.fn().mockResolvedValue(undefined),
  sendChatMessageStream: jest.fn().mockResolvedValue({
    body: { getReader: () => ({ read: jest.fn().mockResolvedValue({ done: true }) }) },
  }),
}));

/** Build a mock SSE Response whose body streams text_delta events. */
function mockSSEResponse(text) {
  const sseData = `data: ${JSON.stringify({ type: 'text_delta', textDelta: text })}\n\ndata: [DONE]\n\n`;
  const encoded = new TextEncoder().encode(sseData);
  let consumed = false;
  return {
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (!consumed) {
            consumed = true;
            return Promise.resolve({ done: false, value: encoded });
          }
          return Promise.resolve({ done: true });
        }),
      }),
    },
  };
}

/** Build a mock SSE Response that returns empty stream (no text_delta). */
function mockEmptySSEResponse() {
  return {
    body: {
      getReader: () => ({
        read: jest.fn().mockResolvedValue({ done: true }),
      }),
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function mockReq(params = {}, body = {}, file = null, user = { userId: 'user-1' }) {
  return { params, body, file, user };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.write = jest.fn();
  res.end = jest.fn();
  res.headersSent = false;
  res.on = jest.fn();
  return res;
}

// ── Tests ───────────────────────────────────────────────────────

const controller = require('../src/controllers/brandVoiceController');
const Workspace = require('../src/models/Workspace');

describe('brandVoiceController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Workspace.findOne.mockResolvedValue(mockWorkspace);
  });

  // ── resolveWorkspace validation ──────────────────────────

  describe('workspace validation (NaN guard)', () => {
    test('returns 400 for undefined workspaceNumber', async () => {
      const req = mockReq({ workspaceNumber: undefined });
      const res = mockRes();
      await controller.listAvatars(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid workspace number' });
    });

    test('returns 400 for NaN workspaceNumber', async () => {
      const req = mockReq({ workspaceNumber: 'abc' });
      const res = mockRes();
      await controller.listAvatars(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid workspace number' });
    });

    test('returns 400 for empty string workspaceNumber', async () => {
      const req = mockReq({ workspaceNumber: '' });
      const res = mockRes();
      await controller.listAvatars(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 404 when workspace not found', async () => {
      Workspace.findOne.mockResolvedValue(null);
      const req = mockReq({ workspaceNumber: '999' });
      const res = mockRes();
      await controller.listAvatars(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Workspace not found' });
    });

    test('proceeds for valid numeric workspaceNumber', async () => {
      const req = mockReq({ workspaceNumber: '42' });
      const res = mockRes();
      await controller.listAvatars(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ avatars: expect.any(Array) }));
    });
  });

  // ── listAvatars ──────────────────────────────────────────

  describe('listAvatars', () => {
    test('returns avatars array', async () => {
      const req = mockReq({ workspaceNumber: '42' });
      const res = mockRes();
      await controller.listAvatars(req, res);
      expect(res.json).toHaveBeenCalledWith({ avatars: [mockAvatar] });
    });
  });

  // ── uploadAvatarImage ────────────────────────────────────

  describe('uploadAvatarImage', () => {
    test('returns 400 when no image file provided', async () => {
      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, {}, null);
      const res = mockRes();
      await controller.uploadAvatarImage(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Image file is required' });
    });

    test('uploads image and saves B2 key to avatar', async () => {
      const imageStorage = require('../src/services/imageStorage');
      const req = mockReq(
        { workspaceNumber: '42', avatarId: 'av-1' },
        {},
        { buffer: Buffer.from('fake-image'), mimetype: 'image/png' }
      );
      const res = mockRes();
      await controller.uploadAvatarImage(req, res);

      expect(imageStorage.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        'image/png',
        'ws-1',
        'avatar-av-1'
      );
      expect(mockSave).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ avatar: expect.any(Object) }));
    });

    test('deletes old image before uploading new one', async () => {
      const imageStorage = require('../src/services/imageStorage');
      const Avatar = require('../src/models/Avatar');
      // Avatar with existing image
      Avatar.findOne.mockResolvedValue({
        ...mockAvatar,
        avatarImage: 'old-image-key',
        save: mockSave,
        toObject: mockAvatar.toObject,
      });

      const req = mockReq(
        { workspaceNumber: '42', avatarId: 'av-1' },
        {},
        { buffer: Buffer.from('new-image'), mimetype: 'image/jpeg' }
      );
      const res = mockRes();
      await controller.uploadAvatarImage(req, res);

      expect(imageStorage.deleteObject).toHaveBeenCalledWith('old-image-key');
    });

    test('returns 404 when avatar not found', async () => {
      const Avatar = require('../src/models/Avatar');
      Avatar.findOne.mockResolvedValue(null);

      const req = mockReq(
        { workspaceNumber: '42', avatarId: 'nonexistent' },
        {},
        { buffer: Buffer.from('img'), mimetype: 'image/png' }
      );
      const res = mockRes();
      await controller.uploadAvatarImage(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // ── deleteAvatarImage ────────────────────────────────────

  describe('deleteAvatarImage', () => {
    test('deletes image and clears avatarImage field', async () => {
      const imageStorage = require('../src/services/imageStorage');
      const Avatar = require('../src/models/Avatar');
      Avatar.findOne.mockResolvedValue({
        ...mockAvatar,
        avatarImage: 'images/ws-1/avatar-av-1/photo.jpg',
        save: mockSave,
        toObject: mockAvatar.toObject,
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' });
      const res = mockRes();
      await controller.deleteAvatarImage(req, res);

      expect(imageStorage.deleteObject).toHaveBeenCalledWith('images/ws-1/avatar-av-1/photo.jpg');
      expect(mockSave).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled();
    });

    test('succeeds even when no image exists', async () => {
      const Avatar = require('../src/models/Avatar');
      Avatar.findOne.mockResolvedValue({
        ...mockAvatar,
        avatarImage: '',
        save: mockSave,
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' });
      const res = mockRes();
      await controller.deleteAvatarImage(req, res);

      // Should not attempt to delete empty key
      const imageStorage = require('../src/services/imageStorage');
      expect(imageStorage.deleteObject).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled();
    });
  });

  // ── deleteAvatar (cleanup) ───────────────────────────────

  describe('deleteAvatar — B2 cleanup', () => {
    test('cleans up avatar image on delete', async () => {
      const imageStorage = require('../src/services/imageStorage');
      const Avatar = require('../src/models/Avatar');
      Avatar.findOneAndDelete.mockResolvedValue({
        ...mockAvatar,
        avatarImage: 'images/ws-1/avatar-av-1/photo.jpg',
        uploads: [{ b2Key: 'brand-voice/ws-1/av-1/file.pdf' }],
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' });
      const res = mockRes();
      await controller.deleteAvatar(req, res);

      // Should delete avatar.md, avatar image, and upload files
      expect(imageStorage.deleteObject).toHaveBeenCalledWith('brand-voice/ws-1/avatars/av-1/avatar.md');
      expect(imageStorage.deleteObject).toHaveBeenCalledWith('images/ws-1/avatar-av-1/photo.jpg');
      expect(imageStorage.deleteObject).toHaveBeenCalledWith('brand-voice/ws-1/av-1/file.pdf');
    });
  });

  // ── updateAvatar + preview generation (non-blocking) ────

  describe('updateAvatar — preview generation', () => {
    let avatarDoc;

    beforeEach(() => {
      const Avatar = require('../src/models/Avatar');
      const BrandVoice = require('../src/models/BrandVoice');
      const writingEngine = require('../src/services/writingEngine');

      // Fresh mutable avatar document per test
      avatarDoc = {
        ...mockAvatar,
        generatedSample: '',
        generatedComparison: '',
        previewsStale: false,
        previewsGenerating: false,
        previewRegenCount: 0,
        previewRegenWindowStart: null,
        save: mockSave,
        toObject() { return { ...this }; },
      };

      Avatar.findOne.mockResolvedValue(avatarDoc);
      BrandVoice.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

      // Default: successful SSE streams with DISTINCT text per call
      let sessionCounter = 0;
      writingEngine.createSession.mockImplementation(() => Promise.resolve(`session-${++sessionCounter}`));
      writingEngine.pushDocument.mockResolvedValue(undefined);
      // Sequential: first call → comparison text, second → sample text
      let streamCall = 0;
      writingEngine.sendChatMessageStream.mockImplementation(() => {
        streamCall++;
        const text = streamCall % 2 === 1
          ? 'Rewritten comparison paragraph.'
          : 'Opening sample paragraph.';
        return Promise.resolve(mockSSEResponse(text));
      });
    });

    // ── Immediate response: non-blocking ──

    test('responds immediately with previewStatus "generating"', async () => {
      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      const responseData = res.json.mock.calls[0][0];
      expect(responseData.previewStatus).toBe('generating');
    });

    // ── Background generation: data verification ──

    test('both generatedComparison and generatedSample saved to DB after background generation', async () => {
      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Updated Writer' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      // After full await, avatarDoc has been mutated by background generation
      expect(avatarDoc.generatedComparison).toBe('Rewritten comparison paragraph.');
      expect(avatarDoc.generatedSample).toBe('Opening sample paragraph.');
      expect(avatarDoc.previewRegenCount).toBe(1);
      expect(avatarDoc.previewsStale).toBe(false);
      expect(avatarDoc.previewsGenerating).toBe(false);
    });

    test('save() called twice: first for fields, second after background generation', async () => {
      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Updated Writer' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      expect(mockSave).toHaveBeenCalledTimes(2);
      // After second save, avatar doc should have the texts
      expect(avatarDoc.generatedComparison).toBeTruthy();
      expect(avatarDoc.generatedSample).toBeTruthy();
    });

    // ── Both-must-succeed logic ──

    test('does NOT update texts or count when only comparison succeeds (sample empty)', async () => {
      const writingEngine = require('../src/services/writingEngine');
      let call = 0;
      writingEngine.sendChatMessageStream.mockImplementation(() => {
        call++;
        // Call 1 = comparison (succeed), all others = sample (always empty, including retry)
        return call === 1
          ? Promise.resolve(mockSSEResponse('Comp text'))
          : Promise.resolve(mockEmptySSEResponse());
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      // Background generation failed → check avatarDoc state
      expect(avatarDoc.generatedComparison).toBe('');
      expect(avatarDoc.generatedSample).toBe('');
      expect(avatarDoc.previewRegenCount).toBe(0);
      expect(avatarDoc.previewsStale).toBe(true);
      expect(avatarDoc.previewsGenerating).toBe(false);
    });

    test('does NOT update texts or count when only sample succeeds (comparison empty)', async () => {
      const writingEngine = require('../src/services/writingEngine');
      let call = 0;
      writingEngine.sendChatMessageStream.mockImplementation(() => {
        call++;
        return call % 2 === 1
          ? Promise.resolve(mockEmptySSEResponse())
          : Promise.resolve(mockSSEResponse('Sample text'));
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      expect(avatarDoc.generatedComparison).toBe('');
      expect(avatarDoc.generatedSample).toBe('');
      expect(avatarDoc.previewRegenCount).toBe(0);
      expect(avatarDoc.previewsStale).toBe(true);
      expect(avatarDoc.previewsGenerating).toBe(false);
    });

    // ── Retry logic ──

    test('retries failed sample and succeeds → both texts saved', async () => {
      const writingEngine = require('../src/services/writingEngine');
      let call = 0;
      writingEngine.sendChatMessageStream.mockImplementation(() => {
        call++;
        if (call === 1) return Promise.resolve(mockSSEResponse('Comp result'));    // comparison OK
        if (call === 2) return Promise.resolve(mockEmptySSEResponse());             // sample FAIL
        if (call === 3) return Promise.resolve(mockSSEResponse('Sample result'));   // sample RETRY OK
        return Promise.resolve(mockEmptySSEResponse());
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      expect(avatarDoc.generatedComparison).toBe('Comp result');
      expect(avatarDoc.generatedSample).toBe('Sample result');
      expect(avatarDoc.previewRegenCount).toBe(1);
      expect(avatarDoc.previewsGenerating).toBe(false);
    });

    test('retries failed comparison and succeeds → both texts saved', async () => {
      const writingEngine = require('../src/services/writingEngine');
      let call = 0;
      writingEngine.sendChatMessageStream.mockImplementation(() => {
        call++;
        if (call === 1) return Promise.resolve(mockEmptySSEResponse());             // comparison FAIL
        if (call === 2) return Promise.resolve(mockSSEResponse('Sample result'));   // sample OK
        if (call === 3) return Promise.resolve(mockSSEResponse('Comp result'));     // comparison RETRY OK
        return Promise.resolve(mockEmptySSEResponse());
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      expect(avatarDoc.generatedComparison).toBe('Comp result');
      expect(avatarDoc.generatedSample).toBe('Sample result');
      expect(avatarDoc.previewRegenCount).toBe(1);
      expect(avatarDoc.previewsGenerating).toBe(false);
    });

    // ── Field persistence under failure ──

    test('field changes persist even when Writing Engine is down', async () => {
      const writingEngine = require('../src/services/writingEngine');
      writingEngine.createSession.mockRejectedValue(new Error('Connection refused'));

      const req = mockReq(
        { workspaceNumber: '42', avatarId: 'av-1' },
        { name: 'Updated Name', role: 'New Role' }
      );
      const res = mockRes();
      await controller.updateAvatar(req, res);

      // Response is sent before generation — field changes visible
      expect(res.json).toHaveBeenCalled();
      const responseData = res.json.mock.calls[0][0];
      expect(responseData.avatar.name).toBe('Updated Name');
      expect(responseData.avatar.role).toBe('New Role');
      expect(responseData.previewStatus).toBe('generating');

      // After background generation fails, avatarDoc reflects failure
      expect(avatarDoc.previewsStale).toBe(true);
      expect(avatarDoc.previewsGenerating).toBe(false);
      expect(avatarDoc.generatedComparison).toBe('');
      expect(avatarDoc.generatedSample).toBe('');
    });

    test('keeps old texts when both generations fail (no partial overwrite)', async () => {
      avatarDoc.generatedComparison = 'Old comp text';
      avatarDoc.generatedSample = 'Old sample text';

      const writingEngine = require('../src/services/writingEngine');
      writingEngine.sendChatMessageStream.mockImplementation(() =>
        Promise.resolve(mockEmptySSEResponse())
      );

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      // Old texts must be preserved
      expect(avatarDoc.generatedComparison).toBe('Old comp text');
      expect(avatarDoc.generatedSample).toBe('Old sample text');
      expect(avatarDoc.previewsStale).toBe(true);
      expect(avatarDoc.previewRegenCount).toBe(0);
      expect(avatarDoc.previewsGenerating).toBe(false);
    });

    // ── Rate limiting (10 per hour) ──

    test('rate limits after 10 generations in a 1-hour window', async () => {
      avatarDoc.previewRegenCount = 10;
      avatarDoc.previewRegenWindowStart = new Date(); // current window

      const writingEngine = require('../src/services/writingEngine');
      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      // No generation attempt
      expect(writingEngine.createSession).not.toHaveBeenCalled();
      const responseData = res.json.mock.calls[0][0];
      expect(responseData.previewStatus).toBe('rate_limited');
      // Texts not touched
      expect(avatarDoc.generatedComparison).toBe('');
      expect(avatarDoc.generatedSample).toBe('');
    });

    test('resets rate limit after 1-hour window expires', async () => {
      avatarDoc.previewRegenCount = 10;
      avatarDoc.previewRegenWindowStart = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      const writingEngine = require('../src/services/writingEngine');
      expect(writingEngine.createSession).toHaveBeenCalled();
      expect(avatarDoc.generatedComparison).toBeTruthy();
      expect(avatarDoc.generatedSample).toBeTruthy();
      expect(avatarDoc.previewRegenCount).toBe(1);
      expect(avatarDoc.previewsStale).toBe(false);
      expect(avatarDoc.previewsGenerating).toBe(false);
    });

    // ── Integration: abort signal propagation ──

    test('passes abort signal through entire chain', async () => {
      const writingEngine = require('../src/services/writingEngine');

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      for (const call of writingEngine.createSession.mock.calls) {
        expect(call[0]).toBeInstanceOf(AbortSignal);
      }
      for (const call of writingEngine.pushDocument.mock.calls) {
        expect(call[2]).toBeInstanceOf(AbortSignal);
      }
      for (const call of writingEngine.sendChatMessageStream.mock.calls) {
        expect(call[2]).toBeInstanceOf(AbortSignal);
      }
    });

    // ── Brand voice content combination ──

    test('combines brand voice + avatar markdown in generated previews', async () => {
      const BrandVoice = require('../src/models/BrandVoice');
      const writingEngine = require('../src/services/writingEngine');
      BrandVoice.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ content: '# Brand Voice Guide\nBe casual.' }),
      });

      const req = mockReq({ workspaceNumber: '42', avatarId: 'av-1' }, { name: 'Test' });
      const res = mockRes();
      await controller.updateAvatar(req, res);

      // pushDocument should receive combined content
      const pushedContent = writingEngine.pushDocument.mock.calls[0][1];
      expect(pushedContent).toContain('# Brand Voice Guide');
      expect(pushedContent).toContain('---');

      // Texts should still be generated in background
      expect(avatarDoc.generatedComparison).toBeTruthy();
      expect(avatarDoc.generatedSample).toBeTruthy();
    });
  });
});
