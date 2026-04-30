/**
 * Tests for writingEngine.js — specifically the allowedTools payload logic.
 * Mocks global fetch to verify request payloads without a real engine server.
 */

// Mock env before requiring
process.env.WRITING_ENGINE_URL = 'http://localhost:4000';

// Capture fetch calls
let fetchCalls = [];
global.fetch = jest.fn(async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: true,
    status: 200,
    text: async () => '{}',
    json: async () => ({}),
    body: null,
  };
});

const writingEngine = require('../src/services/writingEngine');

beforeEach(() => {
  fetchCalls = [];
  global.fetch.mockClear();
});

describe('writingEngine.startAgent — allowedTools payload', () => {
  test('includes allowedTools in payload when provided', async () => {
    await writingEngine.startAgent('sess-1', 'fix grammar', 75, 5, undefined, ['EditTool']);
    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.allowedTools).toEqual(['EditTool']);
  });

  test('includes multiple allowedTools', async () => {
    await writingEngine.startAgent('sess-1', 'research', 75, 8, undefined, ['WebSearchTool', 'WebFetchTool', 'EditTool']);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.allowedTools).toEqual(['WebSearchTool', 'WebFetchTool', 'EditTool']);
  });

  test('omits allowedTools when undefined', async () => {
    await writingEngine.startAgent('sess-1', 'do stuff', 75, 5, undefined, undefined);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.allowedTools).toBeUndefined();
    expect(Object.keys(body)).toEqual(['goal', 'targetScore', 'maxIterations']);
  });

  test('omits allowedTools when empty array', async () => {
    await writingEngine.startAgent('sess-1', 'do stuff', 75, 5, undefined, []);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.allowedTools).toBeUndefined();
  });

  test('sends correct URL with session ID', async () => {
    await writingEngine.startAgent('abc-123', 'goal', 80, 10, undefined, ['EditTool']);
    expect(fetchCalls[0].url).toBe('http://localhost:4000/api/session/abc-123/agent');
  });

  test('sends goal, targetScore, maxIterations in payload', async () => {
    await writingEngine.startAgent('sess-1', 'optimize content', 80, 10, undefined);
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.goal).toBe('optimize content');
    expect(body.targetScore).toBe(80);
    expect(body.maxIterations).toBe(10);
  });
});
