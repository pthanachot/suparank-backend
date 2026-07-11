/**
 * Boot-time engine-URL validation.
 *
 * The app talks to TWO separate Go services:
 *   - the analysis engine (ENGINE_URL, /api/analyze|score|discover|bot-access)
 *   - the writing engine  (WRITING_ENGINE_URL, /api/session/*)
 * Both resolvers fall back to http://localhost:8090 when unset — correct for
 * local dev, but in production a missing var would silently point live traffic
 * at localhost (connection refused, or worse, some unrelated local process).
 * The audit also flagged a cross-wiring foot-gun when the two share a host.
 *
 * This turns both into a boot-time signal: unset-in-production is fatal;
 * identical-hosts is a warning (a single-box deploy could legitimately
 * co-locate them, so we flag rather than block).
 *
 * Pure over an env object so it is unit-testable (tests/engineConfig.test.js).
 */

const DEV_FALLBACK = 'http://localhost:8090';

/**
 * @param {Object} [env=process.env]
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateEngineConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const isProd = env.NODE_ENV === 'production';

  for (const name of ['ENGINE_URL', 'WRITING_ENGINE_URL']) {
    if (!env[name]) {
      if (isProd) {
        errors.push(
          `${name} is unset — engine calls will fall back to ${DEV_FALLBACK}, `
          + 'which is never correct in production.'
        );
      } else {
        warnings.push(`${name} unset — defaulting to ${DEV_FALLBACK} (fine for local dev).`);
      }
    }
  }

  // 14a: the writing-engine fail-closes when it has an internal key configured —
  // a request with no (or a wrong) X-Internal-Key gets 503/401. The backend
  // sends X-Internal-Key ONLY when ENGINE_INTERNAL_KEY is set, so an unset key
  // in production means the process boots clean and then 401s on every engine
  // call at runtime. Turn that into a boot-time signal (fatal in prod, warn in
  // dev where the engine typically runs keyless).
  if (!env.ENGINE_INTERNAL_KEY) {
    if (isProd) {
      errors.push(
        'ENGINE_INTERNAL_KEY is unset — the writing-engine fail-closes (503/401) '
        + 'without a matching X-Internal-Key, so every engine call will fail at runtime.'
      );
    } else {
      warnings.push('ENGINE_INTERNAL_KEY unset — fine for local dev if the engine runs keyless; required in production.');
    }
  }

  // The two engines are separate apps. Identical hosts risk cross-wiring (the
  // audit's watch-item), but a co-located single-box deploy is technically
  // possible, so warn rather than fail. Trailing-slash tolerant.
  const norm = (u) => (u ? u.replace(/\/+$/, '') : u);
  if (env.ENGINE_URL && env.WRITING_ENGINE_URL && norm(env.ENGINE_URL) === norm(env.WRITING_ENGINE_URL)) {
    warnings.push(
      `ENGINE_URL and WRITING_ENGINE_URL are identical (${env.ENGINE_URL}) — the analysis and `
      + 'writing engines are separate apps; confirm this host actually serves both.'
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Boot wrapper: log the result and, on error (only ever raised in production),
 * exit(1) so the process manager reports a clear failure instead of the server
 * booting with engine traffic pointed at localhost. Never throws in dev.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.env=process.env]
 * @param {Function} [opts.exit=process.exit]
 * @param {Object} [opts.logger=console]
 */
function assertEngineConfigAtBoot({ env = process.env, exit = process.exit, logger = console } = {}) {
  const { ok, errors, warnings } = validateEngineConfig(env);

  for (const w of warnings) logger.warn(`[engine-config] ⚠ ${w}`);
  for (const e of errors) logger.error(`[engine-config] ✗ ${e}`);

  if (ok) return { ok };

  logger.error('');
  logger.error('================================================');
  logger.error('FATAL: engine URLs are mis-configured for production.');
  logger.error('Set ENGINE_URL and WRITING_ENGINE_URL and restart.');
  logger.error('================================================');
  exit(1);
  return { ok };
}

module.exports = { validateEngineConfig, assertEngineConfigAtBoot };
