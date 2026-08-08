const mongoose = require('mongoose');
const Content = require('../models/Content');
// startAnalysis, not runAnalysis: both call sites below are fire-and-forget, and
// the wrapper guarantees the promise can never reject and kill the process.
const { startAnalysis } = require('./analysisController');
const imageStorage = require('../services/imageStorage');
const auditService = require('../services/auditService');
const creditService = require('../services/creditService');
const tierService = require('../services/tierService');
const { pruneVersions } = require('../services/versionRetention');
const costLedger = require('../services/costLedgerService');
const { isSupportedLanguage, isSelectableLanguage } = require('../config/locales');

// Workspace is resolved by the permissions middleware (resolveWorkspaceWithRole)
// and available as req.workspace.

// ─── LIST CONTENTS (summaries) ─────────────────────────────────

const listContents = async (req, res) => {
  try {
    const workspace = req.workspace;

    const { status, folder } = req.query;
    // favoritedBy is per-user state — collapse it to a boolean for the caller
    // and never ship the raw member list. .lean() is safe: the schema has no
    // virtuals and no toJSON transform, so the wire shape is unchanged.
    const docs = await Content.findSummariesByWorkspace(workspace._id, { status, folder }).lean();
    const me = String(req.user.userId);
    const contents = docs.map(({ favoritedBy, ...rest }) => ({
      ...rest,
      favorite: Array.isArray(favoritedBy) && favoritedBy.some((id) => String(id) === me),
    }));
    res.json({ contents });
  } catch (err) {
    console.error('listContents error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contents' });
  }
};

// ─── GET SINGLE CONTENT (by contentNumber) ─────────────────────

const getContent = async (req, res) => {
  try {
    const workspace = req.workspace;

    const content = await Content.findByNumber(workspace._id, req.params.contentNumber);
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    // Block access to locked content (e.g. paid-created content on free tier)
    if (content.locked) {
      return res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });
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

    // Strip per-user favorite state — the editor doesn't use it and it would
    // otherwise expose which members starred this doc.
    const { favoritedBy, ...rest } = content.toObject();
    res.json({ content: rest });
  } catch (err) {
    console.error('getContent error:', err.message);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
};

// ─── CREATE CONTENT ────────────────────────────────────────────

const createContent = async (req, res) => {
  try {
    const workspace = req.workspace;

    const contentNumber = await Content.getNextContentNumber();
    const { title, slug, description, blocks, targetKeywords, targetPageUrl, strikingSnapshot, country, device, language, score, wordCount, status, folder, platform, versions, deferAnalysis } = req.body;

    // Validate the content language before persisting (W3). A falsy value
    // (absent/empty/null) defaults to English in the model. A tier-3 language is
    // a real supported language but not usable until Phase C, so it is rejected
    // here as well as hidden in the UI — the two gates must agree.
    if (language) {
      if (!isSupportedLanguage(language)) {
        return res.status(422).json({ error: `Unsupported language: ${language}` });
      }
      if (!isSelectableLanguage(language)) {
        return res.status(422).json({ error: `Language not yet available: ${language}` });
      }
    }

    // Determine plan tier at creation time.
    // Paid users can opt to use a free lifetime slot (quotaSource='free').
    const orgId = workspace.organizationId;
    let createdOnPlan = 'free';
    if (orgId) {
      if (req.body.quotaSource === 'free') {
        createdOnPlan = 'free';
      } else {
        const { tier } = await tierService.getOrgTierConfig(orgId);
        createdOnPlan = tier === 'free' ? 'free' : 'paid';
      }
    }

    // Phase 11: enforce the tier's version-retention window on save (org-scoped
    // only — personal workspaces keep the count-cap-only behaviour).
    let retainedVersions = versions || [];
    if (orgId && Array.isArray(retainedVersions) && retainedVersions.length > 1) {
      const { config } = await tierService.getOrgTierConfig(orgId);
      retainedVersions = pruneVersions(retainedVersions, config?.contentVersionHistoryDays);
    }

    const content = await Content.create({
      userId: req.user.userId,
      workspaceId: workspace._id,
      contentNumber,
      title,
      slug,
      description,
      blocks: blocks || [],
      targetKeywords: targetKeywords || [],
      targetPageUrl: targetPageUrl || '',
      strikingSnapshot: (strikingSnapshot && strikingSnapshot.positionAtStart != null)
        ? { positionAtStart: strikingSnapshot.positionAtStart, siteId: strikingSnapshot.siteId || null, dateRange: strikingSnapshot.dateRange || '', snapshotAt: new Date() }
        : undefined,
      country,
      device,
      ...(language ? { language } : {}),
      score,
      wordCount,
      status,
      folder,
      platform,
      versions: retainedVersions,
      createdOnPlan,
    });

    // Auto-trigger analysis if keywords are provided — unless the caller defers
    // it. The article wizard defers so its Content Type step can persist the
    // declared page type BEFORE analysis starts (runAnalysis reads
    // content.contentType when calling the engine); it then starts analysis via
    // the updateContent startAnalysis directive, which mirrors this trigger's
    // billing exactly. Every other creation path keeps the auto-trigger.
    if (!deferAnalysis && content.targetKeywords && content.targetKeywords.length > 0) {
      await Content.findByIdAndUpdate(content._id, { $set: { analysisStatus: 'pending' } });
      // firstRun: this analysis was started FOR the user, not BY them, so they
      // may well have navigated away — it is the one analysis that also emails.
      // Every other entry point is a button they just pressed.
      startAnalysis(content._id, { firstRun: true });
    }

    // Track article creation against tier quota
    if (req.tierQuota) {
      await tierService.incrementQuota(req.tierQuota);
    }

    auditService.fromReq(req, {
      action: 'content.create',
      resource: 'content',
      resourceId: content.contentNumber,
      meta: { title: content.title || '(untitled)' },
    });
    // No favoritedBy strip here (unlike getContent/updateContent): nobody can
    // have starred a document that did not exist a moment ago, so the field is
    // always [] and carries no information about any member.
    res.status(201).json({ content });
  } catch (err) {
    console.error('createContent error:', err.message);
    res.status(500).json({ error: 'Failed to create content' });
  }
};

// ─── UPDATE CONTENT ────────────────────────────────────────────

const updateContent = async (req, res) => {
  try {
    const workspace = req.workspace;

    const allowedFields = [
      'title', 'slug', 'description', 'blocks', 'targetKeywords',
      'country', 'device', 'score', 'wordCount', 'status', 'folder', 'platform',
      'versions', 'publishedAt', 'scheduledAt', 'publishedUrl',
      'contentType', 'contentContext', 'targetWordCount',
      'styleReferenceContentNumber',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Phase 11: enforce the tier's version-retention window on save (org-scoped
    // only). The client sends the whole versions array each save, so re-trimming
    // here makes the advertised 7/30/90/365-day window real without a cron.
    if (
      workspace.organizationId &&
      Array.isArray(updates.versions) &&
      updates.versions.length > 1
    ) {
      const { config } = await tierService.getOrgTierConfig(workspace.organizationId);
      updates.versions = pruneVersions(updates.versions, config?.contentVersionHistoryDays);
    }

    // Copy any base64 / engine-hosted images to B2 before saving.
    if (imageStorage.isEnabled()) {
      // One cache per request, keyed by the ORIGINAL src. The same image
      // usually appears in the live blocks AND in several version snapshots;
      // without this each occurrence would be fetched and uploaded again under
      // a fresh timestamped key, so one save could store the same bytes a dozen
      // times. A failure is cached too (as null) so a dead engine URL is
      // attempted once per save, not once per block that references it.
      const rehosted = new Map();

      // Ceiling on DISTINCT fetches per save. `blocks` has no length limit and
      // versions multiply it, so a crafted save could name hundreds of unique
      // engine URLs and we would fetch them one after another, each with a 15s
      // timeout — an authenticated way to tie up a request handler for hours.
      // Well above any real article (the cache below collapses repeats, which
      // is what a genuine document is made of), and the excess keeps its
      // existing src rather than failing the save.
      const MAX_REHOSTS_PER_SAVE = 60;
      let rehostBudgetLogged = false;

      const rehostOne = async (block) => {
        if (!block || block.type !== 'img' || !block.src || typeof block.src !== 'string') return;
        const original = block.src;
        if (rehosted.has(original)) {
          const cached = rehosted.get(original);
          if (cached) block.src = cached;
          return;
        }
        if (rehosted.size >= MAX_REHOSTS_PER_SAVE) {
          if (!rehostBudgetLogged) {
            rehostBudgetLogged = true;
            console.warn(`[images] save for content ${req.params.contentNumber} named more than `
              + `${MAX_REHOSTS_PER_SAVE} distinct images; the rest keep their original src`);
          }
          return;
        }
        try {
          let next = null;
          if (original.startsWith('data:image/')) {
            next = await imageStorage.uploadFromDataUri(
              original, workspace._id.toString(), req.params.contentNumber,
            );
          } else if (imageStorage.looksLikeEngineImageUrl(original)) {
            // NOT `src.includes('/api/images/img_')`. That was a substring test
            // on a client-supplied string, so any URL carrying those characters
            // anywhere — `http://169.254.169.254/latest/meta-data/?/api/images/img_`
            // — was fetched server-side and its body stored in B2 under a URL
            // the caller could then read. looksLikeEngineImageUrl compares the
            // parsed origin against the engine allowlist, and uploadFromUrl
            // re-asserts it authoritatively before fetching.
            next = await imageStorage.uploadFromUrl(
              original, workspace._id.toString(), req.params.contentNumber,
            );
          }
          rehosted.set(original, next);
          if (next) block.src = next;
        } catch (err) {
          rehosted.set(original, null);
          // A rejected URL is left in place, not saved as an image we fetched:
          // the block keeps pointing at whatever it named and no bytes of ours
          // are involved. Logged apart from transport failures so a refused
          // origin is greppable rather than looking like a flaky network.
          const why = err instanceof imageStorage.UrlValidationError ? 'refused' : 'failed';
          console.error(`B2 upload ${why} for block ${block.id} (non-fatal):`, err.message);
        }
      };

      if (Array.isArray(updates.blocks)) {
        for (const block of updates.blocks) await rehostOne(block);
      }
      // Version snapshots hold their own copies of the blocks. They were never
      // walked, so a snapshot taken while an image was still on the engine's
      // temporary URL kept that URL forever — restoring that version showed a
      // dead image once the engine expired it. Bounded by the schema (≤10
      // snapshots) and by the cache above, which collapses the common case
      // where every snapshot references images the live blocks already hold.
      if (Array.isArray(updates.versions)) {
        for (const version of updates.versions) {
          if (!Array.isArray(version?.blocks)) continue;
          for (const block of version.blocks) await rehostOne(block);
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

    // startAnalysis directive (wizard Content Type step): kick off the deferred
    // first analysis now that the declared page type is saved. Deliberately
    // mirrors createContent's auto-trigger — same fire-and-forget, same billing
    // (NOT the audited POST /analyze route, so the first analysis stays free
    // exactly as it was when creation auto-triggered it). Guarded to the
    // never-analyzed state so it cannot restart or double-run an analysis; the
    // directive itself is not in allowedFields, so nothing persists.
    if (req.body.startAnalysis === true &&
        content.analysisStatus === 'idle' &&
        content.targetKeywords && content.targetKeywords.length > 0) {
      // Atomic claim: only one concurrent request can flip idle → pending.
      // The status check above is a stale read — a double-clicked Continue or
      // a second wizard tab could both pass it and start two engine runs.
      // Losing claimants match no document and do nothing.
      const claimed = await Content.findOneAndUpdate(
        { _id: content._id, analysisStatus: 'idle' },
        { $set: { analysisStatus: 'pending' } },
      );
      // firstRun for the same reason as the creation auto-trigger above: this
      // IS that analysis, just deferred by the wizard. The idle→pending claim
      // is atomic and the auto-trigger only fires when it did NOT defer, so
      // exactly one of the two paths ever runs per piece — no double email.
      if (claimed) startAnalysis(content._id, { firstRun: true });
    }

    // Autosave fires every ~1.5s while typing — dedupe to one entry per
    // 30 minutes per user per document. Meaningful changes bypass the
    // window: status/publish transitions always write, and a rename
    // writes because the dedupe compares meta (title) content.
    const significant =
      updates.status !== undefined ||
      updates.publishedAt !== undefined ||
      updates.scheduledAt !== undefined;
    auditService.fromReq(req, {
      action: 'content.update',
      resourceId: content.contentNumber,
      meta: {
        title: content.title || '(untitled)',
        ...(updates.status !== undefined && { status: updates.status }),
        ...(updates.publishedAt !== undefined && { published: true }),
      },
      dedupeMinutes: significant ? 0 : 30,
    });
    // Same strip as getContent — per-user favorite state never leaves the API.
    const { favoritedBy, ...rest } = content.toObject();
    res.json({ content: rest });
  } catch (err) {
    console.error('updateContent error:', err.message);
    res.status(500).json({ error: 'Failed to update content' });
  }
};

// ─── DELETE CONTENT ────────────────────────────────────────────

const deleteContent = async (req, res) => {
  try {
    const workspace = req.workspace;

    const content = await Content.findOneAndDelete({
      workspaceId: workspace._id,
      contentNumber: Number(req.params.contentNumber),
    });
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    auditService.fromReq(req, {
      action: 'content.delete',
      resource: 'content',
      resourceId: content.contentNumber,
      meta: { title: content.title || '(untitled)' },
    });
    res.json({ message: 'Content deleted' });
  } catch (err) {
    console.error('deleteContent error:', err.message);
    res.status(500).json({ error: 'Failed to delete content' });
  }
};

// ─── SET FAVORITE (per-user star) ─────────────────────────────

const setFavorite = async (req, res) => {
  try {
    const workspace = req.workspace;
    const favorite = req.body.favorite === true;

    // timestamps: false is load-bearing. The schema has { timestamps: true }
    // and the list is sorted updatedAt: -1 with "last edited" rendered from it,
    // so without this a star would jump the row to the top of the list and
    // falsely report it as just edited.
    // $addToSet/$pull are atomic, so concurrent toggles can't lose an update.
    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber) },
      favorite
        ? { $addToSet: { favoritedBy: req.user.userId } }
        : { $pull: { favoritedBy: req.user.userId } },
      { new: true, timestamps: false, projection: { _id: 1 } }
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    // No audit entry: this is a personal UI preference, not a content mutation.
    res.json({ favorite });
  } catch (err) {
    console.error('setFavorite error:', err.message);
    res.status(500).json({ error: 'Failed to update favorite' });
  }
};

// ─── ADD COMMENT ──────────────────────────────────────────────

const User = require('../models/User');

const addComment = async (req, res) => {
  try {
    const workspace = req.workspace;

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
    const workspace = req.workspace;

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
    const workspace = req.workspace;

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

Audit the following article against 8 editorial criteria. For each criterion, provide:
- A score from 1-10
- A status: "good" (7-10), "warning" (4-6), or "fail" (1-3)
- Specific, actionable feedback (2-3 sentences max). Reference exact sections, headings, or paragraphs from the article. Do NOT give generic advice.

Target keyword: ${keyword || '(not specified)'}
Word count: ${wordCount}

THE 8 CRITERIA (evaluate in this order):

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

8. RISK & ACCURACY
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

/**
 * Shared streaming audit helper. Streams from OpenRouter, detects complete
 * criterion JSON objects, emits SSE events per criterion, then a final
 * "complete" event with the full sanitized result.
 */
function sanitizeCriterion(c) {
  return {
    name: c.name || 'Unknown',
    score: Math.min(10, Math.max(1, Math.round(c.score || 1))),
    status: ['good', 'warning', 'fail'].includes(c.status) ? c.status : (c.score >= 7 ? 'good' : c.score >= 4 ? 'warning' : 'fail'),
    feedback: c.feedback || 'No feedback provided.',
  };
}

/**
 * Extract complete criterion objects from a partial JSON buffer.
 * Looks for the "criteria" array and counts complete {...} objects by tracking brace depth.
 */
function extractCriteria(buffer) {
  // Search for "criteria": (with colon) to avoid matching the word inside string values
  const keyPattern = '"criteria"';
  let arrStart = -1;
  let searchFrom = 0;
  while (searchFrom < buffer.length) {
    const idx = buffer.indexOf(keyPattern, searchFrom);
    if (idx === -1) break;
    // Check if followed by optional whitespace then colon
    const afterKey = buffer.slice(idx + keyPattern.length).trimStart();
    if (afterKey.startsWith(':')) { arrStart = idx; break; }
    searchFrom = idx + 1;
  }
  if (arrStart === -1) return [];
  const bracketStart = buffer.indexOf('[', arrStart);
  if (bracketStart === -1) return [];

  const criteria = [];
  let depth = 0;
  let objStart = -1;

  for (let i = bracketStart + 1; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === '"') {
      // Skip string content
      i++;
      while (i < buffer.length && buffer[i] !== '"') {
        if (buffer[i] === '\\') i++; // skip escaped char
        i++;
      }
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = buffer.slice(objStart, i + 1);
        try {
          criteria.push(JSON.parse(objStr));
        } catch { /* incomplete or malformed, skip */ }
        objStart = -1;
      }
    }
  }
  return criteria;
}

async function streamAudit(req, res, { prompt, contentHash, contentId, dbField, errorPrefix, tierQuota }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OpenRouter API key not configured' });

  // Set up SSE
  const abortCtrl = new AbortController();
  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; abortCtrl.abort(); });

  // Start streaming request to OpenRouter
  let orRes;
  try {
    orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k2-0905',
        temperature: 0,
        stream: true,
        // include_usage → OpenRouter emits a final chunk carrying token counts
        // (empty choices), which we tap for the AI cost ledger below.
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: abortCtrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    return res.status(502).json({ error: errorPrefix + ': ' + e.message });
  }

  if (!orRes.ok || !orRes.body) {
    const err = await orRes.json().catch(() => ({}));
    const msg = err.error?.message || `OpenRouter returned ${orRes.status}`;
    return res.status(502).json({ error: errorPrefix + ': ' + msg });
  }

  // Start SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const reader = orRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let fullContent = '';
  let emittedCount = 0;
  let usage = null; // OpenRouter final-chunk token counts (include_usage)

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          // Final usage chunk (choices empty). Capture for the cost ledger.
          if (event.usage) usage = event.usage;
          const delta = event.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullContent += delta;

            // Check for newly completed criteria
            const criteria = extractCriteria(fullContent);
            while (emittedCount < criteria.length) {
              const c = sanitizeCriterion(criteria[emittedCount]);
              if (!clientDisconnected) {
                res.write(`data: ${JSON.stringify({ type: 'criterion', index: emittedCount, criterion: c })}\n\n`);
              }
              emittedCount++;
            }
          }
        } catch { /* skip unparseable SSE line */ }
      }
    }
  } catch (e) {
    if (clientDisconnected || abortCtrl.signal.aborted) {
      console.log(`[${dbField}-sse] stream aborted by client disconnect`);
      return;
    }
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
      res.end();
    }
    return;
  }

  // AI cost ledger (Phase 1): record this audit's real COGS. Placed BEFORE the
  // parse so a billed-but-unparseable response still lands in the ledger (the
  // tokens were spent either way). Detached — never delays the SSE response.
  void (async () => {
    try {
      const orgId = req.creditContext?.orgId || tierQuota?.orgId || null;
      let tier = '';
      if (orgId) tier = (await tierService.getOrgTierConfig(orgId))?.tier || '';
      costLedger.record({
        action: 'audit',
        model: 'moonshotai/kimi-k2-0905',
        tokensIn: usage?.prompt_tokens || 0,
        tokensOut: usage?.completion_tokens || 0,
        organizationId: orgId,
        workspaceId: req.workspace?._id || null,
        userId: req.user?.userId || null,
        tier,
        metadata: { contentId: contentId?.toString(), dbField },
      });
    } catch (e) {
      console.warn('[costLedger] audit skipped:', e.message);
    }
  })();

  // Parse final result
  const cleaned = fullContent.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error(`[${dbField}] final JSON parse error:`, e.message);
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI returned invalid response.' })}\n\n`);
      res.end();
    }
    return;
  }

  const auditResult = {
    overallScore: Math.min(100, Math.max(0, Math.round(parsed.overallScore || 0))),
    summary: parsed.summary || '',
    criteria: (parsed.criteria || []).map(sanitizeCriterion),
    contentHash,
    createdAt: Date.now(),
    model: 'moonshotai/kimi-k2-0905',
  };

  // Save to database
  try {
    await Content.findOneAndUpdate(
      { _id: contentId },
      { $push: { [dbField]: { $each: [auditResult], $slice: -10 } } }
    );

    // Track quota only after successful audit completion + DB save
    if (tierQuota) {
      await tierService.incrementQuota(tierQuota);
    }
  } catch (e) {
    console.error(`[${dbField}] DB save error:`, e.message);
  }

  // Deduct the flat audit cost. Phase 6: audits bill the Table-2 fixed price
  // (5 credits; Free fixed-bundle = 0, count-gated) — NOT the old word-based
  // cost. The gate already resolved the amount into creditContext.estimatedCredits
  // (via resolveCredits('contentAudit', {tier})). deductForRequest finalizes the
  // charge (preDeduct + settle) so the 30-min orphan-sweep can't refund it — a
  // bare preDeduct left the tx 'pending' and the sweep silently made audits free.
  await creditService.deductForRequest(req, { metadata: { contentId: contentId?.toString() } });

  // Emit final complete event
  if (!clientDisconnected) {
    res.write(`data: ${JSON.stringify({ type: 'complete', audit: auditResult })}\n\n`);
    res.end();
  }
}

const runAudit = async (req, res) => {
  try {
    const workspace = req.workspace;

    const content = await Content.findOne({
      workspaceId: workspace._id,
      contentNumber: Number(req.params.contentNumber),
    });
    if (!content) return res.status(404).json({ error: 'Content not found' });
    // B4: same lock gate as getContent — a locked doc must not be audited
    // (leaks its data to the LLM and burns credits).
    if (content.locked) return res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });

    const contentHash = computeContentHash(content.blocks);

    // Cache check: return regular JSON (no streaming needed)
    const latestAudit = content.audits?.[content.audits.length - 1];
    if (latestAudit && latestAudit.contentHash === contentHash && !req.body.force) {
      return res.json({ audit: latestAudit, cached: true });
    }

    const markdown = blocksToText(content.blocks);
    const keyword = content.targetKeywords?.[0] || req.body.keyword || '';
    const blocksText = (content.blocks || []).map((b) => stripTags(b.text)).join(' ');
    const wordCount = blocksText.trim().split(/\s+/).filter(Boolean).length;

    await streamAudit(req, res, {
      prompt: buildAuditPrompt(markdown, keyword, wordCount),
      contentHash,
      contentId: content._id,
      dbField: 'audits',
      errorPrefix: 'AI audit failed',
      tierQuota: req.tierQuota || null,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('runAudit error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Audit failed: ' + err.message });
    }
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
    const workspace = req.workspace;

    const content = await Content.findOne({
      workspaceId: workspace._id,
      contentNumber: Number(req.params.contentNumber),
    });
    if (!content) return res.status(404).json({ error: 'Content not found' });
    // B4: same lock gate as getContent — no writing-quality audit on locked
    // content (leaks its data to the LLM and burns credits).
    if (content.locked) return res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });

    const contentHash = computeContentHash(content.blocks);

    // Cache check: return regular JSON
    const latest = content.writingQualityAudits?.[content.writingQualityAudits.length - 1];
    if (latest && latest.contentHash === contentHash && !req.body.force) {
      return res.json({ audit: latest, cached: true });
    }

    const markdown = blocksToText(content.blocks);
    const blocksText = (content.blocks || []).map((b) => stripTags(b.text)).join(' ');
    const wordCount = blocksText.trim().split(/\s+/).filter(Boolean).length;

    await streamAudit(req, res, {
      prompt: buildWritingQualityPrompt(markdown, wordCount),
      contentHash,
      contentId: content._id,
      dbField: 'writingQualityAudits',
      errorPrefix: 'AI writing quality check failed',
      tierQuota: req.tierQuota || null,
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('runWritingQualityAudit error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Writing quality check failed: ' + err.message });
    }
  }
};


/**
 * GET available internal links for a content — the same inventory the
 * backend pushes to the writing engine as brief.availableLinks (single
 * source of truth: buildAvailableLinks). The editor uses it for the
 * client-side Internal Links scoring signal + hallucinated-link warnings.
 * Empty array when the workspace has no completed sitemap crawl.
 */
const getAvailableLinks = async (req, res) => {
  try {
    const workspace = req.workspace;
    const content = await Content.findByNumber(workspace._id, req.params.contentNumber);
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    // Same lock gate as getContent — locked content must not leak its data.
    if (content.locked) {
      return res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });
    }

    const { benchmarkToContentBrief, buildAvailableLinks, buildAllowlistUrls } = require('../services/benchmarkToContentBrief');
    const brief = benchmarkToContentBrief(content);
    const workspaceId = content.workspaceId || workspace._id;
    const links = await buildAvailableLinks(
      workspaceId,
      brief.targetKeyword,
      brief.secondaryKeywords,
    );
    // R3: the editor's Internal Links ring classifies against the full crawled
    // set (top-30 `links` is only for display/suggestions), matching the engine.
    const allowlistUrls = await buildAllowlistUrls(workspaceId);
    res.json({ links, allowlistUrls });
  } catch (err) {
    console.error('getAvailableLinks error:', err.message);
    res.status(500).json({ error: 'Failed to load available links' });
  }
};

// ─── GET /:contentNumber/movement — striking-distance outcome ───
// For content started from a GSC striking-distance opportunity, re-pulls the
// keyword's current position (same window) and reports the delta vs. start.
const getMovement = async (req, res) => {
  try {
    const content = await Content.findByNumber(req.workspace._id, req.params.contentNumber);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    // Consistent with getContent/getAvailableLinks — locked content leaks nothing.
    if (content.locked) return res.status(403).json({ error: 'This content is locked.', locked: true });

    const snap = content.strikingSnapshot;
    // Guard against a missing/malformed siteId so a bad ref can't throw a
    // CastError (500) — just report movement as unavailable.
    if (!snap || snap.positionAtStart == null || !snap.siteId || !mongoose.Types.ObjectId.isValid(snap.siteId)) {
      return res.json({ available: false });
    }
    const keyword = (content.targetKeywords || [])[0];
    if (!keyword) return res.json({ available: false });

    const Site = require('../models/Site');
    const site = await Site.findOne({ _id: snap.siteId, workspaceId: req.workspace._id });
    if (!site || site.locked) return res.json({ available: false });

    const gscService = require('../services/gscService');
    // Default to the short-lived cache — a 28-day average barely moves between
    // opens, so an uncached GSC call on every editor open would waste quota.
    // ?fresh=1 forces a live re-pull for an explicit refresh.
    const fresh = req.query.fresh === '1';
    let currentPosition = null;
    try {
      currentPosition = await gscService.getKeywordPosition(
        req.workspace.organizationId, site.gscPropertyId, keyword, snap.dateRange || '28d',
        { fresh, page: content.targetPageUrl || '' },
      );
    } catch (e) {
      if (e.code === 'GSC_NOT_CONNECTED') return res.json({ available: false, reason: 'gsc_disconnected' });
      throw e;
    }

    res.json({
      available: true,
      keyword,
      positionAtStart: snap.positionAtStart,
      currentPosition,
      // Positive delta = improved (lower position is better).
      delta: currentPosition != null ? +(snap.positionAtStart - currentPosition).toFixed(1) : null,
      snapshotAt: snap.snapshotAt,
    });
  } catch (err) {
    console.error('getMovement error:', err.message);
    res.status(500).json({ error: 'Failed to compute movement' });
  }
};

module.exports = { listContents, getContent, getAvailableLinks, getMovement, createContent, updateContent, deleteContent, setFavorite, addComment, updateComment, deleteComment, runAudit, runWritingQualityAudit,
  // Exported for test coverage (cost-ledger usage capture). Not part of the runtime API surface.
  streamAudit };
