/**
 * Unit tests for the EXPECTED_DB_HOST guardrail (src/config/database.js):
 * hostMismatch is pure; checkConnectionHealth is exercised disconnected.
 * Requiring database.js has no side effects — models load inside connectDB.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { hostMismatch, checkConnectionHealth } = require('../src/config/database');

const ORIGINAL = process.env.EXPECTED_DB_HOST;
after(() => {
  if (ORIGINAL === undefined) delete process.env.EXPECTED_DB_HOST;
  else process.env.EXPECTED_DB_HOST = ORIGINAL;
});

describe('hostMismatch', () => {
  it('is disabled (no mismatch) when EXPECTED_DB_HOST is unset', () => {
    assert.equal(hostMismatch('ac-x-shard-00-02.abc123.mongodb.net', undefined), false);
    assert.equal(hostMismatch('anything', ''), false);
  });

  it('accepts a shard host containing the expected cluster suffix', () => {
    assert.equal(hostMismatch('ac-x-shard-00-02.abc123.mongodb.net', 'abc123.mongodb.net'), false);
  });

  it('flags a host from a different cluster', () => {
    assert.equal(hostMismatch('ac-y-shard-00-01.other99.mongodb.net', 'abc123.mongodb.net'), true);
  });

  it('flags an absent host when a match is expected', () => {
    assert.equal(hostMismatch(undefined, 'abc123.mongodb.net'), true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    assert.equal(hostMismatch('ac-x-shard-00-02.abc123.mongodb.net', 'ABC123.MongoDB.NET'), false);
    assert.equal(hostMismatch('ac-x-shard-00-02.abc123.mongodb.net', '  abc123.mongodb.net '), false);
  });

  it('treats a whitespace-only expectation as disabled', () => {
    assert.equal(hostMismatch('anything', '   '), false);
  });

  it('distinguishes same-project clusters via the ac-<token> prefix', () => {
    assert.equal(hostMismatch('ac-newtok-shard-00-01.abc123.mongodb.net', 'ac-newtok'), false);
    assert.equal(hostMismatch('ac-oldtok-shard-00-01.abc123.mongodb.net', 'ac-newtok'), true);
  });
});

describe('checkConnectionHealth (disconnected)', () => {
  it('reports expectedHostMatch true when the check is disabled', () => {
    delete process.env.EXPECTED_DB_HOST;
    const health = checkConnectionHealth();
    assert.equal(health.isConnected, false);
    assert.equal(health.expectedHostMatch, true);
  });

  it('reports expectedHostMatch false when expecting a host while disconnected', () => {
    process.env.EXPECTED_DB_HOST = 'abc123.mongodb.net';
    const health = checkConnectionHealth();
    assert.equal(health.expectedHostMatch, false);
  });
});
