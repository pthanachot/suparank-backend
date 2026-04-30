const Workspace = require('../models/Workspace');
const BrandVoice = require('../models/BrandVoice');
const Avatar = require('../models/Avatar');
const BrandVoiceTestLog = require('../models/BrandVoiceTestLog');
const { generateBrandVoiceMarkdown, generateAvatarMarkdown } = require('../services/brandVoiceMarkdown');
const { parseFile } = require('../services/fileParser');
const { uploadBuffer, deleteObject } = require('../services/imageStorage');
const writingEngine = require('../services/writingEngine');
const crypto = require('crypto');

/* ── Shared: resolve workspace ─────────────────────────────────────────── */

async function resolveWorkspace(req, res) {
  const { workspaceNumber } = req.params;
  const workspace = await Workspace.findOne({
    workspaceNumber: Number(workspaceNumber),
    $or: [
      { userId: req.user.userId },
      { 'members.userId': req.user.userId },
    ],
  });
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  return workspace;
}

/* ── Rate limit helpers ───────────────────────────────────────────────── */

async function checkTestRateLimit(userId) {
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const count = await BrandVoiceTestLog.countDocuments({
    userId,
    createdAt: { $gte: fourHoursAgo },
  });
  return { allowed: count < 10, remaining: Math.max(0, 10 - count) };
}

async function recordTestUsage(userId) {
  await BrandVoiceTestLog.create({ userId });
}

/* ── Input validation helpers ────────────────────────────────────────── */

const MAX_TEST_WORDS = 150;

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/* ── SSE streaming helper ─────────────────────────────────────────────── */

async function streamWritingEngineResponse(req, res, markdownContent, userInput) {
  const abortCtrl = new AbortController();
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    abortCtrl.abort();
  });

  const sessionId = await writingEngine.createSession();
  await writingEngine.pushDocument(sessionId, markdownContent);

  const prompt = `You are a writing assistant. The document above defines a brand voice with specific tone, vocabulary rules, and style preferences.

CRITICAL RULES:
- Follow every instruction in the document exactly.
- If the document lists "Never Use" words, you MUST NOT use any of those words or phrases — no exceptions.
- If the document lists "Always Use" words, incorporate them naturally.
- Match the specified tone (formality, warmth, humor) precisely.
- Follow the perspective and sentence style instructions.
- Keep your response under ${MAX_TEST_WORDS} words.
- Only output the rewritten text, nothing else.

Text to rewrite:
${userInput}`;

  const chatRes = await writingEngine.sendChatMessageStream(sessionId, prompt, abortCtrl.signal);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader = chatRes.body.getReader();
  abortCtrl.signal.addEventListener('abort', () => {
    reader.cancel().catch(() => {});
  });

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

/* ── 1. GET Brand Voice ────────────────────────────────────────────────── */

const getBrandVoice = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const brandVoice = await BrandVoice.findOne({ workspace: workspace._id }).lean();
    res.json({ brandVoice: brandVoice || null });
  } catch (err) {
    console.error('getBrandVoice error:', err.message);
    res.status(500).json({ error: 'Failed to fetch brand voice' });
  }
};

/* ── 2. PUT (upsert) Brand Voice ───────────────────────────────────────── */

const saveBrandVoice = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { settings } = req.body;
    if (!settings) {
      return res.status(400).json({ error: 'settings is required' });
    }

    const content = generateBrandVoiceMarkdown(settings);

    // Upload brand_voice.md to B2
    const b2Key = `brand-voice/${workspace._id}/brand_voice.md`;
    await uploadBuffer(Buffer.from(content, 'utf-8'), 'text/markdown', b2Key);

    const brandVoice = await BrandVoice.findOneAndUpdate(
      { workspace: workspace._id },
      {
        $set: { settings, content, b2Key, filename: 'brand_voice.md' },
        $setOnInsert: { createdBy: req.user.userId, workspace: workspace._id },
      },
      { upsert: true, new: true, runValidators: true }
    );

    res.json({ brandVoice });
  } catch (err) {
    console.error('saveBrandVoice error:', err.message);
    res.status(500).json({ error: 'Failed to save brand voice' });
  }
};

/* ── 3. POST Test Brand Voice ──────────────────────────────────────────── */

const testBrandVoice = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { input } = req.body;
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input is required' });
    }
    if (countWords(input) > MAX_TEST_WORDS) {
      return res.status(400).json({ error: `Input must be ${MAX_TEST_WORDS} words or less` });
    }

    const rateCheck = await checkTestRateLimit(req.user.userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded. 10 tests per 4 hours.',
        remaining: 0,
      });
    }

    const brandVoice = await BrandVoice.findOne({ workspace: workspace._id });
    if (!brandVoice || !brandVoice.content) {
      return res.status(400).json({ error: 'Save your brand voice settings first' });
    }

    await recordTestUsage(req.user.userId);
    await streamWritingEngineResponse(req, res, brandVoice.content, input);
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { name, emoji, role, experience, tagline, traits, writingQuirks,
            toneOverrides, vocabulary, openingStyle, sample } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const avatarData = {
      workspace: workspace._id,
      createdBy: req.user.userId,
      name: name.trim(),
      emoji, role, experience, tagline, traits, writingQuirks,
      toneOverrides, vocabulary, openingStyle, sample,
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
    console.error('createAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to create avatar' });
  }
};

/* ── 6. PUT Update Avatar ──────────────────────────────────────────────── */

const updateAvatar = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { avatarId } = req.params;
    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    const allowed = ['name', 'emoji', 'role', 'experience', 'tagline', 'traits',
                     'writingQuirks', 'toneOverrides', 'vocabulary', 'openingStyle', 'sample'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        avatar[key] = req.body[key];
      }
    }

    // Regenerate avatar-only markdown
    avatar.content = generateAvatarMarkdown(avatar.toObject());

    // Upload avatar.md to B2
    const b2Key = `brand-voice/${workspace._id}/avatars/${avatar._id}/avatar.md`;
    await uploadBuffer(Buffer.from(avatar.content, 'utf-8'), 'text/markdown', b2Key);
    avatar.b2Key = b2Key;

    await avatar.save();
    res.json({ avatar });
  } catch (err) {
    console.error('updateAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
};

/* ── 7. DELETE Avatar ──────────────────────────────────────────────────── */

const deleteAvatar = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { avatarId } = req.params;
    const avatar = await Avatar.findOneAndDelete({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    // Clean up B2 files (fire-and-forget): avatar.md + upload files
    if (avatar.b2Key) {
      deleteObject(avatar.b2Key).catch(err =>
        console.error(`[brand-voice] B2 delete failed for avatar.md ${avatar.b2Key}:`, err.message)
      );
    }
    for (const upload of avatar.uploads || []) {
      if (upload.b2Key) {
        deleteObject(upload.b2Key).catch(err =>
          console.error(`[brand-voice] B2 delete failed for ${upload.b2Key}:`, err.message)
        );
      }
    }

    res.json({ message: 'Avatar deleted' });
  } catch (err) {
    console.error('deleteAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
};

/* ── 8. PATCH Toggle Avatar Active ─────────────────────────────────────── */

const toggleAvatar = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { avatarId } = req.params;
    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    avatar.active = !avatar.active;
    await avatar.save();
    res.json({ avatar });
  } catch (err) {
    console.error('toggleAvatar error:', err.message);
    res.status(500).json({ error: 'Failed to toggle avatar' });
  }
};

/* ── 9. POST Test Avatar Writing ───────────────────────────────────────── */

const testAvatar = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { avatarId } = req.params;
    const { input } = req.body;
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input is required' });
    }
    if (countWords(input) > MAX_TEST_WORDS) {
      return res.status(400).json({ error: `Input must be ${MAX_TEST_WORDS} words or less` });
    }

    const rateCheck = await checkTestRateLimit(req.user.userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded. 10 tests per 4 hours.',
        remaining: 0,
      });
    }

    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar || !avatar.content) {
      return res.status(400).json({ error: 'Save your avatar settings first' });
    }

    // Combine brand voice + avatar markdown at test time
    const brandVoice = await BrandVoice.findOne({ workspace: workspace._id }).lean();
    const combinedContent = brandVoice?.content
      ? brandVoice.content + '\n\n---\n\n' + avatar.content
      : avatar.content;

    await recordTestUsage(req.user.userId);
    await streamWritingEngineResponse(req, res, combinedContent, input);
  } catch (err) {
    if (!res.headersSent) {
      console.error('testAvatar error:', err.message);
      res.status(500).json({ error: 'Test failed' });
    }
  }
};

/* ── 10. POST Upload Avatar File ───────────────────────────────────────── */

const uploadAvatarFile = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { avatarId } = req.params;
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
    const ext = req.file.originalname.split('.').pop() || 'bin';
    const b2Key = `brand-voice/${workspace._id}/${avatarId}/${Date.now()}-${hash}.${ext}`;
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

    // Fire-and-forget: summarize writing style via Writing Engine
    (async () => {
      try {
        const sessionId = await writingEngine.createSession();
        await writingEngine.pushDocument(sessionId, text);

        const summarizePrompt = `Analyze this writing sample and extract the author's writing style. Focus on:
1. Sentence structure patterns (short/long, simple/complex)
2. Vocabulary preferences and register
3. Tone and voice characteristics
4. Opening/closing patterns
5. Use of examples, analogies, or data
6. Paragraph length tendencies
7. Distinctive quirks or habits

Provide a concise style summary (max 200 words) that can be used to replicate this writing style. Only output the summary, nothing else.`;

        const chatRes = await writingEngine.sendChatMessageStream(sessionId, summarizePrompt);

        // Consume SSE stream to get full response
        const reader = chatRes.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE events — extract text_delta data
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'text_delta' && typeof data.textDelta === 'string') {
                  fullText += data.textDelta;
                } else if (data.type === 'complete' && typeof data.fullText === 'string') {
                  fullText = data.fullText;
                }
              } catch { /* skip unparseable */ }
            }
          }
        }

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

        console.log(`[brand-voice] summarization complete for upload ${savedUpload._id}`);
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
    console.error('uploadAvatarFile error:', err.message);
    res.status(500).json({ error: 'Failed to upload file' });
  }
};

/* ── 11. DELETE Avatar Upload ──────────────────────────────────────────── */

const deleteAvatarUpload = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { avatarId, uploadId } = req.params;
    const avatar = await Avatar.findOne({ _id: avatarId, workspace: workspace._id });
    if (!avatar) {
      return res.status(404).json({ error: 'Avatar not found' });
    }

    const upload = avatar.uploads.id(uploadId);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    // Delete from B2 (fire-and-forget)
    if (upload.b2Key) {
      deleteObject(upload.b2Key).catch(err =>
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

module.exports = {
  getBrandVoice,
  saveBrandVoice,
  testBrandVoice,
  listAvatars,
  createAvatar,
  updateAvatar,
  deleteAvatar,
  toggleAvatar,
  testAvatar,
  uploadAvatarFile,
  deleteAvatarUpload,
  getTestRateLimit,
};
