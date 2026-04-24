const Workspace = require('../models/Workspace');
const Content = require('../models/Content');
const { runAnalysis } = require('./analysisController');
const imageStorage = require('../services/imageStorage');

// Middleware-style: resolve workspace from :workspaceNumber param
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

// ─── LIST CONTENTS (summaries) ─────────────────────────────────

const listContents = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { status, folder } = req.query;
    const contents = await Content.findSummariesByWorkspace(workspace._id, { status, folder });
    res.json({ contents });
  } catch (err) {
    console.error('listContents error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contents' });
  }
};

// ─── GET SINGLE CONTENT (by contentNumber) ─────────────────────

const getContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findByNumber(workspace._id, req.params.contentNumber);
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    // Migrate old public B2 URLs to new /api/b2-image/ path format
    if (content.blocks && Array.isArray(content.blocks)) {
      for (const block of content.blocks) {
        if (block.type === 'img' && block.src) {
          const migrated = imageStorage.migratePublicUrl(block.src);
          if (migrated) block.src = migrated;
        }
      }
    }

    res.json({ content });
  } catch (err) {
    console.error('getContent error:', err.message);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
};

// ─── CREATE CONTENT ────────────────────────────────────────────

const createContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const contentNumber = await Content.getNextContentNumber();
    const { title, slug, description, blocks, targetKeywords, country, device, score, wordCount, status, folder, platform, versions } = req.body;

    const content = await Content.create({
      userId: req.user.userId,
      workspaceId: workspace._id,
      contentNumber,
      title,
      slug,
      description,
      blocks: blocks || [],
      targetKeywords: targetKeywords || [],
      country,
      device,
      score,
      wordCount,
      status,
      folder,
      platform,
      versions: versions || [],
    });

    // Auto-trigger analysis if keywords are provided
    if (content.targetKeywords && content.targetKeywords.length > 0) {
      await Content.findByIdAndUpdate(content._id, { $set: { analysisStatus: 'pending' } });
      runAnalysis(content._id);
    }

    res.status(201).json({ content });
  } catch (err) {
    console.error('createContent error:', err.message);
    res.status(500).json({ error: 'Failed to create content' });
  }
};

// ─── UPDATE CONTENT ────────────────────────────────────────────

const updateContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const allowedFields = [
      'title', 'slug', 'description', 'blocks', 'targetKeywords',
      'country', 'device', 'score', 'wordCount', 'status', 'folder', 'platform',
      'versions', 'publishedAt', 'scheduledAt',
      'contentType', 'contentContext', 'targetWordCount', 'writingMode',
      'styleReferenceContentNumber',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Upload any remaining base64/temp-URL images to B2 before saving
    if (updates.blocks && Array.isArray(updates.blocks) && imageStorage.isEnabled()) {
      for (const block of updates.blocks) {
        if (block.type !== 'img' || !block.src) continue;
        try {
          if (block.src.startsWith('data:image/')) {
            block.src = await imageStorage.uploadFromDataUri(
              block.src, workspace._id.toString(), req.params.contentNumber,
            );
          } else if (block.src.includes('/api/images/img_')) {
            block.src = await imageStorage.uploadFromUrl(
              block.src, workspace._id.toString(), req.params.contentNumber,
            );
          }
        } catch (err) {
          console.error(`B2 upload failed for block ${block.id} (non-fatal):`, err.message);
        }
      }
    }

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber) },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    res.json({ content });
  } catch (err) {
    console.error('updateContent error:', err.message);
    res.status(500).json({ error: 'Failed to update content' });
  }
};

// ─── DELETE CONTENT ────────────────────────────────────────────

const deleteContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findOneAndDelete({
      workspaceId: workspace._id,
      contentNumber: Number(req.params.contentNumber),
    });
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    res.json({ message: 'Content deleted' });
  } catch (err) {
    console.error('deleteContent error:', err.message);
    res.status(500).json({ error: 'Failed to delete content' });
  }
};

// ─── ADD COMMENT ──────────────────────────────────────────────

const User = require('../models/User');

const addComment = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { blockId, selectedText, text } = req.body;
    if (!blockId || !text) return res.status(400).json({ error: 'blockId and text are required' });

    const user = await User.findById(req.user.userId).select('email profile.name').lean();
    const comment = {
      id: 'c' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      blockId,
      selectedText: selectedText || undefined,
      text,
      authorEmail: user?.email || req.user.email,
      authorName: user?.profile?.name || undefined,
      createdAt: Date.now(),
    };

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber) },
      { $push: { comments: comment } },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    res.json({ comment });
  } catch (err) {
    console.error('addComment error:', err.message);
    res.status(500).json({ error: 'Failed to add comment' });
  }
};

// ─── UPDATE COMMENT (resolve / edit) ──────────────────────────

const updateComment = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { commentId } = req.params;
    const update = {};
    if (req.body.text !== undefined) update['comments.$.text'] = req.body.text;
    if (req.body.resolvedAt !== undefined) update['comments.$.resolvedAt'] = req.body.resolvedAt;

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber), 'comments.id': commentId },
      { $set: update },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content or comment not found' });

    const updated = content.comments.find(c => c.id === commentId);
    res.json({ comment: updated });
  } catch (err) {
    console.error('updateComment error:', err.message);
    res.status(500).json({ error: 'Failed to update comment' });
  }
};

// ─── DELETE COMMENT ───────────────────────────────────────────

const deleteComment = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber) },
      { $pull: { comments: { id: req.params.commentId } } },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    res.json({ message: 'Comment deleted' });
  } catch (err) {
    console.error('deleteComment error:', err.message);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

// ─── CONTENT AUDIT (via OpenRouter / Kimi K2) ────────────────

const crypto = require('crypto');

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

function blocksToText(blocks) {
  return (blocks || []).map((b) => {
    const text = stripTags(b.text);
    if (b.type === 'h1') return '# ' + text;
    if (b.type === 'h2') return '## ' + text;
    if (b.type === 'h3') return '### ' + text;
    if (b.type === 'h4') return '#### ' + text;
    if (b.type === 'h5') return '##### ' + text;
    if (b.type === 'h6') return '###### ' + text;
    if (b.type === 'li') return '- ' + text;
    if (b.type === 'ol') return '1. ' + text;
    if (b.type === 'quote') return '> ' + text;
    if (b.type === 'faq' && b.faqItems) return b.faqItems.map((f) => `**Q: ${f.question}**\nA: ${f.answer}`).join('\n');
    if (b.type === 'code' && b.codeData) return '```' + (b.codeData.language || '') + '\n' + b.codeData.code + '\n```';
    if (b.type === 'table' && b.tableData) {
      const h = (b.tableData.headers || []).join(' | ');
      const rows = (b.tableData.rows || []).map((r) => r.join(' | ')).join('\n');
      return h + '\n' + rows;
    }
    if (b.type === 'toggle' && b.toggleData) return '**' + (b.toggleData.summary || '') + '**\n' + (b.toggleData.content || '');
    if (b.type === 'divider') return '---';
    return text;
  }).filter(Boolean).join('\n\n');
}

function computeContentHash(blocks) {
  const text = (blocks || []).map((b) => {
    let t = b.text || '';
    if (b.faqItems) t += b.faqItems.map((f) => f.question + f.answer).join('');
    if (b.toggleData) t += (b.toggleData.summary || '') + (b.toggleData.content || '');
    if (b.tableData) t += (b.tableData.headers || []).join('') + (b.tableData.rows || []).map((r) => r.join('')).join('');
    return t;
  }).join('');
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
}

function buildAuditPrompt(markdown, keyword, wordCount) {
  return `You are a senior content editor with 15 years of experience in digital publishing and SEO.

Audit the following article against 9 editorial criteria. For each criterion, provide:
- A score from 1-10
- A status: "good" (7-10), "warning" (4-6), or "fail" (1-3)
- Specific, actionable feedback (2-3 sentences max). Reference exact sections, headings, or paragraphs from the article. Do NOT give generic advice.

Target keyword: ${keyword || '(not specified)'}
Word count: ${wordCount}

THE 9 CRITERIA (evaluate in this order):

1. AUDIENCE-PURPOSE FIT
   - Is the target audience clearly defined through language and depth?
   - Does the content match a clear intent (educate, convert, rank)?
   - Would a reader know within 10 seconds if this is for them?

2. ANGLE & DIFFERENTIATION
   - What unique perspective does this offer vs existing content?
   - Is there a clear "why read THIS instead of the top 3 Google results"?
   - Flag if it reads like a generic overview with no original insight.

3. STRUCTURE & LOGICAL FLOW
   - Does it flow logically: intro → core ideas → conclusion?
   - Is the heading hierarchy clean (H1→H2→H3, no skipped levels)?
   - Are there redundant sections, missing transitions, or logical gaps?

4. EVIDENCE & DEPTH
   - Are claims supported by data, examples, or credible reasoning?
   - Is depth appropriate for the audience (beginner=clarity, expert=insight)?
   - Flag unsupported claims and thin sections.

5. SEO & DISCOVERABILITY
   - Is the target keyword present in H1, intro, and naturally throughout?
   - Does the content cover the subtopics that searchers expect?
   - Are there missing questions or topics the competitors cover?

6. FEASIBILITY & COMPLETENESS
   - Does the article deliver on the promise of its title/H1?
   - Are there sections that feel rushed or incomplete?
   - Does the scope match what a reader would expect?

7. VOICE, TONE & BRAND
   - Is the tone consistent throughout (not switching between formal/casual)?
   - Does it sound human and confident, not robotic or hedging?
   - Is there unnecessary jargon or filler language?

8. CONVERSION & NEXT STEPS
   - Is there a clear call-to-action or logical next step for the reader?
   - Does the structure naturally guide toward that action?
   - Are internal links and CTAs placed naturally, not forced?

9. RISK & ACCURACY
   - Are there misleading claims, absolute statements without evidence?
   - Could any content create legal, factual, or reputational risk?
   - Flag any "guaranteed", "best", "always/never" language without support.

ARTICLE TO AUDIT:
---
${markdown}
---

Return ONLY valid JSON (no markdown fences, no extra text) in this exact format:
{
  "overallScore": <number 1-100>,
  "summary": "<1-2 sentence overall assessment>",
  "criteria": [
    {
      "name": "<criterion name>",
      "score": <number 1-10>,
      "status": "good" | "warning" | "fail",
      "feedback": "<specific actionable feedback, reference exact parts of the article>"
    }
  ]
}`;
}

const runAudit = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findOne({
      workspaceId: workspace._id,
      contentNumber: Number(req.params.contentNumber),
    });
    if (!content) return res.status(404).json({ error: 'Content not found' });

    const contentHash = computeContentHash(content.blocks);

    // Cache check: if latest audit has same hash and not forced, return cached
    const latestAudit = content.audits?.[content.audits.length - 1];
    if (latestAudit && latestAudit.contentHash === contentHash && !req.body.force) {
      return res.json({ audit: latestAudit, cached: true });
    }

    // Build prompt
    const markdown = blocksToText(content.blocks);
    const keyword = content.targetKeywords?.[0] || req.body.keyword || '';
    const blocksText = (content.blocks || []).map((b) => stripTags(b.text)).join(' ');
    const wordCount = blocksText.trim().split(/\s+/).filter(Boolean).length;
    const auditPrompt = buildAuditPrompt(markdown, keyword, wordCount);

    // Call OpenRouter (Kimi K2)
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenRouter API key not configured' });

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k2-0905',
        temperature: 0,
        messages: [{ role: 'user', content: auditPrompt }],
      }),
    });

    if (!orRes.ok) {
      const err = await orRes.json().catch(() => ({}));
      const msg = err.error?.message || `OpenRouter returned ${orRes.status}`;
      console.error('runAudit OpenRouter error:', msg);
      return res.status(502).json({ error: 'AI audit failed: ' + msg });
    }

    const orData = await orRes.json();
    const raw = orData.choices?.[0]?.message?.content || '';

    // Parse JSON (strip markdown fences if present)
    let parsed;
    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('runAudit JSON parse error:', e.message, 'Raw:', raw.slice(0, 500));
      return res.status(502).json({ error: 'AI returned invalid response. Please try again.' });
    }

    // Validate and sanitize
    if (!parsed.criteria || !Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
      return res.status(502).json({ error: 'AI returned incomplete audit. Please try again.' });
    }

    const auditResult = {
      overallScore: Math.min(100, Math.max(0, Math.round(parsed.overallScore || 0))),
      summary: parsed.summary || '',
      criteria: parsed.criteria.map((c) => ({
        name: c.name || 'Unknown',
        score: Math.min(10, Math.max(1, Math.round(c.score || 1))),
        status: ['good', 'warning', 'fail'].includes(c.status) ? c.status : (c.score >= 7 ? 'good' : c.score >= 4 ? 'warning' : 'fail'),
        feedback: c.feedback || 'No feedback provided.',
      })),
      contentHash,
      createdAt: Date.now(),
      model: 'moonshotai/kimi-k2-0905',
    };

    // Save to database (append, keep max 10)
    await Content.findOneAndUpdate(
      { _id: content._id },
      { $push: { audits: { $each: [auditResult], $slice: -10 } } }
    );

    res.json({ audit: auditResult, cached: false });
  } catch (err) {
    console.error('runAudit error:', err.message);
    res.status(500).json({ error: 'Audit failed: ' + err.message });
  }
};

// ─── WRITING QUALITY AUDIT (via OpenRouter / Kimi K2) ─────────

function buildWritingQualityPrompt(markdown, wordCount) {
  return `You are an expert writing coach and editor specializing in digital content quality.

Evaluate the following article on 3 writing quality dimensions. For each, provide:
- A score from 1-10
- A status: "good" (7-10), "warning" (4-6), or "fail" (1-3)
- Specific, actionable feedback (2-3 sentences max). Reference exact sentences or paragraphs from the article. Do NOT give generic advice.

Word count: ${wordCount}

THE 3 CRITERIA (evaluate in this order):

1. READABILITY
   - Are sentences clear and easy to follow?
   - Is paragraph length appropriate (not walls of text)?
   - Is the vocabulary level right for the audience?
   - Flag overly complex sentences, passive voice overuse, and run-on sentences.

2. GRAMMAR & MECHANICS
   - Are there spelling, punctuation, or grammar errors?
   - Is verb tense consistent throughout?
   - Are there subject-verb agreement issues?
   - Quote the exact problematic sentences and show the correction.

3. HUMAN WRITING QUALITY
   - Does this sound like it was written by a knowledgeable human?
   - Are there signs of AI-generated text (repetitive structure, hedging, list-heavy, generic transitions like "In today's world")?
   - Is the voice authentic and confident?
   - Flag specific passages that sound robotic or formulaic.

ARTICLE TO EVALUATE:
---
${markdown}
---

Return ONLY valid JSON (no markdown fences, no extra text) in this exact format:
{
  "overallScore": <number 1-100>,
  "summary": "<1-2 sentence overall assessment of writing quality>",
  "criteria": [
    {
      "name": "<criterion name>",
      "score": <number 1-10>,
      "status": "good" | "warning" | "fail",
      "feedback": "<specific actionable feedback, reference exact parts of the article>"
    }
  ]
}`;
}

const runWritingQualityAudit = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findOne({
      workspaceId: workspace._id,
      contentNumber: Number(req.params.contentNumber),
    });
    if (!content) return res.status(404).json({ error: 'Content not found' });

    const contentHash = computeContentHash(content.blocks);

    // Cache check
    const latest = content.writingQualityAudits?.[content.writingQualityAudits.length - 1];
    if (latest && latest.contentHash === contentHash && !req.body.force) {
      return res.json({ audit: latest, cached: true });
    }

    const markdown = blocksToText(content.blocks);
    const blocksText = (content.blocks || []).map((b) => stripTags(b.text)).join(' ');
    const wordCount = blocksText.trim().split(/\s+/).filter(Boolean).length;
    const prompt = buildWritingQualityPrompt(markdown, wordCount);

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenRouter API key not configured' });

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k2-0905',
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!orRes.ok) {
      const err = await orRes.json().catch(() => ({}));
      const msg = err.error?.message || `OpenRouter returned ${orRes.status}`;
      console.error('runWritingQualityAudit OpenRouter error:', msg);
      return res.status(502).json({ error: 'AI writing quality check failed: ' + msg });
    }

    const orData = await orRes.json();
    const raw = orData.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('runWritingQualityAudit JSON parse error:', e.message, 'Raw:', raw.slice(0, 500));
      return res.status(502).json({ error: 'AI returned invalid response. Please try again.' });
    }

    if (!parsed.criteria || !Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
      return res.status(502).json({ error: 'AI returned incomplete result. Please try again.' });
    }

    const auditResult = {
      overallScore: Math.min(100, Math.max(0, Math.round(parsed.overallScore || 0))),
      summary: parsed.summary || '',
      criteria: parsed.criteria.map((c) => ({
        name: c.name || 'Unknown',
        score: Math.min(10, Math.max(1, Math.round(c.score || 1))),
        status: ['good', 'warning', 'fail'].includes(c.status) ? c.status : (c.score >= 7 ? 'good' : c.score >= 4 ? 'warning' : 'fail'),
        feedback: c.feedback || 'No feedback provided.',
      })),
      contentHash,
      createdAt: Date.now(),
      model: 'moonshotai/kimi-k2-0905',
    };

    await Content.findOneAndUpdate(
      { _id: content._id },
      { $push: { writingQualityAudits: { $each: [auditResult], $slice: -10 } } }
    );

    res.json({ audit: auditResult, cached: false });
  } catch (err) {
    console.error('runWritingQualityAudit error:', err.message);
    res.status(500).json({ error: 'Writing quality check failed: ' + err.message });
  }
};

module.exports = { listContents, getContent, createContent, updateContent, deleteContent, addComment, updateComment, deleteComment, runAudit, runWritingQualityAudit };
