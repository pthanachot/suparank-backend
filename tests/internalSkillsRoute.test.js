/**
 * HTTP-level tests for the M5 skills bridge.
 *
 * /api/internal/skills proxies writing-engine /api/skills. Tests:
 *  - internalAuth-gated (no key → 503 fail-closed; wrong key → 401)
 *  - 502 surfaces writing-engine unreachable
 *  - happy path returns { skills: [...] }
 *
 * The proxy uses global fetch; we mock it via a per-test stub so we
 * don't need to stand up the writing-engine.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

// Set the internal key BEFORE the routes module is required so the
// internalAuth middleware closes over it correctly.
process.env.INTERNAL_API_KEY = 'test-key-12345';

const skillsRoutes = require('../src/routes/internalSkillsRoutes');

// Mock writingEngine.listSkills by swapping the function on the
// already-required module. require() caches, so this affects the
// route's closure too.
const writingEngine = require('../src/services/writingEngine');
let mockListSkills = null;
const originalListSkills = writingEngine.listSkills;
writingEngine.listSkills = (...args) => {
  if (mockListSkills) return mockListSkills(...args);
  return originalListSkills(...args);
};

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/skills', skillsRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function get(server, path, headers = {}) {
  const addr = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: addr.address, port: addr.port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/internal/skills', () => {
  let server;
  beforeEach(async () => {
    mockListSkills = null;
    server = await startServer();
  });
  afterEach(() => {
    server && server.close();
  });

  it('401 without x-internal-key header', async () => {
    const r = await get(server, '/api/internal/skills/');
    assert.equal(r.status, 401);
  });

  it('401 with wrong key', async () => {
    const r = await get(server, '/api/internal/skills/', { 'x-internal-key': 'wrong-key' });
    assert.equal(r.status, 401);
  });

  it('200 with valid key — happy path', async () => {
    mockListSkills = async () => [
      { name: 'grammar', description: 'Grammar check' },
      { name: 'tone', description: 'Tone adjustment' },
    ];
    const r = await get(server, '/api/internal/skills/', { 'x-internal-key': 'test-key-12345' });
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    assert.equal(Array.isArray(data.skills), true);
    assert.equal(data.skills.length, 2);
    assert.equal(data.skills[0].name, 'grammar');
  });

  it('502 when writing-engine is unreachable', async () => {
    mockListSkills = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8090');
    };
    const r = await get(server, '/api/internal/skills/', { 'x-internal-key': 'test-key-12345' });
    assert.equal(r.status, 502);
    const data = JSON.parse(r.body);
    assert.match(data.error, /writing-engine unreachable/);
  });

  it('coerces non-array writing-engine response to []', async () => {
    mockListSkills = async () => null; // Go returned null somehow
    const r = await get(server, '/api/internal/skills/', { 'x-internal-key': 'test-key-12345' });
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    assert.deepEqual(data.skills, []);
  });
});
