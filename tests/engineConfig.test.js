/**
 * Phase C1 — boot-time engine-URL validation. Pins the fail-fast contract:
 * unset ENGINE_URL / WRITING_ENGINE_URL is fatal in production (would point
 * live traffic at localhost) but only a dev warning; identical hosts warn
 * (cross-wiring watch-item) without blocking a co-located deploy.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateEngineConfig, assertEngineConfigAtBoot } = require('../src/config/validateEngineConfig');

describe('validateEngineConfig', () => {
  it('ok in dev with nothing set — only warns (localhost fallback)', () => {
    const r = validateEngineConfig({ NODE_ENV: 'development' });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 3); // both URLs + ENGINE_INTERNAL_KEY unset → three warnings
  });

  it('fatal in production when ENGINE_URL is unset', () => {
    const r = validateEngineConfig({ NODE_ENV: 'production', WRITING_ENGINE_URL: 'http://writing:9090' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('ENGINE_URL')));
  });

  it('fatal in production when WRITING_ENGINE_URL is unset', () => {
    const r = validateEngineConfig({ NODE_ENV: 'production', ENGINE_URL: 'http://analysis:8080' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('WRITING_ENGINE_URL')));
  });

  it('fatal in production when ENGINE_INTERNAL_KEY is unset (14a)', () => {
    const r = validateEngineConfig({
      NODE_ENV: 'production',
      ENGINE_URL: 'http://analysis:8080',
      WRITING_ENGINE_URL: 'http://writing:9090',
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('ENGINE_INTERNAL_KEY')));
  });

  it('only warns in dev when ENGINE_INTERNAL_KEY is unset (14a)', () => {
    const r = validateEngineConfig({
      NODE_ENV: 'development',
      ENGINE_URL: 'http://analysis:8080',
      WRITING_ENGINE_URL: 'http://writing:9090',
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.ok(r.warnings.some((w) => w.includes('ENGINE_INTERNAL_KEY')));
  });

  it('ok in production when both are set and distinct', () => {
    const r = validateEngineConfig({
      NODE_ENV: 'production',
      ENGINE_URL: 'http://analysis:8080',
      WRITING_ENGINE_URL: 'http://writing:9090',
      ENGINE_INTERNAL_KEY: 'secret',
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 0);
  });

  it('warns (not fatal) when both are set to the same host', () => {
    const r = validateEngineConfig({
      NODE_ENV: 'production',
      ENGINE_URL: 'http://shared:8090',
      WRITING_ENGINE_URL: 'http://shared:8090',
      ENGINE_INTERNAL_KEY: 'secret',
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('identical')));
  });

  it('treats a trailing-slash-only difference as identical', () => {
    const r = validateEngineConfig({
      NODE_ENV: 'production',
      ENGINE_URL: 'http://shared:8090/',
      WRITING_ENGINE_URL: 'http://shared:8090',
      ENGINE_INTERNAL_KEY: 'secret',
    });
    assert.ok(r.warnings.some((w) => w.includes('identical')));
  });
});

describe('assertEngineConfigAtBoot', () => {
  it('does NOT exit when config is ok', () => {
    let exited = false;
    assertEngineConfigAtBoot({
      env: { NODE_ENV: 'production', ENGINE_URL: 'http://a:8080', WRITING_ENGINE_URL: 'http://w:9090', ENGINE_INTERNAL_KEY: 'secret' },
      exit: () => { exited = true; },
      logger: { warn() {}, error() {}, log() {} },
    });
    assert.equal(exited, false);
  });

  it('exits(1) on a production misconfig', () => {
    let code = null;
    assertEngineConfigAtBoot({
      env: { NODE_ENV: 'production' }, // both unset
      exit: (c) => { code = c; },
      logger: { warn() {}, error() {}, log() {} },
    });
    assert.equal(code, 1);
  });
});
