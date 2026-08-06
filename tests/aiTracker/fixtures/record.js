/**
 * One-shot recorder for REAL vendor fixtures (Phase 1 deliverable; run
 * manually, never in CI). Requires explicit opt-in AND live keys:
 *
 *   RECORD_FIXTURES=1 CHATGPT_API_KEY=... OPENROUTER_API_KEY=... \
 *     node tests/aiTracker/fixtures/record.js
 *
 * Writes <vendor>-recorded.json next to this file for whichever keys are
 * set. Recorded fixtures should replace the hand-crafted *-clean.json
 * files once captured (review + scrub anything sensitive first).
 */

const fs = require('fs');
const path = require('path');

if (process.env.RECORD_FIXTURES !== '1') {
  console.error('Refusing to run: set RECORD_FIXTURES=1 to make real billed vendor calls.');
  process.exit(1);
}

const QUERY = 'best seo tools 2026';

async function recordChatGPT() {
  const apiKey = process.env.CHATGPT_API_KEY;
  if (!apiKey) return console.log('[record] CHATGPT_API_KEY not set — skipping chatgpt');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      instructions: 'Search the web and cite sources inline as [domain](url).',
      input: QUERY,
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      store: false,
    }),
  });
  const data = await res.json();
  fs.writeFileSync(path.join(__dirname, 'chatgpt-responses-recorded.json'), JSON.stringify(data, null, 2));
  console.log(`[record] chatgpt → chatgpt-responses-recorded.json (status ${res.status})`);
}

async function recordKimi() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return console.log('[record] OPENROUTER_API_KEY not set — skipping kimi');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'moonshotai/kimi-k2-0905',
      max_tokens: 1024,
      temperature: 0,
      messages: [{
        role: 'user',
        content: 'Return ONLY valid JSON: {"brands":["A"],"citationUrls":["https://example.com"],"sentiment":null}',
      }],
    }),
  });
  const data = await res.json();
  fs.writeFileSync(path.join(__dirname, 'kimi-analyzer-recorded.json'), JSON.stringify(data, null, 2));
  console.log(`[record] kimi → kimi-analyzer-recorded.json (status ${res.status})`);
}

(async () => {
  await recordChatGPT().catch((e) => console.error('[record] chatgpt failed:', e.message));
  await recordKimi().catch((e) => console.error('[record] kimi failed:', e.message));
})();
