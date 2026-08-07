/**
 * Unit tests for the pure helpers of scripts/preflightDb.js (version
 * comparison and the tools/server compatibility matrix). The live checks —
 * topology, transaction probe, sentinel counts — are exercised by running
 * the script against a real target.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compareVersions, parseToolsVersion, minToolsForServer } = require('../scripts/preflightDb');

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    assert.equal(compareVersions('100.10.0', '100.9.4'), 1);
    assert.equal(compareVersions('100.9.4', '100.10.0'), -1);
    assert.equal(compareVersions('7.0.12', '7.0.12'), 0);
  });

  it('treats missing segments as zero', () => {
    assert.equal(compareVersions('100.10', '100.10.0'), 0);
  });
});

describe('parseToolsVersion', () => {
  it('extracts the version from mongodump --version output', () => {
    assert.equal(parseToolsVersion('mongodump version: 100.9.4\ngit version: abc\n'), '100.9.4');
  });

  it('returns null on unrecognized output', () => {
    assert.equal(parseToolsVersion('command not found'), null);
  });
});

describe('minToolsForServer', () => {
  it('maps supported server majors to their minimum tools version', () => {
    assert.equal(minToolsForServer('6.0.15'), '100.6.0');
    assert.equal(minToolsForServer('7.0.12'), '100.7.3');
    assert.equal(minToolsForServer('8.0.4'), '100.10.0');
  });

  it('accepts any 100.x tools for pre-6.0 servers', () => {
    assert.equal(minToolsForServer('5.0.28'), '100.0.0');
  });

  it('returns null for unknown majors so callers warn instead of assume', () => {
    assert.equal(minToolsForServer('9.0.0'), null);
    assert.equal(minToolsForServer('garbage'), null);
  });
});
