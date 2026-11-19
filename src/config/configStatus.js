/**
 * Credential / configuration presence for GET /health (QA Nov 2026: N5, B34).
 *
 * BOOLEANS ONLY: /health is public, so it says whether a credential is
 * configured, never its value, length, prefix or host. The point is that a
 * misconfigured deploy (no OpenRouter key on the backend, no CFS key, the CFS
 * base URL silently falling back to localhost) is visible in one request
 * instead of only as degraded AI runs.
 */

const present = (name) => typeof process.env[name] === 'string' && process.env[name].trim() !== '';

function configStatus() {
  const cfsBaseUrlConfigured = present('EXPRESS_INTERNAL_BASE_URL') || present('PUBLIC_BASE_URL');
  return {
    // The backend's own LLM key (Content Audit, Writing Quality, AI Tracker).
    openRouterKeyConfigured: present('OPENROUTER_API_KEY'),
    // Context file system: the writing engine calls back into /api/internal/cfs
    // with this key at this base URL. Without both, plan mode cannot run and
    // chat/agent lose their context tools.
    internalApiKeyConfigured: present('INTERNAL_API_KEY'),
    cfsBaseUrlConfigured,
    // true = the engine will be told to call http://localhost:4001, which is
    // only right in local development. The writing engine's API_URL must equal
    // this base URL byte for byte or every CFS call 403s.
    cfsBaseUrlIsDefault: !cfsBaseUrlConfigured,
    engineInternalKeyConfigured: present('ENGINE_INTERNAL_KEY'),
    writingEngineUrlConfigured: present('WRITING_ENGINE_URL'),
    analysisEngineUrlConfigured: present('ENGINE_URL'),
    stripeConfigured: present('STRIPE_SECRET_KEY'),
    imageStorageConfigured: present('B2_BUCKET') && present('B2_KEY_ID') && present('B2_APP_KEY'),
    emailConfigured: present('BREVO_API_KEY'),
    chatgptSearchKeyConfigured: present('CHATGPT_API_KEY'),
    serperKeyConfigured: present('SERPER_API_KEY'),
  };
}

module.exports = { configStatus };
