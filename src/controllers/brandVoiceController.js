const mongoose = require('mongoose');
const BrandVoice = require('../models/BrandVoice');
const Avatar = require('../models/Avatar');
const BrandVoiceTestLog = require('../models/BrandVoiceTestLog');
const Workspace = require('../models/Workspace');
const { generateBrandVoiceMarkdown, generateAvatarMarkdown } = require('../services/brandVoiceMarkdown');
const { parseFile } = require('../services/fileParser');
const { uploadBuffer, uploadImage, deleteObject, deleteAllWithPrefix } = require('../services/imageStorage');
const writingEngine = require('../services/writingEngine');
const crypto = require('crypto');
const tierService = require('../services/tierService');
const creditService = require('../services/creditService');

// Workspace resolved by permissions middleware (req.workspace).

/* ── Rate limit helpers ───────────────────────────────────────────────── */

const TEST_RATE_LIMIT = 10;
const TEST_RATE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

async function checkTestRateLimit(userId) {
  const windowStart = new Date(Date.now() - TEST_RATE_WINDOW_MS);
  const count = await BrandVoiceTestLog.countDocuments({
    userId,
    createdAt: { $gte: windowStart },
  });
  return { allowed: count < TEST_RATE_LIMIT, remaining: Math.max(0, TEST_RATE_LIMIT - count) };
}

async function recordTestUsage(userId) {
  await BrandVoiceTestLog.create({ userId });
}

/* ── Input validation helpers ────────────────────────────────────────── */

const MAX_TEST_WORDS = 150;

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const SLIDER_KEYS = ['formality', 'warmth', 'humor', 'technicality'];
const PERSPECTIVE_VALUES = ['you', 'we', 'they'];
const SENTENCE_STYLE_VALUES = ['short', 'mixed', 'detailed'];

// Returns null when settings are valid, or an error string when not.
function validateBrandVoiceSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'settings must be an object';
  }
  for (const key of SLIDER_KEYS) {
    if (settings[key] === undefined) continue;
    const v = settings[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
      return `${key} must be a number between 0 and 100`;
    }
  }
  if (settings.perspective !== undefined && !PERSPECTIVE_VALUES.includes(settings.perspective)) {
    return `perspective must be one of: ${PERSPECTIVE_VALUES.join(', ')}`;
  }
  if (settings.sentenceStyle !== undefined && !SENTENCE_STYLE_VALUES.includes(settings.sentenceStyle)) {
    return `sentenceStyle must be one of: ${SENTENCE_STYLE_VALUES.join(', ')}`;
  }
  for (const arrKey of ['formattingHabits', 'useWords', 'avoidWords']) {
    if (settings[arrKey] === undefined) continue;
    if (!Array.isArray(settings[arrKey]) || !settings[arrKey].every((s) => typeof s === 'string')) {
      return `${arrKey} must be an array of strings`;
    }
  }
  return null;
}

// Validate that `id` is a well-formed ObjectId. Sends 400 and returns false if not.
function ensureValidObjectId(res, id, label) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: `Invalid ${label}` });
    return false;
  }
  return true;
}

// If err is a Mongoose ValidationError/CastError, sends 400 and returns true.
function handleMongooseError(res, err) {
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: `Invalid ${err.path || 'id'} format` });
    return true;
  }
  return false;
}

// Validates the parts of the avatar input that generateAvatarMarkdown calls
// array methods on (traits, vocabulary.*). Returns null if valid, else error string.
const AVATAR_STRING_FIELDS = ['name', 'emoji', 'role', 'experience', 'tagline',
  'writingQuirks', 'openingStyle', 'sample', 'background'];

function validateAvatarInput(body) {
  if (body.traits !== undefined) {
    if (!Array.isArray(body.traits) || !body.traits.every((s) => typeof s === 'string')) {
      return 'traits must be an array of strings';
    }
  }
  if (body.vocabulary !== undefined) {
    const v = body.vocabulary;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return 'vocabulary must be an object';
    }
    for (const k of ['uses', 'avoids']) {
      if (v[k] !== undefined && (!Array.isArray(v[k]) || !v[k].every((s) => typeof s === 'string'))) {
        return `vocabulary.${k} must be an array of strings`;
      }
    }
  }
  if (body.toneOverrides !== undefined) {
    const t = body.toneOverrides;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      return 'toneOverrides must be an object';
    }
    for (const k of ['formality', 'warmth', 'humor']) {
      const n = t[k];
      if (n !== undefined && n !== null) {
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) {
          return `toneOverrides.${k} must be a number 0–100 or null`;
        }
      }
    }
  }
  for (const k of AVATAR_STRING_FIELDS) {
    if (body[k] !== undefined && typeof body[k] !== 'string') {
      return `${k} must be a string`;
    }
  }
  return null;
}

/* ── SSE streaming helper — lightweight rewrite via Writing Engine ────── */

async function streamRewriteResponse(req, res, markdownContent, userInput) {
  const abortCtrl = new AbortController();
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    abortCtrl.abort();
  });

  const systemPrompt = `You are a text rewriter. Your ONLY job is to rewrite the user's text using the brand voice below. Output ONLY the rewritten text — no explanations, no preamble, no commentary, no quotes around it.

${markdownContent}

RULES:
- REWRITE the user's text in the brand voice above. Do NOT answer it, do NOT respond to it, do NOT explain it.
- If "Never Use" words are listed, do NOT use them — no exceptions.
- If "Always Use" words are listed, incorporate them naturally.
- Match the specified tone precisely.
- Keep your response under ${MAX_TEST_WORDS} words.
- Output ONLY the rewritten version. Nothing else.`;

  const apiRes = await fetch(`${writingEngine.WRITING_ENGINE_URL}/api/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.REWRITE_SECRET && { 'X-Rewrite-Secret': process.env.REWRITE_SECRET }),
    },
    body: JSON.stringify({
      systemPrompt,
      userMessage: userInput,
      maxTokens: 1000,
    }),
    signal: abortCtrl.signal,
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text().catch(() => '');
    throw new Error(`Writing Engine rewrite error (${apiRes.status}): ${errText}`);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Pipe SSE stream from Writing Engine directly to client
  const reader = apiRes.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (streamErr) {
    if (!clientDisconnected && !abortCtrl.signal.aborted) throw streamErr;
  }
  res.end();
}

/* ── Preview generation (comparison + sample) ────────────────────────── */

const PREVIEW_REGEN_LIMIT = 10;
const PREVIEW_REGEN_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const GENERIC_TEXT = 'Project management tools help teams organize their work and improve productivity across the organization. These solutions enable better collaboration and workflow optimization for modern teams.';

function buildPreviewSystemPrompt(markdownContent) {
  return `You are a text rewriter. Your ONLY job is to write text using the brand voice below. Output ONLY the written text — no explanations, no preamble, no commentary, no quotes around it.

${markdownContent}

RULES:
- Write using the brand voice above. Do NOT explain or comment on the task.
- If "Never Use" words are listed, do NOT use them — no exceptions.
- If "Always Use" words are listed, incorporate them naturally.
- Match the specified tone precisely.
- Keep your response under 150 words.
- Output ONLY the text. Nothing else.`;
}

/** Read an SSE stream and collect the full text. */
async function collectStreamText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let streamError = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.type === 'text_delta' && typeof parsed.textDelta === 'string') {
          text += parsed.textDelta;
        } else if (parsed.type === 'error') {
          streamError = parsed.message || 'Unknown stream error';
          console.error('[brand-voice] SSE stream error:', streamError);
        }
      } catch { /* skip */ }
    }
  }
  if (!text && streamError) {
    throw new Error(`Writing Engine stream error: ${streamError}`);
  }
  return text.trim();
}

/**
 * Run a single generation via Writing Engine /api/rewrite (no session, no tools).
 * Returns the generated text or '' on failure.
 */
async function generateOnePreview(markdownContent, userMessage, signal) {
  const t0 = Date.now();
  const response = await fetch(`${writingEngine.WRITING_ENGINE_URL}/api/rewrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.REWRITE_SECRET && { 'X-Rewrite-Secret': process.env.REWRITE_SECRET }),
    },
    body: JSON.stringify({
      systemPrompt: buildPreviewSystemPrompt(markdownContent),
      userMessage,
      maxTokens: 1000,
    }),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Rewrite API error (${response.status}): ${errText}`);
  }
  console.log(`[brand-voice]   rewrite API responded: ${Date.now() - t0}ms`);
  const text = await collectStreamText(response);
  console.log(`[brand-voice]   collected: ${Date.now() - t0}ms (${text.length} chars)`);
  return text;
}

/**
 * Generate comparison + sample preview texts for an avatar.
 * Mutates the avatar document in-place. Call avatar.save() after.
 *
 * Shared rate limit: 10 per hour. Only counts when BOTH succeed.
 * If one section fails, retries it once before giving up.
 * On total failure, keeps old texts and marks previewsStale = true.
 *
 * @returns {'success'|'failed'|'rate_limited'} generation status
 */
async function generateAvatarPreviews(avatar, brandVoice) {
  // ── Rate limit check ──
  const now = new Date();
  const windowStart = avatar.previewRegenWindowStart;
  const windowExpired = !windowStart || (now - windowStart) >= PREVIEW_REGEN_WINDOW_MS;

  if (windowExpired) {
    avatar.previewRegenCount = 0;
    avatar.previewRegenWindowStart = now;
  }

  if (avatar.previewRegenCount >= PREVIEW_REGEN_LIMIT) {
    avatar.previewsStale = true;
    console.log(`[brand-voice] Preview regen rate-limited for avatar ${avatar._id} (${avatar.previewRegenCount}/${PREVIEW_REGEN_LIMIT})`);
    return 'rate_limited';
  }

  // ── Build context ──
  const markdownContent = brandVoice?.content
    ? brandVoice.content + '\n\n---\n\n' + avatar.content
    : avatar.content;

  console.log(`[brand-voice] Generating previews for avatar ${avatar._id} (context: ${markdownContent.length} chars)`);

  const compMessage = `Rewrite the following generic text in your voice and style. Keep the same core message.\n\n"${GENERIC_TEXT}"`;
  const sampMessage = 'Write a short opening paragraph (2-3 sentences) for an article about why most teams fail at project management. Use your voice, style, and opening approach.';

  const abortCtrl = new AbortController();
  const startTime = Date.now();
  const timeout = setTimeout(() => {
    console.error(`[brand-voice] Preview generation timed out after 180s`);
    abortCtrl.abort();
  }, 180_000);

  try {
    // ── Run sequentially to avoid competing for Writing Engine resources ──
    let compText = '';
    let sampText = '';

    try {
      compText = await generateOnePreview(markdownContent, compMessage, abortCtrl.signal);
    } catch (err) {
      console.error('[brand-voice] Comparison generation failed:', err.message);
    }

    try {
      sampText = await generateOnePreview(markdownContent, sampMessage, abortCtrl.signal);
    } catch (err) {
      console.error('[brand-voice] Sample generation failed:', err.message);
    }

    console.log(`[brand-voice] Both generations done in ${Date.now() - startTime}ms (comp: ${compText.length}, samp: ${sampText.length})`);

    // ── Retry: if one succeeded but the other failed, retry the failed one once ──
    if (compText && !sampText) {
      console.log('[brand-voice] Retrying sample generation...');
      try {
        sampText = await generateOnePreview(markdownContent, sampMessage, abortCtrl.signal);
      } catch (err) {
        console.error('[brand-voice] Sample retry failed:', err.message);
      }
    } else if (sampText && !compText) {
      console.log('[brand-voice] Retrying comparison generation...');
      try {
        compText = await generateOnePreview(markdownContent, compMessage, abortCtrl.signal);
      } catch (err) {
        console.error('[brand-voice] Comparison retry failed:', err.message);
      }
    }

    // ── Only count and update when BOTH succeed ──
    if (compText && sampText) {
      avatar.generatedComparison = compText;
      avatar.generatedSample = sampText;
      avatar.previewRegenCount += 1;
      avatar.previewsStale = false;
      avatar.previewsGenerating = false;
      console.log(`[brand-voice] Preview generation succeeded (comp: ${compText.length} chars, samp: ${sampText.length} chars)`);
      return 'success';
    } else {
      // Keep old texts, mark stale
      avatar.previewsStale = true;
      avatar.previewsGenerating = false;
      console.error(`[brand-voice] Preview generation incomplete — comp: ${compText.length} chars, samp: ${sampText.length} chars`);
      return 'failed';
    }
  } catch (err) {
    console.error('[brand-voice] Preview generation failed:', err.message);
    avatar.previewsStale = true;
    avatar.previewsGenerating = false;
    return 'failed';
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Default settings (matches frontend BRAND_VOICE_DEFAULT) ─────────── */

const DEFAULT_SETTINGS = {
  formality: 35,
  warmth: 70,
  humor: 25,
  technicality: 40,
  perspective: 'you',
  sentenceStyle: 'mixed',
  formattingHabits: ['questions-as-headings', 'short-paragraphs', 'no-intro-filler'],
  useWords: [],
  avoidWords: [],
};

/* ── 1. GET Brand Voice (active one) ──────────────────────────────────── */

const getBrandVoice = async (req, res) => {
  try {
    const workspace = req.workspace;

    // Find the active brand voice, or auto-create the first one
    let brandVoice = await BrandVoice.findOne({ workspace: workspace._id, active: true }).lean();

    if (!brandVoice) {
      // Check if any brand voice exists (maybe all inactive / locked)
      brandVoice = await BrandVoice.findOne({ workspace: workspace._id }).lean();
    }

    if (!brandVoice) {
      // First visit — create default brand voice
      const settings = DEFAULT_SETTINGS;
      const content = generateBrandVoiceMarkdown(settings);
      const b2Key = `brand-voice/${workspace._id}/brand_voice.md`;

      brandVoice = await BrandVoice.create({
        workspace: workspace._id,
        createdBy: req.user.userId,
        name: 'Default',
        active: true,
        settings,
        content,
        b2Key,
        filename: 'brand_voice.md',
      });
      brandVoice = brandVoice.toObject();

      // Fire-and-forget B2 upload
      uploadBuffer(Buffer.from(content, 'utf-8'), 'text/markdown', b2Key).catch(() => {});
    }

    res.json({ brandVoice });
  } catch (err) {
    console.error('getBrandVoice error:', err.message);
    res.status(500).json({ error: 'Failed to fetch brand voice' });
  }
};

/* ── 2. PUT Brand Voice (update by ID or active) ─────────────────────── */

const saveBrandVoice = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { settings, name } = req.body;
    if (!settings) {
      return res.status(400).json({ error: 'settings is required' });
    }
    const settingsErr = validateBrandVoiceSettings(settings);
    if (settingsErr) {
      return res.status(400).json({ error: settingsErr });
    }

    // Find target brand voice: by brandVoiceId param, or active one
    const brandVoiceId = req.params.brandVoiceId;
    if (brandVoiceId && !mongoose.Types.ObjectId.isValid(brandVoiceId)) {
      return res.status(400).json({ error: 'Invalid brand voice id' });
    }

    const content = generateBrandVoiceMarkdown(settings);
    const filter = brandVoiceId
      ? { _id: brandVoiceId, workspace: workspace._id }
      : { workspace: workspace._id, active: true };

    const updateFields = { settings, content, filename: 'brand_voice.md' };
    if (name) updateFields.name = name;

    const brandVoice = await BrandVoice.findOne(filter);
    if (!brandVoice) {
      return res.status(404).json({ error: 'Brand voice not found' });
    }

    // Upload brand_voice.md to B2
    const b2Key = `brand-voice/${workspace._id}/bv-${brandVoice._id}.md`;
    const t0 = Date.now();
    await uploadBuffer(Buffer.from(content, 'utf-8'), 'text/markdown', b2Key);
    console.log(`[saveBrandVoice] B2 upload took ${Date.now() - t0}ms`);

    updateFields.b2Key = b2Key;
    Object.assign(brandVoice, updateFields);
    await brandVoice.save();

    console.log(`[saveBrandVoice] DB save took ${Date.now() - t0}ms`);
    res.json({ brandVoice });
  } catch (err) {
    if (err instanceof mongoose.Error.ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof mongoose.Error.CastError) {
      return res.status(400).json({ error: `Invalid ${err.path || 'id'} format` });
    }
    console.error('saveBrandVoice error:', err.message);
    res.status(500).json({ error: 'Failed to save brand voice' });
  }
};

/* ── 3. POST Test Brand Voice ──────────────────────────────────────────── */

const testBrandVoice = async (req, res) => {
  try {
    const workspace = req.workspace;

    const input = (req.body.input || '').trim();
    if (!input) {
      return res.status(400).json({ error: 'input is required' });
    }
    if (countWords(input) > MAX_TEST_WORDS) {
      return res.status(400).json({ error: `Input must be ${MAX_TEST_WORDS} words or less` });
    }

    // Parallelize rate limit check + brand voice fetch (active voice)
    const [rateCheck, brandVoice] = await Promise.all([
      checkTestRateLimit(req.user.userId),
      BrandVoice.findOne({ workspace: workspace._id, active: true }),
    ]);

    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit exceeded. ${TEST_RATE_LIMIT} tests per 4 hours.`,
        remaining: 0,
      });
    }

    if (!brandVoice || !brandVoice.content) {
      return res.status(400).json({ error: 'Save your brand voice settings first' });
    }

    // Deduct credits (fixed cost: 3 credits for ~150 words)
    if (req.creditContext?.deductionEnabled) {
      try {
        await creditService.preDeduct(
          req.creditContext.orgId, req.user.userId, 3,
          req.creditContext.featureKey, { feature: 'brandVoiceTest' }
        );
      } catch (creditErr) {
        return res.status(402).json({
          error: creditErr.message,
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

    await recordTestUsage(req.user.userId);
    await streamRewriteResponse(req, res, brandVoice.content, input);
  } catch (err) {
    if (!res.headersSent) {
      console.error('testBrandVoice error:', err.message);
      res.status(500).json({ error: 'Test failed' });
    }
  }
};

/* ── 4. GET List Avatars ───────────────────────────────────────────────── */

const listAvatars = async (req, res) => {
  try {
    const workspace = req.workspace;

    const avatars = await Avatar.find({ workspace: workspace._id })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ avatars });
  } catch (err) {
    console.error('listAvatars error:', err.message);
    res.status(500).json({ error: 'Failed to fetch avatars' });
  }
};

/* ── 5. POST Create Avatar ─────────────────────────────────────────────── */

const createAvatar = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { name, emoji, role, experience, tagline, traits, writingQuirks,
            toneOverrides, vocabulary, openingStyle, sample } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const inputErr = validateAvatarInput(req.body);
    if (inputErr) {
      return res.status(400).json({ error: inputErr });
    }

    // Check avatar count against tier limit (per workspace)
    const orgId = workspace.organizationId;
    if (orgId) {
      const { config, tier } = await tierService.getOrgTierConfig(orgId);
      if (config?.maxAvatars != null) {
        const avatarCount = await Avatar.countDocuments({ workspace: workspace._id, locked: { $ne: true } });
        if (avatarCount >= config.maxAvatars) {
          return res.status(429).json({
            error: `Your ${tier} plan allows ${config.maxAvatars} avatar(s) per workspace`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: config.maxAvatars, used: avatarCount, tier, limitKey: 'maxAvatars' },
          });
        }
      }
    }

    // Determine plan tier at creation time
    const { tier } = await tierService.getOrgTierConfig(orgId);
    const createdOnPlan = tier === 'free' ? 'free' : 'paid';

    const avatarData = {
      workspace: workspace._id,
      createdBy: req.user.userId,
      name: name.trim(),
      emoji, role, experience, tagline, traits, writingQuirks,
      toneOverrides, vocabulary, openingStyle, sample,
      createdOnPlan,
    };

    // Generate avatar-only markdown
    avatarData.content = generateAvatarMarkdown(avatarData);

    const avatar = await Avatar.create(avatarData);

    // Upload avatar.md to B2
    const b2Key = `brand-voice/${workspace._id}/avatars/${avatar._id}/avatar.md`;
    await uploadBuffer(Buffer.from(avatar.content, 'utf-8'), 'text/markdown', b2Key);
    avatar.b2Key = b2Key;
    await avatar.save();

    res.status(201).json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('createAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to create avatar' });
  }
};

/* ── 5b. GET Single Avatar (for polling preview generation status) ───── */

const getAvatar = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    res.json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('getAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
};

/* ── 6. PUT Update Avatar ──────────────────────────────────────────────── */

const updateAvatar = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const inputErr = validateAvatarInput(req.body);
    if (inputErr) {
      return res.status(400).json({ error: inputErr });
    }

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    const allowed = ['name', 'emoji', 'role', 'experience', 'tagline', 'traits',
                     'writingQuirks', 'toneOverrides', 'vocabulary', 'openingStyle', 'sample', 'background'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        avatar[key] = req.body[key];
      }
    }

    // Regenerate avatar-only markdown
    avatar.content = generateAvatarMarkdown(avatar.toObject());

    // Upload avatar.md to B2
    const b2Key = `brand-voice/${workspace._id}/avatars/${avatar._id}/avatar.md`;
    const t0 = Date.now();
    await uploadBuffer(Buffer.from(avatar.content, 'utf-8'), 'text/markdown', b2Key);
    console.log(`[updateAvatar] B2 upload took ${Date.now() - t0}ms`);
    avatar.b2Key = b2Key;

    // Check rate limit before save so we can tell the frontend immediately
    const now = new Date();
    const windowStart = avatar.previewRegenWindowStart;
    const windowExpired = !windowStart || (now - windowStart) >= PREVIEW_REGEN_WINDOW_MS;
    const currentCount = windowExpired ? 0 : avatar.previewRegenCount;
    const rateLimited = currentCount >= PREVIEW_REGEN_LIMIT;

    // Mark as generating (unless rate-limited)
    if (!rateLimited) {
      avatar.previewsGenerating = true;
    }

    // Save field changes first so user edits are never lost
    await avatar.save();

    // Respond immediately — don't make the user wait for AI generation
    const previewStatus = rateLimited ? 'rate_limited' : 'generating';
    res.json({ avatar, previewStatus });

    // Fire-and-forget: generate preview texts in the background
    if (!rateLimited) {
      const brandVoice = await BrandVoice.findOne({ workspace: workspace._id, active: true }).lean();
      const result = await generateAvatarPreviews(avatar, brandVoice);
      await avatar.save();
      console.log(`[brand-voice] Background generation finished: ${result}`);
    }
  } catch (err) {
    if (!res.headersSent && handleMongooseError(res, err)) return;
    console.error('updateAvatar error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to update avatar' });
  }
};

/* ── 7. DELETE Avatar ──────────────────────────────────────────────────── */

const deleteAvatar = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const avatar = await Avatar.findOneAndDelete({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    // Clean up ALL B2 files under avatar prefix (fire-and-forget)
    // Covers avatar.md, avatar image, and all upload files + their versioned copies
    const avatarPrefix = `brand-voice/${workspace._id}/avatars/${avatarId}/`;
    deleteAllWithPrefix(avatarPrefix).then(n =>
      console.log(`[brand-voice] B2 cleanup: deleted ${n} versions under ${avatarPrefix}`)
    ).catch(err =>
      console.error(`[brand-voice] B2 cleanup failed for ${avatarPrefix}:`, err.message)
    );

    res.json({ message: 'Avatar deleted' });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('deleteAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
};

/* ── 8. PATCH Toggle Avatar Active ─────────────────────────────────────── */

const toggleAvatar = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    avatar.active = !avatar.active;
    await avatar.save();
    res.json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('toggleAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to toggle avatar' });
  }
};

/* ── 9. POST Test Avatar Writing ───────────────────────────────────────── */

const testAvatar = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const input = (req.body.input || '').trim();
    if (!input) {
      return res.status(400).json({ error: 'input is required' });
    }
    if (countWords(input) > MAX_TEST_WORDS) {
      return res.status(400).json({ error: `Input must be ${MAX_TEST_WORDS} words or less` });
    }

    const rateCheck = await checkTestRateLimit(req.user.userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit exceeded. ${TEST_RATE_LIMIT} tests per 4 hours.`,
        remaining: 0,
      });
    }

    // Parallelize DB lookups (use active brand voice)
    const [avatar, brandVoice] = await Promise.all([
      Avatar.findOne({ _id: avatarId, workspace: workspace._id }).lean(),
      BrandVoice.findOne({ workspace: workspace._id, active: true }).lean(),
    ]);
    if (!avatar || !avatar.content) {
      return res.status(400).json({ error: 'Save your avatar settings first' });
    }

    // Combine brand voice + avatar markdown at test time
    const combinedContent = brandVoice?.content
      ? brandVoice.content + '\n\n---\n\n' + avatar.content
      : avatar.content;

    // Deduct credits (fixed cost: 3 credits for ~150 words)
    if (req.creditContext?.deductionEnabled) {
      try {
        await creditService.preDeduct(
          req.creditContext.orgId, req.user.userId, 3,
          req.creditContext.featureKey, { feature: 'avatarTest', avatarId }
        );
      } catch (creditErr) {
        return res.status(402).json({
          error: creditErr.message,
          code: 'INSUFFICIENT_CREDITS',
        });
      }
    }

    await recordTestUsage(req.user.userId);
    await streamRewriteResponse(req, res, combinedContent, input);
  } catch (err) {
    if (!res.headersSent && handleMongooseError(res, err)) return;
    if (!res.headersSent) {
      console.error('testAvatar error:', err.message);
      res.status(500).json({ error: 'Test failed' });
    }
  }
};

/* ── 10. POST Upload Avatar File ───────────────────────────────────────── */

const uploadAvatarFile = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    if (avatar.uploads.length >= 5) {
      return res.status(400).json({ error: 'Maximum 5 uploads per avatar' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    // Parse file content
    const { text, wordCount } = await parseFile(req.file.buffer, req.file.mimetype);
    if (wordCount < 50) {
      return res.status(400).json({ error: 'File must contain at least 50 words' });
    }

    // Upload original file to B2
    const hash = crypto.createHash('md5').update(req.file.buffer).digest('hex').slice(0, 8);
    const rawExt = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const ext = rawExt.replace(/[^a-z0-9]/g, '') || 'bin';
    const b2Key = `brand-voice/${workspace._id}/avatars/${avatarId}/documents/${Date.now()}-${hash}.${ext}`;
    await uploadBuffer(req.file.buffer, req.file.mimetype, b2Key);

    // Add upload record
    const uploadDoc = {
      originalName: req.file.originalname,
      b2Key,
      size: req.file.size,
      words: wordCount,
      status: 'learning',
    };
    avatar.uploads.push(uploadDoc);
    await avatar.save();

    const savedUpload = avatar.uploads[avatar.uploads.length - 1];

    // Fire-and-forget: summarize writing style via lightweight /api/rewrite
    (async () => {
      const t0 = Date.now();
      try {
        const systemPrompt = `You are a writing style analyst. Analyze the writing sample provided by the user and extract the author's writing style. Focus on:
1. Sentence structure patterns (short/long, simple/complex)
2. Vocabulary preferences and register
3. Tone and voice characteristics
4. Opening/closing patterns
5. Use of examples, analogies, or data
6. Paragraph length tendencies
7. Distinctive quirks or habits

Provide a concise style summary (max 200 words) that can be used to replicate this writing style. Only output the summary, nothing else.`;

        const response = await fetch(`${writingEngine.WRITING_ENGINE_URL}/api/rewrite`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.REWRITE_SECRET && { 'X-Rewrite-Secret': process.env.REWRITE_SECRET }),
          },
          body: JSON.stringify({
            systemPrompt,
            userMessage: text,
            maxTokens: 1000,
          }),
        });

        if (!response.ok) {
          throw new Error(`Rewrite API error (${response.status})`);
        }

        const fullText = await collectStreamText(response);
        console.log(`[brand-voice] summarization via /api/rewrite: ${Date.now() - t0}ms (${fullText.length} chars)`);

        // Update upload record
        await Avatar.findOneAndUpdate(
          { _id: avatarId, 'uploads._id': savedUpload._id },
          {
            $set: {
              'uploads.$.summary': fullText.trim(),
              'uploads.$.status': 'learned',
            },
          }
        );

        // Regenerate avatar-only markdown with new insights + upload to B2
        const updatedAvatar = await Avatar.findById(avatarId);
        if (updatedAvatar) {
          updatedAvatar.content = generateAvatarMarkdown(updatedAvatar.toObject());
          const mdKey = `brand-voice/${workspace._id}/avatars/${avatarId}/avatar.md`;
          await uploadBuffer(Buffer.from(updatedAvatar.content, 'utf-8'), 'text/markdown', mdKey);
          updatedAvatar.b2Key = mdKey;
          await updatedAvatar.save();
        }

        console.log(`[brand-voice] summarization complete for upload ${savedUpload._id} (${Date.now() - t0}ms total)`);
      } catch (err) {
        console.error(`[brand-voice] summarization failed for upload ${savedUpload._id}:`, err.message);
        // Mark upload as failed so UI doesn't show "Learning..." forever
        await Avatar.findOneAndUpdate(
          { _id: avatarId, 'uploads._id': savedUpload._id },
          { $set: { 'uploads.$.status': 'failed' } }
        ).catch(() => {});
      }
    })();

    res.status(201).json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('uploadAvatarFile error:', err.message);
    res.status(500).json({ error: 'Failed to upload file' });
  }
};

/* ── 11. DELETE Avatar Upload ──────────────────────────────────────────── */

const deleteAvatarUpload = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId, uploadId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;
    if (!ensureValidObjectId(res, uploadId, 'upload id')) return;

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    const upload = avatar.uploads.id(uploadId);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    // Delete all versions from B2 (fire-and-forget)
    if (upload.b2Key) {
      deleteAllWithPrefix(upload.b2Key).catch(err =>
        console.error(`[brand-voice] B2 delete failed for ${upload.b2Key}:`, err.message)
      );
    }

    upload.deleteOne();

    // Regenerate avatar-only markdown + upload to B2
    avatar.content = generateAvatarMarkdown(avatar.toObject());
    const mdKey = `brand-voice/${workspace._id}/avatars/${avatar._id}/avatar.md`;
    await uploadBuffer(Buffer.from(avatar.content, 'utf-8'), 'text/markdown', mdKey);
    avatar.b2Key = mdKey;
    await avatar.save();

    res.json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('deleteAvatarUpload error:', err.message);
    res.status(500).json({ error: 'Failed to delete upload' });
  }
};

/* ── GET Rate Limit Status ─────────────────────────────────────────────── */

const getTestRateLimit = async (req, res) => {
  try {
    const rateCheck = await checkTestRateLimit(req.user.userId);
    res.json(rateCheck);
  } catch (err) {
    console.error('getTestRateLimit error:', err.message);
    res.status(500).json({ error: 'Failed to check rate limit' });
  }
};

/* ── 12. POST Upload Avatar Image ─────────────────────────────────── */

const uploadAvatarImage = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    // Delete all versions of old image from B2 if exists
    if (avatar.avatarImage) {
      deleteAllWithPrefix(avatar.avatarImage).catch(err =>
        console.error(`[brand-voice] B2 delete old avatar image failed:`, err.message)
      );
    }

    // Upload to B2 under the avatar folder
    const imgExt = req.file.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : req.file.mimetype.split('/')[1] || 'png';
    const imgHash = crypto.createHash('md5').update(req.file.buffer).digest('hex').slice(0, 8);
    const b2Key = `brand-voice/${workspace._id}/avatars/${avatarId}/image-${imgHash}.${imgExt}`;
    await uploadBuffer(req.file.buffer, req.file.mimetype, b2Key);
    avatar.avatarImage = b2Key;
    await avatar.save();

    res.json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('uploadAvatarImage error:', err.message);
    res.status(500).json({ error: 'Failed to upload avatar image' });
  }
};

/* ── 13. DELETE Avatar Image ─────────────────────────────────────── */

const deleteAvatarImage = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    if (avatar.avatarImage) {
      deleteAllWithPrefix(avatar.avatarImage).catch(err =>
        console.error(`[brand-voice] B2 delete avatar image failed:`, err.message)
      );
      avatar.avatarImage = '';
      await avatar.save();
    }

    res.json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('deleteAvatarImage error:', err.message);
    res.status(500).json({ error: 'Failed to delete avatar image' });
  }
};

/* ── 14. POST Import Google Doc URL ────────────────────────────────── */

const GOOGLE_DOC_REGEX = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;

const importGoogleDoc = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { avatarId } = req.params;
    if (!ensureValidObjectId(res, avatarId, 'avatar id')) return;

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    if (avatar.uploads.length >= 5) {
      return res.status(400).json({ error: 'Maximum 5 uploads per avatar' });
    }

    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const match = url.match(GOOGLE_DOC_REGEX);
    if (!match) {
      return res.status(400).json({ error: 'Invalid Google Docs URL. Expected format: https://docs.google.com/document/d/...' });
    }

    const docId = match[1];
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

    let text;
    try {
      const fetchRes = await fetch(exportUrl);
      if (!fetchRes.ok) {
        if (fetchRes.status === 404) {
          return res.status(400).json({ error: 'Google Doc not found. Make sure the document exists.' });
        }
        if (fetchRes.status === 401 || fetchRes.status === 403) {
          return res.status(400).json({ error: 'Cannot access this Google Doc. Make sure sharing is set to "Anyone with the link".' });
        }
        return res.status(400).json({ error: `Failed to fetch Google Doc (HTTP ${fetchRes.status})` });
      }
      text = await fetchRes.text();
    } catch (err) {
      return res.status(400).json({ error: 'Failed to fetch Google Doc. Check your URL and try again.' });
    }

    // Clean up whitespace
    text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    if (wordCount < 50) {
      return res.status(400).json({ error: `Document only has ${wordCount} words. Minimum 50 words required.` });
    }

    // Upload text to B2
    const buffer = Buffer.from(text, 'utf-8');
    const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 8);
    const b2Key = `brand-voice/${workspace._id}/avatars/${avatarId}/documents/${Date.now()}-${hash}.txt`;
    await uploadBuffer(buffer, 'text/plain', b2Key);

    // Add upload record
    const uploadDoc = {
      originalName: `Google Doc (${docId.slice(0, 8)}…)`,
      b2Key,
      size: buffer.length,
      words: wordCount,
      status: 'learning',
    };
    avatar.uploads.push(uploadDoc);
    await avatar.save();

    const savedUpload = avatar.uploads[avatar.uploads.length - 1];

    // Fire-and-forget: summarize writing style via lightweight /api/rewrite
    (async () => {
      const t0 = Date.now();
      try {
        const systemPrompt = `You are a writing style analyst. Analyze the writing sample provided by the user and extract the author's writing style. Focus on:
1. Sentence structure patterns (short/long, simple/complex)
2. Vocabulary preferences and register
3. Tone and voice characteristics
4. Opening/closing patterns
5. Use of examples, analogies, or data
6. Paragraph length tendencies
7. Distinctive quirks or habits

Provide a concise style summary (max 200 words) that can be used to replicate this writing style. Only output the summary, nothing else.`;

        const response = await fetch(`${writingEngine.WRITING_ENGINE_URL}/api/rewrite`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.REWRITE_SECRET && { 'X-Rewrite-Secret': process.env.REWRITE_SECRET }),
          },
          body: JSON.stringify({
            systemPrompt,
            userMessage: text,
            maxTokens: 1000,
          }),
        });

        if (!response.ok) {
          throw new Error(`Rewrite API error (${response.status})`);
        }

        const fullText = await collectStreamText(response);
        console.log(`[brand-voice] Google Doc summarization via /api/rewrite: ${Date.now() - t0}ms (${fullText.length} chars)`);

        await Avatar.findOneAndUpdate(
          { _id: avatarId, 'uploads._id': savedUpload._id },
          {
            $set: {
              'uploads.$.summary': fullText.trim(),
              'uploads.$.status': 'learned',
            },
          }
        );

        const updatedAvatar = await Avatar.findById(avatarId);
        if (updatedAvatar) {
          updatedAvatar.content = generateAvatarMarkdown(updatedAvatar.toObject());
          const mdKey = `brand-voice/${workspace._id}/avatars/${avatarId}/avatar.md`;
          await uploadBuffer(Buffer.from(updatedAvatar.content, 'utf-8'), 'text/markdown', mdKey);
          updatedAvatar.b2Key = mdKey;
          await updatedAvatar.save();
        }

        console.log(`[brand-voice] Google Doc summarization complete for upload ${savedUpload._id} (${Date.now() - t0}ms total)`);
      } catch (err) {
        console.error(`[brand-voice] Google Doc summarization failed for upload ${savedUpload._id}:`, err.message);
        await Avatar.findOneAndUpdate(
          { _id: avatarId, 'uploads._id': savedUpload._id },
          { $set: { 'uploads.$.status': 'failed' } }
        ).catch(() => {});
      }
    })();

    res.status(201).json({ avatar });
  } catch (err) {
    if (handleMongooseError(res, err)) return;
    console.error('importGoogleDoc error:', err.message);
    res.status(500).json({ error: 'Failed to import Google Doc' });
  }
};

/* ── Brand Voice CRUD (multiple voices per workspace) ─────────────────── */

const listBrandVoices = async (req, res) => {
  try {
    const workspace = req.workspace;
    const voices = await BrandVoice.find({ workspace: workspace._id })
      .sort({ createdAt: 1 })
      .lean();

    // Auto-create default if none exist
    if (voices.length === 0) {
      // Determine plan tier for the auto-created default voice
      const orgId = workspace.organizationId;
      let autoCreatedOnPlan = 'free';
      if (orgId) {
        const { tier } = await tierService.getOrgTierConfig(orgId);
        autoCreatedOnPlan = tier === 'free' ? 'free' : 'paid';
      }

      const settings = DEFAULT_SETTINGS;
      const content = generateBrandVoiceMarkdown(settings);
      const b2Key = `brand-voice/${workspace._id}/brand_voice.md`;
      const created = await BrandVoice.create({
        workspace: workspace._id,
        createdBy: req.user.userId,
        name: 'Default',
        active: true,
        settings,
        content,
        b2Key,
        filename: 'brand_voice.md',
        createdOnPlan: autoCreatedOnPlan,
      });
      uploadBuffer(Buffer.from(content, 'utf-8'), 'text/markdown', b2Key).catch(() => {});
      return res.json({ voices: [created.toObject()] });
    }

    res.json({ voices });
  } catch (err) {
    console.error('listBrandVoices error:', err.message);
    res.status(500).json({ error: 'Failed to list brand voices' });
  }
};

const createBrandVoice = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    // Check brand voice count against tier limit (per workspace)
    const orgId = workspace.organizationId;
    if (orgId) {
      const { config, tier } = await tierService.getOrgTierConfig(orgId);
      if (config?.maxBrandVoices != null) {
        const count = await BrandVoice.countDocuments({ workspace: workspace._id, locked: { $ne: true } });
        if (count >= config.maxBrandVoices) {
          return res.status(429).json({
            error: `Your ${tier} plan allows ${config.maxBrandVoices} brand voice(s) per workspace`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: config.maxBrandVoices, used: count, tier, limitKey: 'maxBrandVoices' },
          });
        }
      }
    }

    // Determine plan tier at creation time
    const { tier } = await tierService.getOrgTierConfig(orgId);
    const createdOnPlan = tier === 'free' ? 'free' : 'paid';

    const settings = DEFAULT_SETTINGS;
    const content = generateBrandVoiceMarkdown(settings);

    const brandVoice = await BrandVoice.create({
      workspace: workspace._id,
      createdBy: req.user.userId,
      name: name.trim(),
      active: false, // new voices start inactive
      settings,
      content,
      filename: 'brand_voice.md',
      createdOnPlan,
    });

    // Upload to B2
    const b2Key = `brand-voice/${workspace._id}/bv-${brandVoice._id}.md`;
    await uploadBuffer(Buffer.from(content, 'utf-8'), 'text/markdown', b2Key);
    brandVoice.b2Key = b2Key;
    await brandVoice.save();

    res.status(201).json({ brandVoice });
  } catch (err) {
    console.error('createBrandVoice error:', err.message);
    res.status(500).json({ error: 'Failed to create brand voice' });
  }
};

const deleteBrandVoice = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { brandVoiceId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(brandVoiceId)) {
      return res.status(400).json({ error: 'Invalid brand voice id' });
    }

    const bv = await BrandVoice.findOne({ _id: brandVoiceId, workspace: workspace._id });
    if (!bv) {
      return res.status(404).json({ error: 'Brand voice not found' });
    }

    // Prevent deleting the last brand voice
    const count = await BrandVoice.countDocuments({ workspace: workspace._id });
    if (count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last brand voice' });
    }

    const wasActive = bv.active;
    await bv.deleteOne();

    // Clean up B2
    if (bv.b2Key) {
      deleteObject(bv.b2Key).catch(() => {});
    }

    // If deleted voice was active, activate the oldest remaining
    if (wasActive) {
      await BrandVoice.findOneAndUpdate(
        { workspace: workspace._id, locked: { $ne: true } },
        { $set: { active: true } },
        { sort: { createdAt: 1 } }
      );
    }

    res.json({ success: true });
  } catch (err) {
    if (err instanceof mongoose.Error.CastError) {
      return res.status(400).json({ error: `Invalid ${err.path || 'id'} format` });
    }
    console.error('deleteBrandVoice error:', err.message);
    res.status(500).json({ error: 'Failed to delete brand voice' });
  }
};

const toggleBrandVoice = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { brandVoiceId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(brandVoiceId)) {
      return res.status(400).json({ error: 'Invalid brand voice id' });
    }

    const bv = await BrandVoice.findOne({ _id: brandVoiceId, workspace: workspace._id });
    if (!bv) {
      return res.status(404).json({ error: 'Brand voice not found' });
    }

    // Deactivate all others in the workspace, activate this one
    await BrandVoice.updateMany(
      { workspace: workspace._id, _id: { $ne: bv._id } },
      { $set: { active: false } }
    );
    bv.active = true;
    await bv.save();

    res.json({ brandVoice: bv });
  } catch (err) {
    if (err instanceof mongoose.Error.CastError) {
      return res.status(400).json({ error: `Invalid ${err.path || 'id'} format` });
    }
    console.error('toggleBrandVoice error:', err.message);
    res.status(500).json({ error: 'Failed to toggle brand voice' });
  }
};

module.exports = {
  getBrandVoice,
  saveBrandVoice,
  testBrandVoice,
  listBrandVoices,
  createBrandVoice,
  deleteBrandVoice,
  toggleBrandVoice,
  listAvatars,
  getAvatar,
  createAvatar,
  updateAvatar,
  deleteAvatar,
  toggleAvatar,
  testAvatar,
  uploadAvatarFile,
  deleteAvatarUpload,
  uploadAvatarImage,
  deleteAvatarImage,
  getTestRateLimit,
  importGoogleDoc,
};
