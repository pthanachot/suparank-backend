const AiTracker = require('../models/AiTracker');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const AiTrackerCompetitor = require('../models/AiTrackerCompetitor');
const AiTrackerScan = require('../models/AiTrackerScan');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const { runScan, PLATFORMS, normalizeBrandKey, isSameBrand, getAvailablePlatformIdsSilent, urlMatchesDomain, extractBrand } = require('../services/aiTrackerScanEngine');
const UsageTracker = require('../models/UsageTracker');
const UserUsageTracker = require('../models/UserUsageTracker');
const tierService = require('../services/tierService');
const creditService = require('../services/creditService');
const { sendEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');

// ─── Dev time scale (accelerate frequencies for testing, 1 = real time) ───
// Set via POST /api/dev/set-time-scale { scale: 200 }
// Scale 200 → Daily≈7min, Weekly≈50min relative to scan duration
// Persisted to .dev-time-scale so it survives server restarts
const _fs = require('fs');
const _path = require('path');
const _scaleFile = _path.join(__dirname, '..', '.dev-time-scale');
let _devTimeScale = 1;
try { const saved = Number(_fs.readFileSync(_scaleFile, 'utf8')); if (saved > 1) { _devTimeScale = saved; console.log(`[dev] restored time scale: ${saved}x`); } } catch {}
const setDevTimeScale = (n) => {
  _devTimeScale = Math.max(1, Number(n) || 1);
  try { _fs.writeFileSync(_scaleFile, String(_devTimeScale)); } catch {}
};
const getDevTimeScale = () => _devTimeScale;

// ─── Platform display config (returned in platformStats) ──────────────────

const PLATFORM_DISPLAY = [
  {
    platformId: 'chatgpt', name: 'ChatGPT', letter: 'G',
    color: 'text-emerald-600', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200',
  },
  {
    platformId: 'gemini', name: 'Gemini', letter: 'G',
    color: 'text-blue-600', bgColor: 'bg-blue-50', borderColor: 'border-blue-200',
  },
  {
    platformId: 'claude', name: 'Claude', letter: 'C',
    color: 'text-amber-600', bgColor: 'bg-amber-50', borderColor: 'border-amber-200',
  },
  {
    platformId: 'perplexity', name: 'Perplexity', letter: 'P',
    color: 'text-cyan-600', bgColor: 'bg-cyan-50', borderColor: 'border-cyan-200',
  },
];

// Escape user-controlled strings for embedding in HTML attribute or content
// contexts in the scan-summary email. Prevents F4-23 — a malicious editor in
// a multi-member workspace inserting <style>/<script> via a prompt or monitor
// name. Used at every interpolation site that mixes user data into HTML.
function htmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Workspace resolved by permissions middleware (req.workspace).

// ─── Helper: validate ObjectId format ─────────────────────────────────────

const OBJECTID_RE = /^[0-9a-fA-F]{24}$/;
function isValidObjectId(id) { return typeof id === 'string' && OBJECTID_RE.test(id); }

// ─── Helper: resolve tracker from workspace (legacy single-monitor) ──────

async function resolveTracker(workspace, res) {
  const tracker = await AiTracker.findOne({ workspaceId: workspace._id });
  if (!tracker) {
    res.status(404).json({ error: 'AI Tracker not found' });
    return null;
  }
  return tracker;
}

// ─── Helper: resolve monitor by ID (multi-monitor) ──────────────────────

async function resolveMonitor(req, workspace, res) {
  const { monitorId } = req.params;
  if (!monitorId || !monitorId.match(/^[0-9a-fA-F]{24}$/)) {
    res.status(400).json({ error: 'Invalid monitor ID' });
    return null;
  }
  const tracker = await AiTracker.findOne({ _id: monitorId, workspaceId: workspace._id });
  if (!tracker) {
    res.status(404).json({ error: 'Monitor not found' });
    return null;
  }
  return tracker;
}

// ═══════════════════════════════════════════════════════════════════════════
// DERIVED DATA COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════

// Valid prompt frequency values
const VALID_FREQUENCIES = ['Daily', 'Weekly', 'Bi-weekly', 'Monthly'];

// Check if 'Daily' frequency is allowed for this workspace's tier
async function isDailyFrequencyAllowed(workspace) {
  if (!workspace.organizationId) return false;
  const { config } = await tierService.getOrgTierConfig(workspace.organizationId);
  return config?.aiTrackerRefreshInterval === 'daily';
}

// Weights for weighted visibility score
const W_MENTION = 0.4;
const W_POSITION = 0.3;
const W_CITATION = 0.3;

/**
 * Compute weighted visibility score from platform results.
 * Formula: mentionRate × W1 + positionScore × W2 + citationRate × W3
 * @param {Array} platforms - Array of platform result objects
 * @returns {number} Weighted visibility 0-100
 */
function computeWeightedVisibility(platforms) {
  if (!platforms || platforms.length === 0) return 0;
  // Exclude errored platforms — API failures should not count as "not mentioned"
  const valid = platforms.filter((p) => !p.error);
  if (valid.length === 0) return 0;
  const total = valid.length;
  const mentioned = valid.filter((p) => p.mentioned);
  const cited = valid.filter((p) => p.cited);

  const mentionRate = (mentioned.length / total) * 100;
  const citationRate = mentioned.length > 0 ? (cited.length / mentioned.length) * 100 : 0;

  // Position score: use position (1-10), fall back to brandRanking, then normalizedPosition
  let positionScore = 0;
  if (mentioned.length > 0) {
    const positionValues = mentioned.map((p) => {
      // New field: position (1-10 scale, 1=best)
      if (p.position != null) {
        return (10 - p.position) / 9 * 100; // position 1 → 100, position 10 → 0
      }
      // Backward compat: brandRanking
      if (p.brandRanking && p.brandRanking.length > 0) {
        const targetIdx = p.brandRanking.findIndex(b => b.isTargetBrand);
        if (targetIdx >= 0) {
          return p.brandRanking.length > 1
            ? (1 - targetIdx / (p.brandRanking.length - 1)) * 100
            : 100;
        }
      }
      // Backward compat: normalizedPosition
      return p.normalizedPosition != null ? (1 - p.normalizedPosition) * 100 : 50;
    });
    positionScore = positionValues.reduce((sum, v) => sum + v, 0) / mentioned.length;
  }

  return Math.round(mentionRate * W_MENTION + positionScore * W_POSITION + citationRate * W_CITATION);
}

function computeMetrics(latestScan, promptCount, carryScans, domain) {
  if (!latestScan) return null;

  // Build carry-forward results: latest known result per prompt across all carryScans
  let results;
  if (carryScans && carryScans.length > 0) {
    const effectiveMap = new Map();
    for (const scan of carryScans) {
      for (const r of (scan.results || [])) {
        const pid = r.promptId?.toString();
        if (pid && !effectiveMap.has(pid)) effectiveMap.set(pid, r);
      }
    }
    results = [...effectiveMap.values()];
  } else {
    results = latestScan.results || [];
  }
  // Count actual valid results (not errored) instead of using fixed platformCount
  let totalMentions = 0;
  let totalCitations = 0;
  let totalValid = 0;

  for (const r of results) {
    for (const p of (r.platforms || [])) {
      if (p.error) continue;
      totalValid++;
      if (p.mentioned) totalMentions++;
      if (p.cited) totalCitations++;
    }
  }

  const totalPossible = totalValid;

  const mentionRate = totalPossible > 0 ? Math.round((totalMentions / totalPossible) * 100) : 0;
  const citationRate = totalMentions > 0 ? Math.round((totalCitations / totalMentions) * 100) : 0;

  // Weighted visibility across all prompts
  const allPlatforms = results.flatMap((r) => r.platforms || []);
  const visibility = allPlatforms.length > 0 ? computeWeightedVisibility(allPlatforms) : 0;

  // Share of voice: own mentions vs total mentions across all competitors.
  //
  // F18-04 (documented residual): `totalMentions` reflects carry-forward
  // (slow-frequency prompts contribute their last-known result), but
  // `latestScan.competitorResults` is *only* from the latest scan. So the
  // numerator can span a longer window than the denominator. F6-01's
  // denom construction bounds the ratio in [0,1] mathematically, but the
  // semantic mismatch remains. A full fix requires aggregating competitor
  // data across carryScans — deferred (substantial refactor of the
  // competitor pipeline).
  //
  // F6-01: two pre-fix failure modes:
  //   1. ownCompResult missing (legacy scans pre-isOwn): denominator was just
  //      allCompMentions (no own contribution), so own/comp could exceed 1.
  //      Fix: when ownCompResult is absent, denom += ownMentions so the
  //      ratio is mathematically bounded in [0,1].
  //   2. Legacy entries lacking a `mentions` field would NaN-propagate
  //      through reduce. `cr.mentions || 0` neutralizes that.
  // Math: when ownCompResult exists, allCompMentions already includes own.
  // When absent, denom = allCompMentions + ownMentions. In both cases
  // ownMentions ≤ denom, so the ratio (and rounded percentage) is in [0,100]
  // without needing an explicit clamp.
  const competitorResults = latestScan.competitorResults || [];
  const ownCompResult = competitorResults.find((cr) => cr.isOwn);
  const ownMentions = ownCompResult ? (ownCompResult.mentions || 0) : totalMentions;
  const allCompMentions = competitorResults.reduce((sum, cr) => sum + (cr.mentions || 0), 0);
  const denom = ownCompResult ? allCompMentions : (allCompMentions + ownMentions);
  const shareOfVoice = denom > 0 ? Math.round((ownMentions / denom) * 100) : 0;

  // Average sentiment score across all mentioned platforms with sentiment data
  const sentimentScores = allPlatforms
    .filter((p) => p.sentimentScore != null && p.mentioned && !p.error)
    .map((p) => p.sentimentScore);
  const avgSentiment = sentimentScores.length > 0
    ? Math.round(sentimentScores.reduce((sum, s) => sum + s, 0) / sentimentScores.length)
    : null;

  // Average position: use position (1-10), fall back to brandRanking index, then normalizedPosition
  const positionRanks = [];
  for (const r of results) {
    for (const p of (r.platforms || [])) {
      if (p.error || !p.mentioned) continue;
      if (p.position != null) {
        positionRanks.push(p.position); // already 1-10 scale
      } else if (p.brandRanking && p.brandRanking.length > 0) {
        const targetIdx = p.brandRanking.findIndex(b => b.isTargetBrand);
        if (targetIdx >= 0) positionRanks.push(targetIdx + 1);
      } else if (p.normalizedPosition != null) {
        positionRanks.push(Math.round(p.normalizedPosition * 10) + 1);
      }
    }
  }
  const averagePosition = positionRanks.length > 0
    ? Math.round((positionRanks.reduce((s, v) => s + v, 0) / positionRanks.length) * 10) / 10
    : null;

  // Total citation count: count unique domain-matching URLs (consistent with "Cited In" metric).
  // F6-02: hostname-exact match via urlMatchesDomain (was substring `.includes()`,
  // which let "realsuparank.com" match "suparank.com" — same class as F2-16).
  let totalCitationCount = 0;
  for (const r of results) {
    for (const p of (r.platforms || [])) {
      if (p.error) continue;
      if (p.citedUrls && p.citedUrls.length > 0 && domain) {
        const matching = p.citedUrls.filter(u => urlMatchesDomain(u, domain));
        totalCitationCount += new Set(matching).size;
      }
    }
  }

  return { visibility, mentionRate, shareOfVoice, citationRate, promptCount, avgSentiment, averagePosition, totalCitationCount };
}

function generatePromptSuggestions(scanResult, prevResult) {
  if (!scanResult) {
    return [
      'Add a direct answer in the first paragraph',
      'Use clear H2/H3 structure matching query intent',
      'Include FAQ section with exact-match questions',
      'Strengthen E-E-A-T signals (author bio, date, citations)',
      'Add authoritative external citations and sources',
      'Keyword in title and first 100 words',
    ];
  }

  const suggestions = [];
  const valid = scanResult.platforms.filter((p) => !p.error);
  const mentioned = valid.filter((p) => p.mentioned);
  const cited = valid.filter((p) => p.cited);
  const notMentioned = valid.filter((p) => !p.mentioned);

  // Compute previous scan stats for comparison
  const prevValid = prevResult ? prevResult.platforms.filter((p) => !p.error) : [];
  const prevMentioned = prevValid.filter((p) => p.mentioned);
  const prevCited = prevValid.filter((p) => p.cited);

  // ── Mention-based suggestions ──
  if (mentioned.length === 0) {
    suggestions.push('Create comprehensive content targeting this exact query');
    suggestions.push('Add a direct answer in the first paragraph of your page');
    suggestions.push('Use clear H2/H3 headings that match the query intent');
  } else if (mentioned.length < valid.length) {
    const names = notMentioned.map((p) => {
      const display = PLATFORM_DISPLAY.find((d) => d.platformId === p.platformId);
      return display ? display.name : p.platformId;
    });
    suggestions.push(`Improve visibility on ${names.join(', ')} with platform-specific content`);
  }

  // ── Lost mention detection ──
  if (prevResult && prevMentioned.length > mentioned.length) {
    const lostPlatforms = prevMentioned
      .filter((pm) => !mentioned.some((m) => m.platformId === pm.platformId))
      .map((p) => {
        const display = PLATFORM_DISPLAY.find((d) => d.platformId === p.platformId);
        return display ? display.name : p.platformId;
      });
    if (lostPlatforms.length > 0) {
      suggestions.push(`Lost mentions on ${lostPlatforms.join(', ')} — refresh and expand your content`);
    }
  }

  // ── Citation suggestions ──
  if (mentioned.length > 0 && cited.length === 0) {
    suggestions.push('Add structured data (FAQ schema) to boost citation chances');
    suggestions.push('Include your domain URL naturally in authoritative content');
  } else if (cited.length > 0 && cited.length < mentioned.length) {
    const uncitedNames = mentioned
      .filter((m) => !m.cited)
      .map((p) => {
        const display = PLATFORM_DISPLAY.find((d) => d.platformId === p.platformId);
        return display ? display.name : p.platformId;
      });
    suggestions.push(`Not cited on ${uncitedNames.join(', ')} despite mention — add structured data and source links`);
  }

  // ── Citation gained/lost ──
  if (prevResult && cited.length > prevCited.length) {
    suggestions.push('Citations growing — keep content fresh and add more authoritative sources');
  } else if (prevResult && prevCited.length > 0 && cited.length < prevCited.length) {
    suggestions.push('Lost citations since last scan — update content with recent data and statistics');
  }

  // ── Sentiment-based suggestions ──
  const sentimentScores = valid
    .filter((p) => p.mentioned && p.sentimentScore != null)
    .map((p) => p.sentimentScore);
  if (sentimentScores.length > 0) {
    const avgSentiment = sentimentScores.reduce((s, v) => s + v, 0) / sentimentScores.length;
    if (avgSentiment < 40) {
      suggestions.push('Negative sentiment detected — address common complaints and highlight positive outcomes');
    } else if (avgSentiment < 60) {
      suggestions.push('Neutral sentiment — add case studies and testimonials to improve brand perception');
    }
  }

  // ── Position-based suggestions ──
  const positions = valid
    .filter((p) => p.mentioned && (p.position != null || p.normalizedPosition != null))
    .map((p) => p.position != null ? p.position : Math.round(p.normalizedPosition * 10) + 1);
  if (positions.length > 0) {
    const avgPos = positions.reduce((s, v) => s + v, 0) / positions.length;
    if (avgPos > 6) {
      suggestions.push('Low ranking position — create more comprehensive, authoritative content on this topic');
    }
  }

  // ── Filler: only add generic suggestions to reach 6 if needed ──
  const fillers = [
    'Strengthen E-E-A-T signals (author bio, date, citations)',
    'Add authoritative external citations and sources',
    'Keyword in title and first 100 words',
    'Include FAQ section with exact-match questions',
  ];
  for (const f of fillers) {
    if (suggestions.length >= 6) break;
    if (!suggestions.includes(f)) suggestions.push(f);
  }

  return suggestions.slice(0, 6);
}

function formatTrackedPrompts(prompts, latestScan, previousScan, recentScans, domain) {
  // Pre-build lookup: for each scan, promptId → result (avoids O(prompts × scans × results) find)
  // Also build text-based fallback maps for when promptIds don't match (e.g. prompts regenerated)
  // Oldest-first so the per-prompt history pipeline can carry-forward
  // left-to-right. (recentScans is sorted newest-first by the DB query.)
  const scansOldestFirst = [...(recentScans || [])].reverse();
  const scanResultMaps = scansOldestFirst.map((scan) => {
    const m = new Map();
    for (const r of (scan.results || [])) {
      if (r.promptId) m.set(r.promptId.toString(), r);
    }
    return m;
  });
  const scanResultMapsByText = scansOldestFirst.map((scan) => {
    const m = new Map();
    for (const r of (scan.results || [])) {
      const key = (r.prompt || '').trim().toLowerCase();
      if (key) m.set(key, r);
    }
    return m;
  });

  if (!latestScan) {
    return prompts.map((p) => ({
      id: p._id.toString(),
      prompt: p.prompt,
      platforms: [],
      lastChecked: 'Never',
      trend: 'new',
      trendDelta: 0,
      models: p.models,
      frequency: p.frequency,
      active: p.active,
      locked: p.locked || false,
      suggestions: generatePromptSuggestions(null, null),
      trendHistory: [],
      competitors: [],
    }));
  }

  // Pre-build competitor list for per-prompt attribution
  // Filter own brand + deduplicate aliases (e.g. "OpenAI" + "ChatGPT" → "ChatGPT")
  // F9-04: use engine's extractBrand (see formatCompetitors).
  const ownBrand = domain ? extractBrand(domain) : null;
  const allCR = (latestScan.competitorResults || []).filter((cr) => !cr.isOwn && !(ownBrand && isSameBrand(cr.name, ownBrand)));
  // Deduplicate: merge alias brands (keeps longest name as display)
  const dedupedCR = [];
  for (const cr of allCR) {
    const existing = dedupedCR.find((d) => isSameBrand(d.name, cr.name));
    if (existing) {
      existing.mentions += cr.mentions;
      if (cr.name.length > existing.name.length) existing.name = cr.name;
    } else {
      dedupedCR.push({ ...cr });
    }
  }
  // Generic words that shouldn't match on their own (too common in AI responses)
  const STOP_WORDS = new Set(['search', 'engine', 'tools', 'tool', 'assistant', 'chat', 'studio', 'labs', 'platform', 'suite', 'cloud', 'machine', 'learning', 'intelligence']);
  const competitorMatchers = dedupedCR.map((cr) => {
    const escaped = cr.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Build patterns: full name + individual significant words (4+ chars, not generic)
    const patterns = [new RegExp(`\\b${escaped}\\b`, 'i')];
    const words = cr.name.toLowerCase().split(/[\s-]+/);
    if (words.length > 1) {
      for (const w of words) {
        if (w.length >= 4 && !STOP_WORDS.has(w)) {
          const wEsc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          patterns.push(new RegExp(`\\b${wEsc}\\b`, 'i'));
        }
      }
    }
    // F6-04: slugPattern uses word boundaries so cited URLs are matched on
    // hostname/path labels rather than naked substring. Previously
    // `url.includes('semrush')` matched `supersemrushy.com` → wrong cited
    // attribution. `\b` treats `.`/`/`/`-` as word boundaries so
    // `semrush.com` / `path/semrush/x` still match while
    // `supersemrushy.com` does not.
    const slug = cr.name.toLowerCase().replace(/\s+/g, '');
    const slugEsc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      name: cr.name,
      patterns,
      slugPattern: new RegExp(`\\b${slugEsc}\\b`, 'i'),
    };
  });

  // Build carry-forward maps: latest/prev known result per prompt across ALL recent scans.
  // Prompts on different frequencies (e.g. monthly) won't appear in every scan, but we
  // still want to show their last known value rather than falling back to 0.
  // recentScans is sorted newest-first, so first occurrence = most recent result.
  const seenCount = new Map();
  const latestMap = new Map();
  const prevMap = new Map();
  // Text-based fallback maps: when promptIds don't match (e.g. prompts were regenerated
  // after a scan), fall back to matching by normalized prompt text
  const seenCountByText = new Map();
  const latestMapByText = new Map();
  const prevMapByText = new Map();
  for (const scan of (recentScans || [])) {
    for (const r of (scan.results || [])) {
      const pid = r.promptId?.toString();
      if (pid) {
        const n = (seenCount.get(pid) || 0) + 1;
        seenCount.set(pid, n);
        if (n === 1) latestMap.set(pid, r);
        else if (n === 2) prevMap.set(pid, r);
      }
      // Always build text-based fallback for cases where promptIds don't
      // match (prompts regenerated, monitor migrated, etc.).
      //
      // F18-06 (documented residual): two prompts sharing identical
      // normalized text collide here — both resolve to the same historical
      // result. `addPrompt` rejects same-text dupes at create time so
      // this only fires under edge cases (cross-monitor import, after a
      // rename race). Acceptable; the primary lookup is always promptId,
      // so well-behaved data is unaffected.
      const textKey = (r.prompt || '').trim().toLowerCase();
      if (textKey) {
        const nt = (seenCountByText.get(textKey) || 0) + 1;
        seenCountByText.set(textKey, nt);
        if (nt === 1) latestMapByText.set(textKey, r);
        else if (nt === 2) prevMapByText.set(textKey, r);
      }
    }
  }

  return prompts.map((p) => {
    const pid = p._id.toString();
    const textKey = (p.prompt || '').trim().toLowerCase();
    // Primary: match by promptId. Fallback: match by prompt text (handles regenerated prompts)
    const scanResult = latestMap.get(pid) || latestMapByText.get(textKey) || null;
    const prevResult = prevMap.get(pid) || prevMapByText.get(textKey) || null;

    // Per-prompt carry-forward, indexed oldest→newest. At each scan position,
    // use this prompt's own result if present, else the most recent prior
    // result. Stays null until the prompt's first-ever scan. Prevents
    // zero-spike valleys in detail-view charts for prompts on slower
    // frequencies than the tracker's scan cadence.
    let lastResult = null;
    const effectiveResults = scanResultMaps.map((m, i) => {
      const result = m.get(pid) || scanResultMapsByText[i]?.get(textKey);
      if (result) lastResult = result;
      return lastResult;
    });

    // Weighted visibility for current and previous scans
    const currentVisibility = scanResult
      ? computeWeightedVisibility(scanResult.platforms)
      : 0;
    const prevVisibility = prevResult
      ? computeWeightedVisibility(prevResult.platforms)
      : 0;

    let trend = 'stable';
    if (!prevResult) trend = 'new';
    else if (currentVisibility > prevVisibility) trend = 'up';
    else if (currentVisibility < prevVisibility) trend = 'down';

    const trendDelta = currentVisibility - prevVisibility;

    // Per-prompt competitor attribution: check which competitors appear in this prompt's responses
    const promptCompetitors = [];
    if (scanResult) {
      for (const cm of competitorMatchers) {
        let mentioned = false;
        let cited = false;
        for (const pl of (scanResult.platforms || [])) {
          if (!mentioned && pl.aiResponse && cm.patterns.some((r) => r.test(pl.aiResponse))) mentioned = true;
          if (!cited && pl.citedUrls && pl.citedUrls.some(u => cm.slugPattern.test(u))) cited = true;
          if (mentioned && cited) break;
        }
        if (mentioned || cited) {
          promptCompetitors.push({ name: cm.name, mentioned, cited });
        }
      }
    }

    return {
      id: p._id.toString(),
      prompt: p.prompt,
      platforms: (scanResult ? scanResult.platforms : []).map((pl) => ({
        platformId: pl.platformId,
        mentioned: pl.mentioned,
        position: pl.position ?? null,
        cited: pl.cited,
        citationCount: pl.citationCount ?? 0,
        citedUrls: pl.citedUrls || [],
        brandRanking: (pl.brandRanking || []).map(b => ({
          brandName: b.brandName,
          isTargetBrand: b.isTargetBrand,
          mentionCount: b.mentionCount ?? 1,
        })),
        aiResponse: pl.aiResponse || null,
        sentiment: pl.sentiment || null,
        sentimentScore: pl.sentimentScore ?? null,
        error: pl.error || false,
        fanoutQueries: pl.fanoutQueries || [],
        // F11-02: surface the fallback-mode signal so UI can disambiguate
        // "no fanout because LLM didn't search" from "no fanout because we
        // fell back to a non-fanout API".
        ...(pl.fanoutUnavailable ? { fanoutUnavailable: true } : {}),
        // Backward compat for old scans
        ...(pl.tier ? { tier: pl.tier } : {}),
        ...(pl.citedFrom ? { citedFrom: pl.citedFrom } : {}),
        ...(pl.normalizedPosition != null ? { normalizedPosition: pl.normalizedPosition } : {}),
      })),
      competitors: promptCompetitors,
      // F18-01: per-prompt last-scan time. Was `latestScan.completedAt` —
      // every prompt showed the tracker's latest scan time even when the
      // prompt itself was skipped (slower-frequency cadence). The prompt
      // model's `lastScannedAt` is the actual per-prompt timestamp.
      lastChecked: p.lastScannedAt
        ? formatRelativeDate(p.lastScannedAt)
        : 'Pending',
      trend,
      trendDelta,
      aiResponse: scanResult ? (scanResult.platforms || []).find((pl) => pl.aiResponse)?.aiResponse : undefined,
      models: p.models,
      frequency: p.frequency,
      active: p.active,
      locked: p.locked || false,
      suggestions: generatePromptSuggestions(scanResult, prevResult),
      trendHistory: effectiveResults.map((r) =>
        r ? computeWeightedVisibility(r.platforms) : 0
      ),
      citationHistory: effectiveResults.map((r) => {
        if (!r) return 0;
        const valid = (r.platforms || []).filter((pl) => !pl.error);
        const citedCount = valid.filter((pl) => pl.cited).length;
        const mentionedCount = valid.filter((pl) => pl.mentioned).length;
        return mentionedCount > 0 ? Math.round((citedCount / mentionedCount) * 100) : 0;
      }),
      mentionRateHistory: effectiveResults.map((r) => {
        if (!r) return 0;
        const valid = (r.platforms || []).filter((pl) => !pl.error);
        if (valid.length === 0) return 0;
        return Math.round((valid.filter((pl) => pl.mentioned).length / valid.length) * 100);
      }),
      positionHistory: effectiveResults.map((r) => {
        if (!r) return null;
        const ranks = [];
        for (const pl of (r.platforms || [])) {
          if (pl.error || !pl.mentioned) continue;
          if (pl.position != null) {
            ranks.push(pl.position);
          } else if (pl.brandRanking && pl.brandRanking.length > 0) {
            const idx = pl.brandRanking.findIndex((b) => b.isTargetBrand);
            if (idx >= 0) ranks.push(idx + 1);
          } else if (pl.normalizedPosition != null) {
            ranks.push(Math.round(pl.normalizedPosition * 10) + 1);
          }
        }
        if (ranks.length === 0) return null;
        return Math.round((ranks.reduce((s, v) => s + v, 0) / ranks.length) * 10) / 10;
      }),
      sentimentHistory: effectiveResults.map((r) => {
        if (!r) return null;
        const scores = (r.platforms || []).filter((pl) => pl.mentioned && !pl.error && pl.sentimentScore != null).map((pl) => pl.sentimentScore);
        if (scores.length === 0) return null;
        return Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
      }),
      trendDates: scansOldestFirst.map((scan) => {
        const d = scan.completedAt || scan.startedAt;
        return d ? d.toISOString() : null;
      }),
    };
  });
}

function formatCompetitors(latestScan, previousScan, domain) {
  const currentResults = latestScan?.competitorResults || [];
  const prevResults = previousScan?.competitorResults || [];

  if (currentResults.length === 0) return [];

  // F9-04: use engine's `extractBrand` instead of `domain.split('.')[0]`.
  // Pre-fix `app.suparank.com` → `'app'` (wrong, should be `'suparank'`),
  // and `analytics.google.com` → `'analytics'` which is in
  // GENERIC_BRAND_WORDS so isSameBrand single-word checks rejected the
  // own-brand match. `extractBrand` uses the public-suffix-aware logic
  // from F2-15 that strips subdomains and multi-part TLDs properly.
  const ownBrand = domain ? extractBrand(domain) : null;

  const allMentions = currentResults.reduce((sum, cr) => sum + cr.mentions, 0);

  return currentResults.map((cr, idx) => {
    // Match previous scan by brand similarity (handles "GPT" ↔ "ChatGPT", "Anthropic Claude" ↔ "Claude", etc.)
    const prev = prevResults.find((pr) => isSameBrand(cr.name, pr.name));
    const prevVisibility = prev ? prev.visibility : 0;
    const shareOfVoice = allMentions > 0 ? Math.round((cr.mentions / allMentions) * 100) : 0;

    // Mark as own if flagged OR if brand name matches the monitored domain
    const isOwn = cr.isOwn || (ownBrand ? isSameBrand(cr.name, ownBrand) : false);

    return {
      id: `auto-${idx}`,
      name: cr.name,
      isOwn,
      visibility: cr.visibility,
      visibilityDelta: cr.visibility - prevVisibility,
      mentions: cr.mentions,
      citations: cr.citations,
      shareOfVoice,
    };
  });
}

function computeChanges(latestScan, previousScan, carryScans) {
  if (!latestScan) return [];

  // F18-07: when carryScans is supplied, build the per-prompt previous
  // result by walking carryScans newest-first and picking each prompt's
  // most-recent result *strictly older* than the latest scan. This
  // prevents the misclassification where a monthly prompt scanned today
  // (but not yesterday) was reported as "newly mentioned" simply because
  // the dashboard-level previousScan didn't include it.
  //
  // Legacy fallback: with no carryScans, compare against previousScan.
  // Returns [] if neither comparison source is available.
  const prevMap = new Map();
  if (Array.isArray(carryScans) && carryScans.length > 0) {
    for (const scan of carryScans) {
      if (!scan.completedAt || scan.completedAt >= latestScan.completedAt) continue;
      for (const r of (scan.results || [])) {
        const pid = r.promptId?.toString();
        if (pid && !prevMap.has(pid)) prevMap.set(pid, r);
      }
    }
  } else if (previousScan) {
    for (const r of (previousScan.results || [])) {
      if (r.promptId) prevMap.set(r.promptId.toString(), r);
    }
  } else {
    return [];
  }

  const changes = [];
  let changeId = 0;

  // Helper to build platform metadata fields
  const platMeta = (plat) => {
    const meta = PLATFORM_DISPLAY.find((p) => p.platformId === plat.platformId);
    // Defensive fallback for missing/empty platformId — was `plat.platformId[0]`
    // which threw on undefined. PLATFORM_DISPLAY covers the active platform
    // set, so this only matters for legacy results with stripped fields.
    const pid = plat.platformId || '?';
    return {
      platform: meta ? meta.name : pid,
      platformLetter: meta ? meta.letter : pid[0].toUpperCase(),
      platformColor: meta ? meta.color : 'text-gray-600',
      platformBg: meta ? meta.bgColor : 'bg-gray-50',
    };
  };

  for (const result of (latestScan.results || [])) {
    if (!result.promptId) continue;
    const prevResult = prevMap.get(result.promptId.toString());
    if (!prevResult) continue;

    for (const plat of (result.platforms || [])) {
      const prevPlat = (prevResult.platforms || []).find((pp) => pp.platformId === plat.platformId);
      const m = platMeta(plat);

      // ── New platform (not scanned previously) ──
      if (!prevPlat) {
        // Don't report "newly tracked" for an errored platform — we don't
        // actually know whether it was mentioned yet.
        if (plat.error) continue;
        if (plat.mentioned) {
          changes.push({
            id: `ch_${changeId++}`, type: 'gained', prompt: result.prompt, ...m,
            detail: `Now mentioned on ${m.platform} (newly tracked)`,
          });
          if (plat.cited) {
            changes.push({
              id: `ch_${changeId++}`, type: 'new_citation', prompt: result.prompt, ...m,
              detail: `Cited on ${m.platform} (newly tracked)`,
            });
          }
        }
        continue;
      }

      // F17-01 + F17-02: if either side errored, we have no reliable signal
      // about the platform's mention/citation state. Skipping prevents
      // ghost changes like "Lost mention on ChatGPT" when really the scan
      // just failed. Errored ticks create gaps in the change log — a
      // deliberate accuracy-over-completeness trade.
      if (plat.error || prevPlat.error) continue;

      // ── Mention gained / lost ──
      if (!prevPlat.mentioned && plat.mentioned) {
        changes.push({
          id: `ch_${changeId++}`, type: 'gained', prompt: result.prompt, ...m,
          detail: `Now mentioned on ${m.platform}`,
        });
      } else if (prevPlat.mentioned && !plat.mentioned) {
        changes.push({
          id: `ch_${changeId++}`, type: 'lost', prompt: result.prompt, ...m,
          detail: `Lost mention on ${m.platform}`,
        });
      }

      // ── Citation gained ──
      if (!prevPlat.cited && plat.cited) {
        const citUrl = (plat.citedUrls && plat.citedUrls[0]) || plat.citedFrom || m.platform;
        changes.push({
          id: `ch_${changeId++}`, type: 'new_citation', prompt: result.prompt, ...m,
          detail: `New citation from ${citUrl}`,
        });
      }

      // ── Citation lost ──
      if (prevPlat.cited && !plat.cited) {
        changes.push({
          id: `ch_${changeId++}`, type: 'declined', prompt: result.prompt, ...m,
          detail: `Lost citation on ${m.platform}`,
        });
      }

      // ── Position change (both mentioned) ──
      if (plat.mentioned && prevPlat.mentioned) {
        // Derive position: prefer new `position` field, fall back to brandRanking, then normalizedPosition
        const getPos = (p) => {
          if (p.position != null) return p.position;
          if (p.brandRanking && p.brandRanking.length > 0) {
            const idx = p.brandRanking.findIndex(b => b.isTargetBrand);
            if (idx >= 0) return idx + 1;
          }
          if (p.normalizedPosition != null) return Math.round(p.normalizedPosition * 10) + 1;
          return null;
        };
        const prevPos = getPos(prevPlat);
        const currPos = getPos(plat);
        if (prevPos != null && currPos != null) {
          // Lower position = better.
          //
          // F17-04: report any movement that touches the top 3 (the change
          // user cares about most — #2 → #1 is a more meaningful event than
          // #8 → #6), and require ≥2 elsewhere to keep noise down.
          const posDelta = currPos - prevPos;
          const touchesTopTier = Math.min(prevPos, currPos) <= 3;
          const isMeaningful = posDelta !== 0 && (touchesTopTier || Math.abs(posDelta) >= 2);
          if (isMeaningful) {
            if (posDelta < 0) {
              changes.push({
                id: `ch_${changeId++}`, type: 'improved', prompt: result.prompt, ...m,
                detail: `Position improved on ${m.platform} (#${prevPos} → #${currPos})`,
              });
            } else {
              changes.push({
                id: `ch_${changeId++}`, type: 'declined', prompt: result.prompt, ...m,
                detail: `Position dropped on ${m.platform} (#${prevPos} → #${currPos})`,
              });
            }
          }
        }
      }
    }
  }

  // ── Competitor changes ──
  // F17-03: skip the own-brand entry. competitorResults always includes
  // the user's own brand (set by the engine as `isOwn: true`). Without
  // this filter, the user's own mention gains rendered as a RED
  // "Competitor cited" warning — the exact opposite of the intent.
  if (latestScan.competitorResults && previousScan && previousScan.competitorResults) {
    const prevCompList = previousScan.competitorResults;

    for (const comp of latestScan.competitorResults) {
      if (comp.isOwn) continue;
      const prevComp = prevCompList.find((c) => isSameBrand(c.name, comp.name));
      if (!prevComp) continue;

      const mentionDelta = comp.mentions - prevComp.mentions;
      const citationDelta = comp.citations - prevComp.citations;

      if (mentionDelta > 0) {
        changes.push({
          id: `ch_${changeId++}`, type: 'competitor',
          prompt: comp.name,
          detail: `${comp.name} gained ${mentionDelta} new mention${mentionDelta > 1 ? 's' : ''}`,
        });
      }

      if (citationDelta > 0) {
        changes.push({
          id: `ch_${changeId++}`, type: 'competitor',
          prompt: comp.name,
          detail: `${comp.name} gained ${citationDelta} new citation${citationDelta > 1 ? 's' : ''}`,
        });
      }
    }
  }

  return changes;
}

function computeTrendData(scans, carryScans) {
  // scans are sorted newest-first from the DB query
  // Detect which calendar dates have multiple scans so we can add time
  const dateCounts = {};
  for (const scan of scans) {
    const d = scan.completedAt || scan.startedAt;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    dateCounts[key] = (dateCounts[key] || 0) + 1;
  }

  // F18-02: carry-forward visibility so the chart matches computeMetrics.
  // Pre-fix: each point used only that scan's raw results — for a tick
  // that ran only daily prompts (skipping the monthly), visibility dropped
  // because the monthly result wasn't included, even though the *known
  // state* of the monthly prompt hadn't changed. Now: for each scan
  // point, build the effective state from all carryScans with completedAt
  // <= that scan's completedAt, so slow-frequency prompts contribute
  // their last-known result rather than vanishing.
  //
  // `carryScans` is optional — when omitted (legacy callers) or empty,
  // falls back to raw per-scan visibility. (Treating empty-array same as
  // missing prevents the misuse case where a caller passes `[]` and
  // accidentally zeros out every point.)
  const carryDesc = Array.isArray(carryScans) && carryScans.length > 0 ? carryScans : null;

  return scans.map((scan, idx) => {
    let value;
    if (carryDesc) {
      const effectiveMap = new Map();
      // carryDesc is sorted DESC; we want all scans completedAt <= this scan's
      // completedAt, latest-first so "first seen" wins (carry-forward semantic).
      for (const cs of carryDesc) {
        if (!cs.completedAt || cs.completedAt > scan.completedAt) continue;
        for (const r of (cs.results || [])) {
          const pid = r.promptId?.toString();
          if (pid && !effectiveMap.has(pid)) effectiveMap.set(pid, r);
        }
      }
      const allPlatforms = [...effectiveMap.values()].flatMap((r) => r.platforms || []);
      value = allPlatforms.length > 0 ? computeWeightedVisibility(allPlatforms) : 0;
    } else {
      const allPlatforms = (scan.results || []).flatMap((r) => r.platforms || []);
      value = allPlatforms.length > 0 ? computeWeightedVisibility(allPlatforms) : 0;
    }

    const d = scan.completedAt || scan.startedAt;
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();

    // Add time when multiple scans share the same calendar date
    const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const time = dateCounts[dateKey] > 1
      ? ' ' + d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })
      : '';

    // Compute changes between this scan and the next older one
    const olderScan = scans[idx + 1] || null;
    const changes = computeChanges(scan, olderScan);

    return { week: `${month} ${day}${time}`, value, date: d.toISOString(), changes };
  }).reverse(); // oldest first
}

function computePlatformStats(latestScan, _domain) {
  return PLATFORM_DISPLAY.map((p) => {
    const platformResults = [];
    let mentionCount = 0;
    let citationCount = 0;
    let totalCitationUrls = 0;
    let totalPrompts = 0;
    let errorCount = 0;

    if (latestScan) {
      for (const r of (latestScan.results || [])) {
        const plat = (r.platforms || []).find((pl) => pl.platformId === p.platformId);
        if (plat) {
          platformResults.push(plat);
          if (plat.error) { errorCount++; continue; }
          totalPrompts++;
          if (plat.mentioned) mentionCount++;
          if (plat.cited) citationCount++;
          if (plat.citationCount != null) {
            totalCitationUrls += plat.citationCount;
          } else if (plat.citedUrls && plat.citedUrls.length > 0) {
            totalCitationUrls += new Set(plat.citedUrls).size;
          }
        }
      }
    }

    return {
      platformId: p.platformId,
      name: p.name,
      letter: p.letter,
      color: p.color,
      bgColor: p.bgColor,
      borderColor: p.borderColor,
      visibility: computeWeightedVisibility(platformResults),
      mentionCount,
      citationCount,
      totalCitationUrls,
      errorCount,
    };
  });
}

function generateActionItems(latestScan) {
  if (!latestScan) return [];

  // F6-03: alias guards `results`/`platforms` once so each filter below
  // doesn't re-guard. Mongoose subdoc arrays default to [] but legacy or
  // lean-projected docs may omit the field; this keeps the function pure
  // and total against either shape.
  const scanResults = latestScan.results || [];

  const items = [];
  let id = 0;

  // Prompts not mentioned on any platform (exclude all-errored prompts)
  const missingAll = scanResults.filter((r) => {
    const valid = (r.platforms || []).filter((p) => !p.error);
    return valid.length > 0 && valid.every((p) => !p.mentioned);
  });
  if (missingAll.length > 0) {
    items.push({
      id: `ai_${id++}`,
      priority: 'high',
      title: `Create targeted content for ${missingAll.length} unmentioned prompt${missingAll.length > 1 ? 's' : ''}`,
      description: `Your brand is not mentioned in any AI platform for ${missingAll.length} tracked prompts. Creating comprehensive content targeting these queries can improve visibility.`,
      impact: `+${Math.min(missingAll.length * 10, 40)}% visibility`,
      type: 'content',
      linkedPrompts: missingAll.filter((r) => r.promptId).map((r) => r.promptId.toString()),
    });
  }

  // Mentioned but not cited (exclude errored platforms).
  //
  // F13-02: copy now says "on some platforms for N prompts" instead of the
  // pre-fix "you are mentioned in N prompts but not cited" — which implied
  // those prompts had ZERO citations even when they were cited on 2 of 3
  // platforms. The more honest framing also counts the platform-level
  // instances (a richer signal than per-prompt presence) for the impact
  // estimate.
  // F13-03: linkedPrompts added so UI can deep-link the recommendation to
  // the affected prompts (parity with the missingAll action item).
  const mentionedNotCited = scanResults.filter((r) =>
    (r.platforms || []).some((p) => !p.error && p.mentioned && !p.cited)
  );
  if (mentionedNotCited.length > 0) {
    let mncInstances = 0;
    for (const r of mentionedNotCited) {
      for (const p of (r.platforms || [])) {
        if (!p.error && p.mentioned && !p.cited) mncInstances++;
      }
    }
    items.push({
      id: `ai_${id++}`,
      priority: 'medium',
      title: 'Add structured data and citations to boost citation rate',
      description: `On some platforms for ${mentionedNotCited.length} prompt${mentionedNotCited.length > 1 ? 's' : ''} (${mncInstances} platform mention${mncInstances > 1 ? 's' : ''} total), your brand is mentioned but no link back to your site is cited. Adding FAQ schema, clear brand mentions, and authoritative content structure can improve citation rates.`,
      impact: `+${Math.min(mncInstances * 2, 25)}% citation rate`,
      type: 'technical',
      linkedPrompts: mentionedNotCited.filter((r) => r.promptId).map((r) => r.promptId.toString()),
    });
  }

  // Platform gaps: identify platforms with LOW mention rates across the
  // tracker, not just any platform that's missing on a single prompt.
  //
  // F13-01: pre-fix the recommendation listed EVERY platform that had a gap
  // on any single prompt — so a platform mentioning own brand 49 of 50 times
  // (98% rate) was flagged as a "gap platform" the user should "close". Now
  // we compute per-platform mention rates over the non-errored prompt set
  // and only flag platforms whose rate is below `PLATFORM_GAP_THRESHOLD`.
  const PLATFORM_GAP_THRESHOLD = 0.5;
  const platformStatsMap = new Map(); // platformId → { mentioned, total, promptIds }
  for (const r of scanResults) {
    for (const p of (r.platforms || [])) {
      if (p.error) continue;
      const stat = platformStatsMap.get(p.platformId) || { mentioned: 0, total: 0, promptIds: [] };
      stat.total++;
      if (p.mentioned) stat.mentioned++;
      else if (r.promptId) stat.promptIds.push(r.promptId.toString());
      platformStatsMap.set(p.platformId, stat);
    }
  }
  const lowRatePlatforms = [...platformStatsMap.entries()]
    .filter(([_, s]) => s.total > 0 && (s.mentioned / s.total) < PLATFORM_GAP_THRESHOLD)
    .map(([pid, s]) => ({ pid, rate: s.mentioned / s.total, promptIds: s.promptIds }));

  if (lowRatePlatforms.length > 0) {
    const gapPlatformIds = lowRatePlatforms.map((x) => x.pid);
    const gapNames = gapPlatformIds
      .map((pid) => PLATFORM_DISPLAY.find((pd) => pd.platformId === pid)?.name || pid)
      .join(', ');
    // F13-03: linkedPrompts = union of un-mentioned prompts across the
    // low-rate platforms (deduped).
    const linkedPrompts = [...new Set(lowRatePlatforms.flatMap((x) => x.promptIds))];
    // Worst rate determines impact estimate (more honest than the prior
    // `gaps.length * 8` heuristic).
    const worstGap = Math.min(...lowRatePlatforms.map((x) => x.rate));
    const liftPct = Math.round((PLATFORM_GAP_THRESHOLD - worstGap) * 100);
    items.push({
      id: `ai_${id++}`,
      priority: 'medium',
      title: `Close platform gaps on ${gapNames}`,
      description: `${gapNames} ${gapPlatformIds.length === 1 ? 'is' : 'are'} mentioning your brand on fewer than ${Math.round(PLATFORM_GAP_THRESHOLD * 100)}% of tracked prompts. Diversifying content format and structure can help reach those AI platforms.`,
      impact: `+${Math.min(liftPct, 30)}% cross-platform visibility`,
      type: 'strategy',
      platformGap: gapPlatformIds,
      linkedPrompts,
    });
  }

  return items;
}

// ─── Helper: relative date formatting ─────────────────────────────────────

function formatRelativeDate(date) {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ═══════════════════════════════════════════════════════════════════════════
// STUCK SCAN RECOVERY
// ═══════════════════════════════════════════════════════════════════════════

// Reset scans stuck in 'scanning' or 'pending' for more than 30 minutes
async function recoverStuckScans(workspaceId) {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const result = await AiTracker.updateMany(
    {
      workspaceId,
      scanStatus: { $in: ['scanning', 'pending'] },
      updatedAt: { $lt: thirtyMinAgo },
    },
    { $set: { scanStatus: 'failed', scanError: 'Scan timed out and was automatically recovered' } }
  );
  if (result.modifiedCount > 0) {
    console.log(`[ai-tracker-scan] Recovered ${result.modifiedCount} stuck scan(s) in workspace ${workspaceId}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND SCAN EXECUTION (fire-and-forget)
// ═══════════════════════════════════════════════════════════════════════════

async function executeScan(trackerId, userId = null, { force = false } = {}) {
  let creditTxId = null;
  let orgId = null;
  let scanDocId = null; // hoisted so Phase H can mark the AiTrackerScan failed

  try {
    // ── 1. Atomic guard: claim the scan (prevents double-execution from race conditions)
    const claimed = await AiTracker.findOneAndUpdate(
      { _id: trackerId, scanStatus: { $in: ['ready', 'pending', 'idle', 'failed'] } },
      { $set: { scanStatus: 'scanning', scanProgress: 0, scanError: null } },
      { new: true }
    );
    if (!claimed) return; // already scanning or doesn't exist

    const tracker = claimed;

    // ── 1b. Empty defaultModels guard — no platforms enabled (e.g. cleared
    //        by downgrade). Bail out without creating a scan doc or
    //        advancing per-prompt lastScannedAt. F19 reselection UI will
    //        prompt the user to re-pick platforms.
    if (!tracker.defaultModels || tracker.defaultModels.length === 0) {
      const retryDelay = (24 * 60 * 60 * 1000) / (_devTimeScale || 1);
      await AiTracker.findByIdAndUpdate(trackerId, {
        $set: {
          scanStatus: 'ready',
          scanProgress: 0,
          scanError: 'No platforms enabled',
          nextScanAt: new Date(Date.now() + retryDelay),
        },
      });
      return;
    }

    // ── 2. Resolve org for credit operations
    const ws = await Workspace.findById(tracker.workspaceId);
    orgId = ws?.organizationId?.toString() || null;

    // ── 3. Load prompts & platforms to estimate credit cost (skip inactive + locked prompts)
    // F4-15: the prior `.limit(500)` was a silent truncation. Capped at tier
    // level via maxAiTrackerPromptsPerMonitor at addPrompt time; bounded query
    // here for defense (10× the typical tier ceiling).
    const allActivePrompts = await AiTrackerPrompt.find({ trackerId, active: { $ne: false }, locked: { $ne: true } }).limit(5000);

    // ── 3b. Filter prompts by frequency — only scan prompts that are due
    //        Manual scans (force=true) scan all prompts but only reset timers for due ones
    const scanStart = new Date();
    const FREQ_DAYS = { 'Daily': 1, 'Weekly': 7, 'Bi-weekly': 14, 'Monthly': 30 };
    const timeScale = _devTimeScale; // >1 in dev accelerated mode, 1 = real time
    // Tolerance absorbs cron's 1-minute real-time granularity so prompts with harmonically
    // related frequencies (weekly + bi-weekly) always land in the same scan.
    // Capped at 10% of the shortest interval to prevent high time scales from making
    // everything appear due (e.g. at 10000x, Daily=8.6s, old 2-min tolerance > interval).
    const shortestIntervalMs = Math.min(...allActivePrompts.map(p =>
      ((FREQ_DAYS[p.frequency] || 7) / timeScale) * 24 * 60 * 60 * 1000
    ));
    const CRON_TOLERANCE_MS = Math.min(2 * 60 * 1000, shortestIntervalMs * 0.1);
    const isDuePrompt = (p) => {
      if (!p.lastScannedAt) return true; // never scanned → always due
      const freqDays = (FREQ_DAYS[p.frequency] || 7) / timeScale;
      const dueAt = new Date(p.lastScannedAt.getTime() + freqDays * 24 * 60 * 60 * 1000);
      return scanStart.getTime() + CRON_TOLERANCE_MS >= dueAt.getTime();
    };
    // Manual scans scan all prompts (user gets fresh data) but track which were due
    // so we only reset lastScannedAt on due ones (preserving cooldown timers)
    const duePromptIds = new Set(allActivePrompts.filter(isDuePrompt).map((p) => p._id.toString()));
    // F20-04: `let` because the re-fetch at step 6 may filter out prompts
    // that became locked between the credit estimate and scan start.
    let prompts = force ? allActivePrompts : allActivePrompts.filter(isDuePrompt);

    const platformCount = tracker.defaultModels?.length || 0;
    const promptCount = prompts.length;

    // ── 3c. Skip scan entirely if no prompts are due — but advance nextScanAt
    //        so the cron doesn't keep re-picking this tracker every cycle
    if (promptCount === 0) {
      console.log(`[ai-tracker-scan] No prompts due for ${trackerId}, skipping scan`);
      // Find the earliest next-due prompt to set nextScanAt precisely
      let nextDueAt = null;
      for (const p of allActivePrompts) {
        if (!p.lastScannedAt) { nextDueAt = scanStart; break; } // should not happen (would have been included)
        const freqDays = (FREQ_DAYS[p.frequency] || 7) / timeScale;
        const due = new Date(p.lastScannedAt.getTime() + freqDays * 24 * 60 * 60 * 1000);
        if (!nextDueAt || due < nextDueAt) nextDueAt = due;
      }
      // Fallback: if no active prompts at all, schedule 1 day out (scaled)
      if (!nextDueAt) nextDueAt = new Date(scanStart.getTime() + (24 * 60 * 60 * 1000) / timeScale);
      await AiTracker.findByIdAndUpdate(trackerId, {
        $set: { scanStatus: 'ready', scanProgress: 0, nextScanAt: nextDueAt },
      });
      return;
    }

    // ── 4. Pre-deduct estimated credits (1 credit per 50 words, ~200 words per answer)
    //       Estimate = prompts × platforms × 4 credits, minimum 1
    if (orgId && platformCount > 0 && promptCount > 0) {
      const estimatedCredits = Math.max(1, promptCount * platformCount * 4);
      try {
        const { transactionId } = await creditService.preDeduct(
          orgId, userId, estimatedCredits,
          'aiTracker', { feature: 'aiTrackerScan', trackerId: trackerId.toString(), estimatedCredits }
        );
        creditTxId = transactionId;
      } catch (creditErr) {
        // Insufficient credits — push nextScanAt forward so cron doesn't retry every minute
        console.log(`[ai-tracker-scan] skipping scan for tracker ${trackerId}: ${creditErr.message}`);
        const retryDelay = (60 * 60 * 1000) / (_devTimeScale || 1); // 1 hour, scaled in dev
        await AiTracker.findByIdAndUpdate(trackerId, {
          $set: { scanStatus: 'ready', scanProgress: 0, scanError: 'Insufficient credits', nextScanAt: new Date(Date.now() + retryDelay) },
        });
        return;
      }
    }

    // ── 5. Create scan document
    const scan = await AiTrackerScan.create({ trackerId, startedAt: new Date() });
    scanDocId = scan._id;
    await AiTracker.findByIdAndUpdate(trackerId, { $set: { currentScanId: scan._id } });

    // F20-04: re-check lock status immediately before runScan to narrow the
    // race window with concurrent downgrades. Pre-fix `prompts` was captured
    // at step 3 and could be minutes old by step 6 (credit estimate +
    // pre-deduct between them). If a downgrade webhook fired in that window,
    // the in-memory list still contained now-locked prompts and they got
    // scanned + charged. This re-fetch shrinks the race to the gap between
    // re-fetch and the first per-prompt API call (typically ms).
    if (prompts.length > 0) {
      const stillUnlocked = await AiTrackerPrompt
        .find({ _id: { $in: prompts.map((p) => p._id) }, locked: { $ne: true } })
        .select('_id')
        .lean();
      const unlockedSet = new Set(stillUnlocked.map((p) => p._id.toString()));
      const filteredPrompts = prompts.filter((p) => unlockedSet.has(p._id.toString()));
      if (filteredPrompts.length < prompts.length) {
        console.log(`[ai-tracker-scan] F20-04: dropped ${prompts.length - filteredPrompts.length} prompts locked between estimate and scan start (tracker ${trackerId})`);
      }
      prompts = filteredPrompts;
    }

    // ── 6. Run the scan engine
    const { results, competitorResults, detectedBrands, totalAnswerWords, availablePlatformIds } = await runScan(
      tracker,
      prompts,
      [], // competitors auto-detected by scan engine
      async (progress, platformStatuses) => {
        await AiTracker.findByIdAndUpdate(trackerId, {
          $set: { scanProgress: progress, platformStatuses },
        });
      }
    );

    // ── 7. Settle credits with actual word count
    if (creditTxId) {
      try {
        const actualCredits = Math.max(1, creditService.wordsToCredits(totalAnswerWords));
        await creditService.settle(creditTxId, actualCredits);
        console.log(`[ai-tracker-scan] settled credits for tracker ${trackerId}: estimated ${promptCount * platformCount * 4}, actual ${actualCredits} (${totalAnswerWords} words)`);
        creditTxId = null; // Mark as settled so outer catch doesn't double-refund
      } catch (settleErr) {
        console.error(`[ai-tracker-scan] settle failed for tracker ${trackerId}, refunding:`, settleErr.message);
        await creditService.refund(creditTxId).catch((refundErr) => {
          console.error(`[ai-tracker-scan] refund also failed for tracker ${trackerId}:`, refundErr.message);
        });
        creditTxId = null;

        // S74: Don't save results if credits couldn't be settled — mark scan as failed.
        // Advance nextScanAt by 1h (dev-scaled) so cron doesn't immediately re-pick
        // this tracker and re-charge credits on a likely-still-broken pool.
        const settleRetryDelay = (60 * 60 * 1000) / (_devTimeScale || 1);
        await AiTrackerScan.findByIdAndUpdate(scan._id, {
          $set: { status: 'failed', completedAt: new Date() },
        });
        await AiTracker.findByIdAndUpdate(trackerId, {
          $set: {
            scanStatus: 'failed',
            scanError: 'Credit settlement failed',
            currentScanId: null,
            nextScanAt: new Date(Date.now() + settleRetryDelay),
          },
        });
        return;
      }
    }

    // ── 8. Save scan results
    const now = new Date();
    await AiTrackerScan.findByIdAndUpdate(scan._id, {
      $set: { status: 'ready', completedAt: now, results, competitorResults, detectedBrands: detectedBrands || [] },
    });

    // ── 8b. Fixed-rate scheduling: advance lastScannedAt by exactly one frequency
    //        interval instead of setting it to "now". This prevents scan execution
    //        time from causing drift (e.g. Weekly firing after 6 Daily scans instead of 7).
    //        Manual scans only reset timers on prompts that were actually due.
    //
    //        Only advance prompts that produced platform results — prompts where every
    //        platform was skipped by the per-prompt models filter never actually ran,
    //        so their schedule shouldn't drift forward.
    const scannedPromptIds = new Set(
      results.filter((r) => r.platforms && r.platforms.length > 0).map((r) => r.promptId.toString())
    );
    const promptsToResetTimer = prompts.filter((p) =>
      duePromptIds.has(p._id.toString()) && scannedPromptIds.has(p._id.toString())
    );
    let earliestNextDue = null;
    for (const p of promptsToResetTimer) {
      const freqMs = ((FREQ_DAYS[p.frequency] || 7) / timeScale) * 24 * 60 * 60 * 1000;
      let newLastScannedAt;
      if (p.lastScannedAt && p.lastScannedAt <= scanStart) {
        // Fixed-rate: jump to the most recent interval boundary before scanStart.
        // This prevents drift AND handles catch-up when multiple intervals have passed.
        const elapsed = scanStart.getTime() - p.lastScannedAt.getTime();
        const intervals = Math.max(1, Math.floor(elapsed / freqMs));
        newLastScannedAt = new Date(p.lastScannedAt.getTime() + intervals * freqMs);
      } else {
        // No history OR future-dated lastScannedAt (clock skew / manual DB edit).
        // Normalize to scanStart — refusing to honor anomalous future dates that
        // would otherwise be pushed even further into the future by the Math.max(1, …)
        // floor on intervals.
        newLastScannedAt = now;
      }
      await AiTrackerPrompt.findByIdAndUpdate(p._id, { $set: { lastScannedAt: newLastScannedAt } });
      // Track earliest next-due prompt to set tracker nextScanAt precisely
      const nextDue = new Date(newLastScannedAt.getTime() + freqMs);
      if (!earliestNextDue || nextDue < earliestNextDue) earliestNextDue = nextDue;
    }
    // Also factor in prompts that weren't advanced in the first loop:
    //   - Not-due prompts (normal case)
    //   - Due-but-not-scanned prompts whose per-prompt models[] didn't overlap
    //     with available platforms (F4-19 case)
    //
    // Without including the second group, the tracker's nextScanAt could land
    // a full refresh interval out while those prompts sit unscanned forever.
    // Filtering by `advancedPromptIds` (rather than `duePromptIds` as before)
    // ensures all unadvanced prompts contribute to the next-due calculation.
    const advancedPromptIds = new Set(promptsToResetTimer.map((p) => p._id.toString()));
    for (const p of allActivePrompts) {
      if (advancedPromptIds.has(p._id.toString())) continue; // first loop already handled
      if (!p.lastScannedAt) {
        // No history and not advanced — still due now. Schedule cron to pick up
        // soon (bounded to once-per-cron-tick by the daily cadence in prod, so
        // no thrashing within a day).
        if (!earliestNextDue || scanStart < earliestNextDue) earliestNextDue = scanStart;
        continue;
      }
      const freqMs = ((FREQ_DAYS[p.frequency] || 7) / timeScale) * 24 * 60 * 60 * 1000;
      const nextDue = new Date(p.lastScannedAt.getTime() + freqMs);
      if (!earliestNextDue || nextDue < earliestNextDue) earliestNextDue = nextDue;
    }

    // ── 9. Determine refresh interval from tier config (fallback for nextScanAt)
    let intervalDays = 7;
    if (orgId) {
      const { config } = await tierService.getOrgTierConfig(orgId);
      intervalDays = config?.aiTrackerRefreshInterval === 'daily' ? 1 : 7;
    }
    const fallbackNextScan = new Date(now.getTime() + (intervalDays / timeScale) * 24 * 60 * 60 * 1000);

    // ── 10. Update tracker to ready.
    //        platformStatuses comes from the engine's actual availablePlatformIds —
    //        not from tracker.defaultModels — so platforms silently dropped due to
    //        missing API keys are not falsely reported as 'completed'.
    //        An empty array means "no platform actually ran" — DO report that
    //        accurately rather than falling back to defaultModels (which would
    //        resurrect the F4-10 bug). Undefined only happens with a stale engine
    //        build that predates the availablePlatformIds return; preserve compat
    //        in that single case.
    const completedPlatforms = Array.isArray(availablePlatformIds)
      ? availablePlatformIds
      : (tracker.defaultModels || []);
    await AiTracker.findByIdAndUpdate(trackerId, {
      $set: {
        scanStatus: 'ready',
        scanProgress: 100,
        scanError: null,
        lastScanAt: now,
        nextScanAt: earliestNextDue || fallbackNextScan,
        currentScanId: null,
        platformStatuses: completedPlatforms.map((pid) => ({
          platformId: pid,
          status: 'completed',
        })),
      },
    });

    // ── 11. Send scan summary email to workspace owner
    try {
      const ownerId = userId || ws?.userId;
      if (!ownerId) {
        console.log(`[ai-tracker-scan] skipping email for tracker ${trackerId}: no ownerId (userId=${userId}, ws.userId=${ws?.userId})`);
      } else {
        const owner = await User.findById(ownerId).select('email profile preferences').lean();
        const { getSettings } = require('../services/systemSettingsService');
        if (getSettings().emailNotificationsEnabled === false) {
          console.log(`[ai-tracker-scan] skipping email for tracker ${trackerId}: email notifications disabled system-wide`);
        } else if (!owner) {
          console.log(`[ai-tracker-scan] skipping email for tracker ${trackerId}: user ${ownerId} not found`);
        } else if (!owner.email) {
          console.log(`[ai-tracker-scan] skipping email for tracker ${trackerId}: user ${ownerId} has no email`);
        } else if (owner.preferences?.emailNotifications === false) {
          console.log(`[ai-tracker-scan] skipping email for tracker ${trackerId}: emailNotifications disabled for ${owner.email}`);
        } else {
          // Build carry-forward results for prompts not scanned this run
          const scannedIds = new Set(results.map((r) => r.promptId?.toString()).filter(Boolean));
          const notScannedPrompts = allActivePrompts.filter((p) => !scannedIds.has(p._id.toString()));
          let carryForwardResults = [];
          if (notScannedPrompts.length > 0) {
            // Anchor on the oldest lastScannedAt among not-scanned prompts so we always
            // reach back far enough — no fixed limit that could drop monthly/slow prompts.
            // F18-03: same 90-day clamp as buildDashboardResponse (a corrupted
            // lastScannedAt would otherwise scan all-time tracker history).
            const notScannedWithHistory = notScannedPrompts.filter((p) => p.lastScannedAt);
            const ninetyDaysAgoEmail = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
            let oldestNeeded = notScannedWithHistory.reduce((min, p) =>
              p.lastScannedAt < min ? p.lastScannedAt : min,
              notScannedWithHistory[0]?.lastScannedAt || new Date()
            );
            if (oldestNeeded < ninetyDaysAgoEmail) oldestNeeded = ninetyDaysAgoEmail;
            const prevScans = await AiTrackerScan.find({
              trackerId,
              status: 'ready',
              _id: { $ne: scan._id },
              completedAt: { $gte: oldestNeeded },
            }).sort({ completedAt: -1 }).lean();
            const notScannedIds = new Set(notScannedPrompts.map((p) => p._id.toString()));
            const carryMap = new Map();
            for (const prevScan of prevScans) {
              for (const r of (prevScan.results || [])) {
                const pid = r.promptId?.toString();
                if (pid && notScannedIds.has(pid) && !carryMap.has(pid)) {
                  carryMap.set(pid, { ...r, _isCarryForward: true, _carryDate: prevScan.completedAt });
                }
              }
            }
            carryForwardResults = [...carryMap.values()];
          }

          // Combined: newly scanned (fresh) + carry-forward (historical, last known)
          const allEmailResults = [
            ...results.map((r) => ({ ...r, _isCarryForward: false })),
            ...carryForwardResults,
          ];

          const fakeScan = { results: allEmailResults, competitorResults: competitorResults || [] };
          const metrics = computeMetrics(fakeScan, allActivePrompts.length, undefined, tracker.domain) || {};
          // Platform stats reflect only current scan (represents actual API calls made this run)
          const platStats = computePlatformStats({ results, competitorResults: competitorResults || [] }, tracker.domain);
          const actionItems = generateActionItems(fakeScan);
          const sortedCompetitors = [...(competitorResults || [])].sort((a, b) => b.visibility - a.visibility);

          // Sentiment label
          const avgSentimentLabel = metrics.avgSentiment == null ? '—'
            : metrics.avgSentiment >= 60 ? `Positive (${metrics.avgSentiment})`
            : metrics.avgSentiment >= 40 ? `Neutral (${metrics.avgSentiment})`
            : `Negative (${metrics.avgSentiment})`;

          // Per-platform rows (current scan only).
          // platform names (p.name) come from PLATFORM_DISPLAY which is a
          // server-controlled constant — safe — but escape anyway for
          // defense-in-depth.
          const platformRows = platStats.map((p) => {
            const total = results.length - p.errorCount;
            const errorCell = p.errorCount > 0
              ? `<td style="padding:10px 16px;color:#ef4444;font-size:12px;">${p.errorCount} error${p.errorCount > 1 ? 's' : ''}</td>`
              : '<td></td>';
            return `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:10px 16px;font-weight:600;color:#111;font-size:13px;">${htmlEscape(p.name)}</td><td style="padding:10px 16px;color:#555;font-size:13px;">${p.visibility}%</td><td style="padding:10px 16px;color:#555;font-size:13px;">${p.mentionCount} / ${total}</td><td style="padding:10px 16px;color:#555;font-size:13px;">${p.citationCount}</td>${errorCell}</tr>`;
          }).join('');

          // Per-prompt rows: scanned-this-run first (green badge), then carry-forward (gray date)
          const promptRows = allEmailResults
            .map((r) => {
              const valid = r.platforms.filter((p) => !p.error);
              const mentioned = valid.filter((p) => p.mentioned).length;
              const cited = valid.filter((p) => p.cited).length;
              const mRate = valid.length > 0 ? Math.round((mentioned / valid.length) * 100) : 0;
              const cRate = valid.length > 0 ? Math.round((cited / valid.length) * 100) : 0;
              return { prompt: r.prompt, mentioned, total: valid.length, mRate, cRate, isCarryForward: r._isCarryForward, carryDate: r._carryDate };
            })
            .sort((a, b) => {
              if (a.isCarryForward !== b.isCarryForward) return a.isCarryForward ? 1 : -1;
              return b.mRate - a.mRate;
            })
            .map((r, i) => {
              // r.prompt is user-controlled (set during prompt CRUD). Escape
              // before embedding in <td> to prevent XSS via <style>, <img>,
              // event-handler payloads, etc. (F4-23)
              const truncated = r.prompt.length > 70 ? r.prompt.slice(0, 70) + '\u2026' : r.prompt;
              const safeShort = htmlEscape(truncated);
              const statusCell = r.isCarryForward
                ? `<td style="padding:9px 14px;white-space:nowrap;"><span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;background:#f1f5f9;color:#64748b;">${r.carryDate ? new Date(r.carryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'prev'}</span></td>`
                : `<td style="padding:9px 14px;white-space:nowrap;"><span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;background:#dcfce7;color:#15803d;">&#10003; New</span></td>`;
              return `<tr style="border-bottom:1px solid #f1f5f9;">${statusCell}<td style="padding:9px 14px;color:#94a3b8;font-size:12px;">${i + 1}</td><td style="padding:9px 14px;color:#111;font-size:13px;">${safeShort}</td><td style="padding:9px 14px;color:#555;font-size:13px;">${r.mentioned}/${r.total}</td><td style="padding:9px 14px;color:#555;font-size:13px;">${r.mRate}%</td><td style="padding:9px 14px;color:#555;font-size:13px;">${r.cRate}%</td></tr>`;
            })
            .join('');

          // Competitor rows (top 10). c.name is AI-extracted — Claude
          // controls it via prompt injection (F3-07 surface) — must escape.
          const competitorRows = sortedCompetitors.slice(0, 10).map((c, i) =>
            `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:9px 14px;color:#94a3b8;font-size:12px;">${i + 1}</td><td style="padding:9px 14px;color:#111;font-weight:600;font-size:13px;">${htmlEscape(c.name)}</td><td style="padding:9px 14px;color:#555;font-size:13px;">${c.mentions}</td><td style="padding:9px 14px;color:#555;font-size:13px;">${c.citations}</td><td style="padding:9px 14px;color:#555;font-size:13px;">${c.visibility}%</td></tr>`
          ).join('');

          // Action item rows (high priority first, max 5)
          const priOrder = { high: 0, medium: 1, low: 2 };
          const actionRows = actionItems
            .sort((a, b) => (priOrder[a.priority] || 0) - (priOrder[b.priority] || 0))
            .slice(0, 5)
            .map((item) => {
              // Action items are server-generated from PLATFORM_DISPLAY +
              // hardcoded templates, but escape for defense-in-depth in case
              // future generators incorporate user data.
              const bg = item.priority === 'high' ? '#ef4444' : item.priority === 'medium' ? '#f59e0b' : '#22c55e';
              return `<tr style="border-bottom:1px solid #f1f5f9;"><td style="padding:10px 14px;white-space:nowrap;"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;color:#fff;background:${bg};">${htmlEscape(item.priority)}</span></td><td style="padding:10px 14px;"><div style="color:#111;font-size:13px;font-weight:600;margin-bottom:2px;">${htmlEscape(item.title)}</div><div style="color:#64748b;font-size:12px;">${htmlEscape(item.description)}</div></td><td style="padding:10px 14px;color:#4f46e5;font-size:12px;font-weight:600;white-space:nowrap;">${htmlEscape(item.impact)}</td></tr>`;
            })
            .join('');

          // Invariant I1: tenant-facing links use the org's custom domain
          // when active (falls back to FRONTEND_URL for org-less workspaces).
          const appUrl = await require('../services/domainService').resolveBaseUrl(
            ws?.organizationId
          );
          const dashboardUrl = `${appUrl}/workspace/${ws?.workspaceNumber || 1}/ai-tracker`;

          // Pre-escape template variables that hold user-controlled strings.
          // The downstream template engine may render `{{var}}` as raw HTML
          // (some engines do this for plain `{{}}`; safer ones use `{{{}}}`
          // for raw). Either way, escaping here is defense-in-depth (F4-23).
          const emailOptions = {
            to: owner.email,
            fromName: 'SupaRank',
            orgId: ws?.organizationId || null, // Phase 11 sender identity
            data: {
              userName: htmlEscape(owner.profile?.name || owner.email.split('@')[0]),
              trackerName: htmlEscape(tracker.name || tracker.domain),
              domain: htmlEscape(tracker.domain),
              scanDate: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
              promptsScanned: results.length === allActivePrompts.length
                ? `${results.length} scanned`
                : `${results.length} scanned, ${carryForwardResults.length} from history`,
              visibility: metrics.visibility || 0,
              mentionRate: metrics.mentionRate || 0,
              shareOfVoice: metrics.shareOfVoice || 0,
              citationRate: metrics.citationRate || 0,
              avgSentiment: avgSentimentLabel,
              platformRows,
              promptRows,
              competitorRows: competitorRows || '<tr><td colspan="5" style="padding:12px 14px;color:#94a3b8;font-size:13px;">No competitors detected</td></tr>',
              actionRows: actionRows || '<tr><td colspan="3" style="padding:12px 14px;color:#94a3b8;font-size:13px;">No actions at this time</td></tr>',
              dashboardUrl,
            },
          };
          // F4-11: retry-with-backoff on send. Transient SMTP failures
          // shouldn't silently lose scan-summary emails the user paid for.
          await applyCustomTemplate('scan_completed', emailOptions, ws?.organizationId || null);
          const maxAttempts = 3;
          let sendErr = null;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
              await sendEmail(emailOptions);
              sendErr = null;
              break;
            } catch (e) {
              sendErr = e;
              if (attempt < maxAttempts - 1) {
                const delay = 2000 * Math.pow(2, attempt); // 2s, 4s
                console.warn(`[ai-tracker-scan] email send failed (attempt ${attempt + 1}/${maxAttempts}) for tracker ${trackerId}: ${e.message}; retrying in ${delay}ms`);
                await new Promise((r) => setTimeout(r, delay));
              }
            }
          }
          if (sendErr) {
            // All attempts exhausted — surface the final failure with stack
            // for SMTP diagnosis. The outer email-block catch will swallow this
            // so the scan still completes; user can't retry from UI today.
            throw sendErr;
          }
          console.log(`[ai-tracker-scan] sent scan summary email to ${owner.email} for tracker ${trackerId}`);
        }
      }
    } catch (emailErr) {
      console.error(`[ai-tracker-scan] failed to send scan summary email for tracker ${trackerId}:`, emailErr.message);
    }
  } catch (err) {
    console.error('[ai-tracker-scan] error:', err.message);

    // Refund pre-deducted credits on failure
    if (creditTxId) {
      await creditService.refund(creditTxId).catch((refundErr) => {
        console.error(`[ai-tracker-scan] refund failed for tracker ${trackerId}:`, refundErr.message);
      });
    }

    // Mark the AiTrackerScan doc failed if one was created — otherwise it
    // stays in 'running' (its schema default) and never reaches a terminal state.
    if (scanDocId) {
      await AiTrackerScan.findByIdAndUpdate(scanDocId, {
        $set: { status: 'failed', completedAt: new Date() },
      }).catch((e) => console.error(`[ai-tracker-scan] failed to mark scan doc failed for tracker ${trackerId}:`, e.message));
    }

    // Schedule retry in 1 hour so the cron auto-recovers transient failures.
    // Scaled by _devTimeScale so dev-mode retries don't wait a real hour.
    const retryAt = new Date(Date.now() + (60 * 60 * 1000) / (_devTimeScale || 1));
    await AiTracker.findByIdAndUpdate(trackerId, {
      $set: { scanStatus: 'failed', scanError: (err.message || 'Scan failed').slice(0, 500), currentScanId: null, nextScanAt: retryAt },
    }).catch((e) => console.error(`[ai-tracker-scan] failed to update scan failure status for tracker ${trackerId}:`, e.message));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED: Build full dashboard response for a tracker
// ═══════════════════════════════════════════════════════════════════════════

async function buildDashboardResponse(tracker) {
  // F20-01: include locked prompts too. The ManagePromptsView component
  // imports and renders LockedSectionBanner + LockedBadge (components/ManagePromptsView.tsx:409-446)
  // expecting locked prompts to be present in the dashboard response, but
  // the prior `locked: { $ne: true }` filter stripped them — leaving the
  // locked-section UI as dead code and users on a post-downgrade tracker
  // with no indication that their previously-created prompts are archived.
  // Now we fetch all prompts and let the frontend section-render them.
  // `activePromptCount` continues to exclude locked so metrics stay accurate.
  const prompts = await AiTrackerPrompt.find({ trackerId: tracker._id }).limit(500);
  const activePromptCount = prompts.filter(p => p.active !== false && !p.locked).length;

  // recentScans (limit 12): used for trend chart and latestScan/previousScan references
  const recentScans = await AiTrackerScan.find({
    trackerId: tracker._id,
    status: 'ready',
  })
    .sort({ completedAt: -1 })
    .limit(12)
    .lean();

  // carryScans: anchored on oldest lastScannedAt so carry-forward never loses slow-frequency prompts.
  // A monthly prompt last scanned 30 days ago will always be found, regardless of scan volume since then.
  //
  // F18-03: clamp to 90 days. Without this, a corrupted `lastScannedAt`
  // (e.g. epoch 0 from a botched migration) would make the query scan ALL
  // historic ready scans for this tracker. 90 days is far longer than any
  // legitimate cadence (monthly = 30 days), so a real slow-frequency prompt
  // is still found while pathological data is bounded.
  // F20-01: exclude locked from the carry-forward anchor so a locked prompt's
  // stale lastScannedAt doesn't widen the carryScans window unnecessarily.
  // Locked prompts still appear in `trackedPrompts` for the ManagePromptsView
  // archive section; only the anchor calculation excludes them.
  const activePrompts = prompts.filter(p => p.active !== false && !p.locked && p.lastScannedAt);
  const NINETY_DAYS_AGO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  let oldestNeeded = activePrompts.length > 0
    ? activePrompts.reduce((min, p) => p.lastScannedAt < min ? p.lastScannedAt : min, activePrompts[0].lastScannedAt)
    : null;
  if (oldestNeeded && oldestNeeded < NINETY_DAYS_AGO) oldestNeeded = NINETY_DAYS_AGO;
  let carryScans = oldestNeeded
    ? await AiTrackerScan.find({
        trackerId: tracker._id,
        status: 'ready',
        completedAt: { $gte: oldestNeeded },
      }).sort({ completedAt: -1 }).lean()
    : recentScans;

  // Fallback: if carryScans query returned nothing (e.g. prompts' lastScannedAt is newer
  // than any scan's completedAt due to data cleanup, clock skew, or schema migration),
  // use recentScans instead.
  // F18-09: in this fallback path, carry-forward is silently capped to the
  // recentScans limit (12). Acceptable because the fallback only fires for
  // pathological data — typical traffic uses the unbounded carryScans query.
  if (carryScans.length === 0 && recentScans.length > 0) {
    carryScans = recentScans;
  }
  // F18-08 (documented residual): dashboard trend chart is bounded to
  // `recentScans.length` (≤12) while per-prompt charts in trackedPrompts
  // can extend to `carryScans.length` (≥12 when slow-frequency prompts
  // exist). Different windows are intentional — the dashboard chart is a
  // recency overview; per-prompt detail benefits from longer history.

  const latestScan = recentScans[0] || null;
  const previousScan = recentScans[1] || null;

  const metrics = computeMetrics(latestScan, activePromptCount, carryScans, tracker.domain);
  const trackedPrompts = formatTrackedPrompts(prompts, latestScan, previousScan, carryScans, tracker.domain);
  const formattedCompetitors = formatCompetitors(latestScan, previousScan, tracker.domain);

  // Merge in tracked competitors (created via POST /competitors). The dashboard
  // previously surfaced only auto-discovered ones (with synthetic `auto-N` ids),
  // so customer-added competitors were invisible despite existing in the DB.
  //
  // Collision policy: when a tracked competitor matches an auto-discovered one
  // by case-insensitive name, the TRACKED entry wins (real ObjectId so it can
  // be deleted/updated) but preserves the scan metrics from the auto entry.
  // Pre-fix the merge silently dropped the tracked entry — customers couldn't
  // manage their own tracked competitors that the scan also discovered.
  try {
    const trackedComps = await AiTrackerCompetitor.find({ trackerId: tracker._id })
      .select('_id name isOwn')
      .lean();
    const byName = new Map();
    for (let i = 0; i < formattedCompetitors.length; i++) {
      const key = (formattedCompetitors[i].name || '').toLowerCase();
      byName.set(key, i);
    }
    for (const tc of trackedComps) {
      const key = (tc.name || '').toLowerCase();
      const existingIdx = byName.get(key);
      if (existingIdx !== undefined) {
        // Collision: replace the auto entry's synthetic id with the real one,
        // mark as tracked, preserve metrics.
        const existing = formattedCompetitors[existingIdx];
        formattedCompetitors[existingIdx] = {
          ...existing,
          id: tc._id.toString(),
          isOwn: !!tc.isOwn || !!existing.isOwn,
          isTracked: true,
        };
      } else {
        formattedCompetitors.push({
          id: tc._id.toString(),
          name: tc.name,
          isOwn: !!tc.isOwn,
          mentions: 0,
          citations: 0,
          visibility: 0,
          isTracked: true,
        });
        byName.set(key, formattedCompetitors.length - 1);
      }
    }
  } catch (err) {
    console.error('[ai-tracker] failed to merge tracked competitors:', err.message);
  }

  const changes = computeChanges(latestScan, previousScan, carryScans);
  const trendData = computeTrendData(recentScans, carryScans);
  const actionItems = generateActionItems(latestScan);
  const platformStats = computePlatformStats(latestScan, tracker.domain);

  return {
    tracker: tracker.toTrackerState(),
    metrics,
    // Top-level count so the scanning view (F14-07) can show real numbers
    // during the first scan, when `metrics` is still null (no completed
    // scan to compute aggregates from) and `trackedPrompts` is empty
    // (formatTrackedPrompts only emits entries from the latest scan results).
    activePromptCount,
    availablePlatformIds: computeAvailablePlatformIds(tracker),
    trackedPrompts,
    competitors: formattedCompetitors,
    changes,
    trendData,
    actionItems,
    platformStats,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINT HANDLERS (legacy single-monitor)
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /:workspaceNumber/ai-tracker ─────────────────────────────────────

const getTracker = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await AiTracker.findOne({ workspaceId: workspace._id });
    if (!tracker) {
      return res.status(404).json({ error: 'AI Tracker not set up' });
    }

    res.json(await buildDashboardResponse(tracker));
  } catch (err) {
    console.error('getTracker error:', err.message);
    res.status(500).json({ error: 'Failed to fetch AI tracker data' });
  }
};

// ─── PUT /:workspaceNumber/ai-tracker ─────────────────────────────────────

const updateTracker = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { defaultModels } = req.body;

    const update = {};
    if (Array.isArray(defaultModels)) {
      // Validate against tier limit
      const validPlatformIds = PLATFORM_DISPLAY.map((p) => p.platformId);
      const filtered = defaultModels.filter((p) => validPlatformIds.includes(p));
      // F19-03: reject empty (or all-filtered-out) defaultModels. Without this,
      // `update.defaultModels = []` would re-trigger needsPlatformReselection
      // on the dashboard, looping the user back to the reselection screen
      // they just submitted. The frontend Save button is already gated on
      // `selected.size >= 1`, but a direct API call (or a payload of only
      // unknown platform IDs) could otherwise wedge the tracker.
      if (filtered.length === 0) {
        return res.status(400).json({ error: 'At least one valid platform must be selected' });
      }
      const orgId = workspace.organizationId;
      if (orgId) {
        const { config, tier } = await tierService.getOrgTierConfig(orgId);
        const maxPlatforms = config?.maxAiTrackerPlatforms ?? validPlatformIds.length;
        if (filtered.length > maxPlatforms) {
          return res.status(400).json({
            error: `Your ${tier} plan allows up to ${maxPlatforms} AI platform${maxPlatforms !== 1 ? 's' : ''}`,
            code: 'PLATFORM_LIMIT',
            quota: { limit: maxPlatforms, requested: filtered.length, tier },
          });
        }
      }
      update.defaultModels = filtered;
      // F19-04: when this update is a reselection recovery (the tracker had
      // empty defaultModels before), pull nextScanAt to now so cron picks
      // up on the very next tick instead of leaving the user staring at a
      // stale schedule from before the downgrade. For routine reorderings
      // of an already-non-empty list, leave nextScanAt alone.
      if (!Array.isArray(tracker.defaultModels) || tracker.defaultModels.length === 0) {
        update.nextScanAt = new Date();
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const doc = await AiTracker.findByIdAndUpdate(tracker._id, { $set: update }, { new: true });

    res.json({ tracker: doc.toTrackerState() });
  } catch (err) {
    console.error('updateTracker error:', err.message);
    res.status(500).json({ error: 'Failed to update tracker' });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/suggest-prompts ────────────────────

function buildDefaultSuggestions(domain) {
  const brand = domain ? domain.replace(/^(https?:\/\/)?(www\.)?/, '').split('.')[0] : 'brand';
  return [
    { prompt: `what is ${brand}`, category: 'brand', reason: `Baseline: checks if AI knows about ${brand}` },
    { prompt: `best ${brand} alternatives`, category: 'comparison', reason: 'Users comparing options in your category' },
    { prompt: `${brand} vs competitors`, category: 'comparison', reason: 'Direct comparison queries' },
    { prompt: `is ${brand} worth it`, category: 'brand', reason: 'Purchase-intent query about your brand' },
    { prompt: `top tools like ${brand}`, category: 'industry', reason: 'Category-level discovery query' },
    { prompt: `${brand} reviews and pricing`, category: 'feature', reason: 'Users evaluating your product' },
    { prompt: `best free alternatives to ${brand}`, category: 'comparison', reason: 'Price-sensitive users exploring options' },
    { prompt: `how does ${brand} work`, category: 'feature', reason: 'Users researching your product functionality' },
  ];
}

// Simple in-memory rate limiter for suggestPrompts (max 5 calls per 60s per workspace)
const _suggestRateMap = new Map();
const SUGGEST_RATE_LIMIT = 5;
const SUGGEST_RATE_WINDOW = 60000;
// Prune stale entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  try {
    const now = Date.now();
    for (const [key, entry] of _suggestRateMap) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < SUGGEST_RATE_WINDOW);
      if (entry.timestamps.length === 0) _suggestRateMap.delete(key);
    }
  } catch (err) {
    console.error('[ai-tracker] rate limiter cleanup failed:', err.message);
  }
}, 5 * 60 * 1000).unref();

const suggestPrompts = async (req, res) => {
  try {
    const workspace = req.workspace;

    // Rate limit: max 5 requests per 60s per workspace
    const rateKey = workspace._id.toString();
    const now = Date.now();
    const entry = _suggestRateMap.get(rateKey) || { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => now - t < SUGGEST_RATE_WINDOW);
    if (entry.timestamps.length >= SUGGEST_RATE_LIMIT) {
      return res.status(429).json({ error: 'Too many suggestion requests. Please wait a minute.' });
    }
    entry.timestamps.push(now);
    _suggestRateMap.set(rateKey, entry);

    const { domain } = req.body;
    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    const domainTrimmed = domain.trim();
    if (domainTrimmed.length > 253 || domainTrimmed.includes(' ') || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domainTrimmed)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const apiKey = process.env.CHATGPT_API_KEY;
    if (!apiKey) {
      return res.json({ suggestions: buildDefaultSuggestions(domainTrimmed) });
    }

    const suggestSystemPrompt = `You are an AI visibility analyst. Given a website domain, use web search to look up the domain and identify the brand name and the industry/category it belongs to. Then suggest 8 search prompts that real users would type into AI assistants (ChatGPT, Gemini, Claude, Perplexity).

The goal is to measure ORGANIC visibility — whether AI naturally recommends this brand when users ask about the category, NOT whether AI mentions the brand when users ask about the brand directly.

Return a JSON object with a "suggestions" key containing an array of exactly 8 items:
{"suggestions": [{"prompt": "the search prompt", "category": "brand", "reason": "why this prompt matters"}]}

Categories: brand, feature, comparison, industry.
- brand: ONE baseline query that mentions the brand name (e.g. "what is [brand]") — to check if AI knows about it at all
- feature: queries about problems/needs the brand solves, WITHOUT naming the brand
- comparison: queries comparing options in the category, WITHOUT naming the brand
- industry: broader category/industry queries where the brand could naturally appear

PROMPT MIX RULES:
- EXACTLY 1 prompt should mention the brand name (the "brand" category baseline)
- The other 7 prompts must be CATEGORY-LEVEL queries that do NOT mention the brand name
- Category-level prompts must use specific industry/category terms (e.g. "best SEO tools", "project management software for remote teams", "cloud hosting providers")
- NEVER use generic placeholders like "your industry", "your product", "your brand", "this space"
- Prompts must be self-contained and specific enough that an AI assistant can give a concrete answer

Examples for suparank.com (SEO/AI visibility tool):
- Brand (1 only): "what is Suparank"
- Category: "best SEO tools for small businesses"
- Category: "how to track AI search visibility"
- Category: "SEO vs AEO what's the difference"
- Category: "best tools to monitor brand mentions in AI responses"
- BAD: "best Suparank alternatives" (brand-biased — AI will always mention it)
- BAD: "Suparank review" (brand-biased)
- BAD: "best tools in your industry" (placeholder)`;

    // Helper: validate and extract suggestions from raw parsed JSON
    const validateSuggestions = (parsed) => {
      const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : Array.isArray(parsed) ? parsed : [];
      return suggestions
        .filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim())
        .slice(0, 8)
        .map((s) => ({
          prompt: s.prompt.trim(),
          category: ['brand', 'feature', 'comparison', 'industry'].includes(s.category) ? s.category : 'industry',
          reason: typeof s.reason === 'string' ? s.reason.slice(0, 200) : 'Relevant to your brand visibility',
        }));
    };

    // Primary: Responses API with web_search (can look up unknown domains)
    let valid = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          instructions: suggestSystemPrompt,
          input: `Domain: ${domainTrimmed}`,
          tools: [{ type: 'web_search', search_context_size: 'low' }],
          text: { format: { type: 'json_object' } },
          store: false,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        const data = await response.json();
        // Extract text content from Responses API output
        let content = '';
        for (const item of (data.output || [])) {
          if (item.type === 'message' && item.content) {
            for (const part of item.content) {
              if (part.type === 'output_text') content += part.text;
            }
          }
        }
        if (content) {
          try {
            valid = validateSuggestions(JSON.parse(content));
          } catch { /* parse failed, will try fallback */ }
        }
      } else {
        console.warn('[suggest-prompts] Responses API error:', response.status);
      }
    } catch (err) {
      console.warn('[suggest-prompts] Responses API failed:', err.message);
    } finally {
      clearTimeout(timeout);
    }

    // Fallback: Chat Completions (no web search, works for well-known domains)
    if (valid.length === 0) {
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 30000);
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: suggestSystemPrompt },
              { role: 'user', content: `Domain: ${domainTrimmed}` },
            ],
            response_format: { type: 'json_object' },
          }),
          signal: controller2.signal,
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content;
          if (content) {
            try {
              valid = validateSuggestions(JSON.parse(content));
            } catch { /* parse failed */ }
          }
        } else {
          console.warn('[suggest-prompts] Chat Completions error:', response.status);
        }
      } catch (err) {
        console.warn('[suggest-prompts] Chat Completions failed:', err.message);
      } finally {
        clearTimeout(timeout2);
      }
    }

    res.json({ suggestions: valid.length > 0 ? valid : buildDefaultSuggestions(domainTrimmed) });
  } catch (err) {
    console.error('suggestPrompts error:', err.message);
    const fallbackDomain = req.body?.domain?.trim() || null;
    res.json({ suggestions: buildDefaultSuggestions(fallbackDomain) });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/setup ──────────────────────────────

const setup = async (req, res) => {
  // F1-06: hoisted to function scope (not inside the try) so the outer catch
  // can also invoke it. Any unhandled error between the quota increment and
  // a structured failure path (e.g. a DB hiccup during the name-conflict
  // findOne) escapes to the catch — without this we'd leak the quota.
  let promptQuotaRollback = null;
  try {
    const workspace = req.workspace;

    const { domain, name, prompts, platforms } = req.body;

    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'Domain is required' });
    }
    const domainTrimmed = domain.trim();
    if (domainTrimmed.length > 253 || domainTrimmed.includes(' ') || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domainTrimmed)) {
      return res.status(400).json({ error: 'Please enter a valid domain (e.g. example.com)' });
    }
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: 'At least one prompt is required' });
    }
    // Reject submissions where every prompt is empty/whitespace — would otherwise
    // provision an empty tracker silently after passing the length-> 0 check.
    const nonEmptyPromptCount = prompts.filter((p) => typeof p === 'string' && p.trim().length > 0).length;
    if (nonEmptyPromptCount === 0) {
      return res.status(400).json({ error: 'At least one non-empty prompt is required' });
    }
    // F1-07: cap monitor name length. Without this the frontend cap (maxLength=100)
    // was the only guard; a direct API caller could submit megabytes of name text
    // which Mongo would error on or silently truncate. 100 chars matches the UI cap.
    if (name != null && typeof name === 'string' && name.trim().length > 100) {
      return res.status(400).json({ error: 'Monitor name must be 100 characters or fewer' });
    }

    // Validate platforms and monitor count against tier limits
    const validPlatformIds = PLATFORM_DISPLAY.map((p) => p.platformId);
    let selectedPlatforms = validPlatformIds; // default: all
    const orgId = workspace.organizationId;
    let tierConfig = null;
    let tierName = 'free';
    if (orgId) {
      const { config, tier } = await tierService.getOrgTierConfig(orgId);
      tierConfig = config;
      tierName = tier;

      // Check monitor count limit (per workspace, tier from org)
      if (config?.maxAiTrackerMonitors != null) {
        const monitorCount = await AiTracker.countDocuments({ workspaceId: workspace._id });
        if (monitorCount >= config.maxAiTrackerMonitors) {
          return res.status(429).json({
            error: `Your ${tier} plan allows up to ${config.maxAiTrackerMonitors} AI Tracker monitor${config.maxAiTrackerMonitors !== 1 ? 's' : ''} per workspace`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: config.maxAiTrackerMonitors, used: monitorCount, tier, limitKey: 'maxAiTrackerMonitors' },
          });
        }
      }

      // Check prompt quota (atomic: increment first, rollback if over)
      const promptCount = prompts.filter((p) => typeof p === 'string' && p.trim()).length;
      if (config?.maxAiTrackerPromptsPerMonth != null && promptCount > 0) {
        const limitType = config.aiTrackerPromptLimitType || 'monthly';
        let newTotal;
        if (limitType === 'lifetime' && req.user?.userId) {
          const doc = await UserUsageTracker.increment(req.user.userId, 'aiTrackerPromptsCreated', promptCount);
          newTotal = doc?.aiTrackerPromptsCreated ?? promptCount;
        } else {
          const period = tierService.getPeriod(limitType);
          const doc = await UsageTracker.increment(orgId, 'aiTrackerPromptsCreated', period, promptCount);
          newTotal = doc?.aiTrackerPromptsCreated ?? promptCount;
        }
        // F1-06: assign rollback closure so later failure paths can undo
        // this increment. Self-nulling so a second call is a no-op.
        const userId = req.user?.userId;
        promptQuotaRollback = async () => {
          promptQuotaRollback = null;
          try {
            if (limitType === 'lifetime' && userId) {
              await UserUsageTracker.increment(userId, 'aiTrackerPromptsCreated', -promptCount);
            } else {
              const period2 = tierService.getPeriod(limitType);
              await UsageTracker.increment(orgId, 'aiTrackerPromptsCreated', period2, -promptCount);
            }
          } catch (rbErr) {
            console.error('[ai-tracker-setup] prompt quota rollback failed:', rbErr.message);
          }
        };
        if (newTotal > config.maxAiTrackerPromptsPerMonth) {
          await promptQuotaRollback();
          const used = newTotal - promptCount;
          return res.status(429).json({
            error: `Your ${tier} plan allows ${config.maxAiTrackerPromptsPerMonth} AI Tracker prompts (${used} used, ${promptCount} requested)`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: config.maxAiTrackerPromptsPerMonth, used, tier, limitKey: 'maxAiTrackerPromptsPerMonth' },
          });
        }
      }

      // Validate platform count
      const maxPlatforms = config?.maxAiTrackerPlatforms ?? validPlatformIds.length;
      if (Array.isArray(platforms) && platforms.length > 0) {
        selectedPlatforms = platforms.filter((p) => validPlatformIds.includes(p));
        if (selectedPlatforms.length > maxPlatforms) {
          // F1-06: roll back the prompt-quota increment before the 400.
          if (promptQuotaRollback) await promptQuotaRollback();
          return res.status(400).json({
            error: `Your ${tier} plan allows up to ${maxPlatforms} AI platform${maxPlatforms !== 1 ? 's' : ''}`,
            code: 'PLATFORM_LIMIT',
            quota: { limit: maxPlatforms, requested: selectedPlatforms.length, tier },
          });
        }
      } else {
        selectedPlatforms = validPlatformIds.slice(0, maxPlatforms);
      }
    }

    let monitorName = (name && typeof name === 'string' && name.trim()) ? name.trim() : domain.trim();

    // Check if monitor with same name already exists — auto-suffix if needed
    const existing = await AiTracker.findOne({ workspaceId: workspace._id, name: monitorName });
    if (existing) {
      // Try appending a number suffix to make it unique
      let suffix = 2;
      let candidate = `${monitorName} (${suffix})`;
      while (await AiTracker.findOne({ workspaceId: workspace._id, name: candidate })) {
        suffix++;
        candidate = `${monitorName} (${suffix})`;
        if (suffix > 20) {
          // F1-06: roll back the prompt-quota increment before returning.
          if (promptQuotaRollback) await promptQuotaRollback();
          return res.status(409).json({ error: 'A monitor with this name already exists. Please choose a different name.' });
        }
      }
      monitorName = candidate;
    }

    // Create tracker.
    // nextScanAt is set to now so that if the fire-and-forget first scan
    // crashes before reaching B13 (which sets nextScanAt), the next cron
    // tick still selects this tracker for recovery.
    let tracker;
    try {
      tracker = await AiTracker.create({
        workspaceId: workspace._id,
        name: monitorName,
        domain: domain.trim(),
        defaultModels: selectedPlatforms,
        scanStatus: 'pending',
        nextScanAt: new Date(),
      });
    } catch (createErr) {
      // F1-06: roll back the prompt-quota increment on any tracker create failure.
      if (promptQuotaRollback) await promptQuotaRollback();
      if (createErr.code === 11000) {
        return res.status(409).json({ error: 'A monitor with this name already exists. Please choose a different name.' });
      }
      throw createErr;
    }

    // Create prompts.
    // F1-05: if prompt insertion fails (non-11000), the tracker was already
    // created — clean it up so we don't leave an orphan with zero prompts
    // that the user can't recover from. Also roll back the quota increment.
    const promptDocs = prompts
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => ({ trackerId: tracker._id, prompt: p.trim() }));
    if (promptDocs.length > 0) {
      try {
        await AiTrackerPrompt.insertMany(promptDocs, { ordered: false });
      } catch (insertErr) {
        if (insertErr.code !== 11000) {
          await AiTracker.deleteOne({ _id: tracker._id }).catch((e) =>
            console.error('[ai-tracker-setup] orphan tracker cleanup failed:', e.message));
          if (promptQuotaRollback) await promptQuotaRollback();
          throw insertErr;
        }
      }
    }

    // Usage already incremented atomically above (no separate increment needed)

    // Competitors are now fully auto-detected by the scan engine from AI responses

    // Fire-and-forget: start first scan (pass userId so user free credits can be used).
    // The .catch is a safety net for synchronous-throw paths only; once executeScan
    // returns its promise, errors are handled inside the function's outer try/catch.
    executeScan(tracker._id, req.user?.userId, { force: true }).catch((err) => {
      console.error('[ai-tracker-setup] scan kickoff failed:', err.message);
    });

    res.status(201).json({
      trackerId: tracker._id.toString(),
      scanStatus: 'pending',
    });
  } catch (err) {
    // F1-06: roll back any uncovered quota increment that escaped via an
    // unhandled error path (e.g. DB hiccup during the name-conflict findOne).
    // The closure self-nulls so this is a no-op if a structured path already
    // invoked it.
    if (promptQuotaRollback) await promptQuotaRollback();
    console.error('setup error:', err.message);
    res.status(500).json({ error: 'Failed to set up AI tracker' });
  }
};

// ─── GET /:workspaceNumber/ai-tracker/scan ────────────────────────────────

// Compute the runtime platform list (defaultModels ∩ env-keys-present) so the
// scanning UI can hide platforms that will never run due to missing API keys.
// Without this, a chatgpt-disabled tracker showed chatgpt stuck "queued"
// forever in the scanning view (F14-03).
function computeAvailablePlatformIds(tracker) {
  const env = getAvailablePlatformIdsSilent();
  const dm = Array.isArray(tracker.defaultModels) ? tracker.defaultModels : [];
  return env.filter((id) => dm.includes(id));
}

const getScanStatus = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    res.json({
      status: tracker.scanStatus,
      progress: tracker.scanProgress,
      platformStatuses: tracker.platformStatuses || [],
      availablePlatformIds: computeAvailablePlatformIds(tracker),
      ...(tracker.scanError ? { error: tracker.scanError } : {}),
    });
  } catch (err) {
    console.error('getScanStatus error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scan status' });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/scan ───────────────────────────────

const triggerScan = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    // Recover any scans stuck for 30+ minutes before checking limits
    await recoverStuckScans(tracker.workspaceId);

    // Check if scan is already in progress on this tracker
    if (tracker.scanStatus === 'pending' || tracker.scanStatus === 'scanning') {
      return res.status(409).json({ error: 'A scan is already in progress' });
    }

    // Workspace-level concurrent scan cap (max 2 simultaneous scans).
    //
    // F4-04: this is a check-then-act race. N≥3 concurrent triggers on
    // distinct trackers in the same workspace can all observe count=0 and
    // all proceed to flip to 'pending', exceeding the cap by N-2.
    //
    // Mitigation here: tighten the count by excluding self. This is a no-op
    // for the primary race (self is in 'ready' at this point, so original
    // count was already exclusive) but makes the semantics explicit and
    // documents the bound for future readers.
    //
    // Full fix (deferred): requires either a MongoDB transaction wrapping
    // count + pending-flip, or a per-workspace atomic counter document.
    // Both add complexity not justified by current user concurrency
    // patterns (single user, <3 simultaneous tabs).
    //
    // Practical bound today: "cap + N-1 within the race window (~ms)".
    // For N=3 simultaneous clicks across 3 trackers, all 3 may run.
    // Cost impact: a few extra credits per incident.
    const otherActiveScans = await AiTracker.countDocuments({
      workspaceId: tracker.workspaceId,
      _id: { $ne: tracker._id },
      scanStatus: { $in: ['pending', 'scanning'] },
    });
    if (otherActiveScans >= 2) {
      return res.status(429).json({ error: 'Too many scans running in this workspace. Please wait for a scan to finish.' });
    }

    // Rate limit: at least 1 hour between scans (skip in development)
    const isDev = process.env.NODE_ENV === 'development';
    if (!isDev && tracker.lastScanAt) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (tracker.lastScanAt > hourAgo) {
        return res.status(429).json({ error: 'Please wait at least 1 hour between scans' });
      }
    }

    // Pre-check credit affordability so we can return 402 immediately.
    // Actual deduction happens inside executeScan (shared with cron path).
    // Count only the prompts that will actually run (active + unlocked) so
    // inactive/locked prompts don't inflate the estimate and block scans
    // the user can afford.
    if (req.creditContext?.deductionEnabled) {
      const prompts = await AiTrackerPrompt.countDocuments({
        trackerId: tracker._id,
        active: { $ne: false },
        locked: { $ne: true },
      });
      const platforms = tracker.defaultModels?.length || 0;
      const estimatedCredits = Math.max(1, prompts * platforms * 4);
      const canPay = await creditService.canAfford(req.creditContext.orgId, estimatedCredits, req.user?.userId);
      if (!canPay) {
        return res.status(402).json({
          error: 'Insufficient credits',
          code: 'INSUFFICIENT_CREDITS',
          estimatedCredits,
        });
      }
    }

    // Set to pending — executeScan atomically claims it to prevent double-execution
    await AiTracker.findByIdAndUpdate(tracker._id, {
      $set: { scanStatus: 'pending', scanProgress: 0, scanError: null },
    });

    // executeScan handles its own errors via Phase H; the .catch here only
    // catches a synchronous throw before the first await (essentially never).
    executeScan(tracker._id, req.user?.userId, { force: true }).catch((err) => {
      console.error('[ai-tracker-scan] manual scan kickoff failed:', err.message);
    });

    res.json({ scanStatus: 'pending' });
  } catch (err) {
    console.error('triggerScan error:', err.message);
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/prompts ───────────────────────────

const addPrompt = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { prompt, models, frequency } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    if (prompt.trim().length > 500) {
      return res.status(400).json({ error: 'Prompt must be 500 characters or fewer' });
    }

    // Sanitize models to only valid platform IDs
    const VALID_PLATFORMS = ['chatgpt', 'gemini', 'claude', 'perplexity'];
    const sanitizedModels = Array.isArray(models) && models.length > 0
      ? models.filter((m) => VALID_PLATFORMS.includes(m))
      : undefined;

    if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ error: `Invalid frequency. Must be one of: ${VALID_FREQUENCIES.join(', ')}` });
    }
    if (frequency === 'Daily' && !(await isDailyFrequencyAllowed(workspace))) {
      return res.status(403).json({ error: 'Daily frequency requires a Professional or Agency plan' });
    }

    // Check duplicate — block if prompt already exists (active or inactive)
    const existing = await AiTrackerPrompt.findOne({
      trackerId: tracker._id,
      prompt: prompt.trim(),
    });
    if (existing) {
      return res.status(409).json({ error: 'This prompt is already being tracked' });
    }

    // F5-04: cache the tier config once instead of looking it up twice (cap
    // check + createdOnPlan derivation). Both call sites previously hit
    // tierService independently on the addPrompt hot path.
    let tierInfo = null;
    if (workspace.organizationId) {
      tierInfo = await tierService.getOrgTierConfig(workspace.organizationId);
    }

    // F4-15: enforce per-monitor prompt cap. Previously, executeScan did
    // `.limit(500)` which silently truncated the back half of any tracker
    // that exceeded 500 active+unlocked prompts. Reject at create time so the
    // user knows their cap rather than discovering missing scan data later.
    if (tierInfo) {
      const { config, tier } = tierInfo;
      const cap = config?.maxAiTrackerPromptsPerMonitor;
      if (cap != null) {
        const active = await AiTrackerPrompt.countDocuments({
          trackerId: tracker._id,
          active: { $ne: false },
          locked: { $ne: true },
        });
        if (active >= cap) {
          return res.status(429).json({
            error: `Your ${tier} plan allows up to ${cap} active prompts per monitor`,
            code: 'PROMPT_CAP_REACHED',
            quota: { limit: cap, used: active, tier, limitKey: 'maxAiTrackerPromptsPerMonitor' },
          });
        }
      }
    }

    // F5-01: derive createdOnPlan from the middleware-validated
    // `req.tierQuota.isUserLevel` signal, NOT from the raw `req.body.quotaSource`.
    // Pre-fix the body was trusted, letting a paid user submit `quotaSource: 'free'`
    // on every prompt → all marked `createdOnPlan: 'free'` → downgradeService
    // (lines 243-246) skipped them on downgrade (filter requires
    // `createdOnPlan: 'paid'`). Net effect: paid user kept every prompt active
    // after canceling. tierEnforcement middleware validates the claim and exposes
    // `isUserLevel: true` only after the validation passes.
    let createdOnPlan = 'free';
    if (req.tierQuota?.isUserLevel) {
      createdOnPlan = 'free';
    } else if (tierInfo) {
      createdOnPlan = tierInfo.tier === 'free' ? 'free' : 'paid';
    }

    const doc = await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: prompt.trim(),
      ...(sanitizedModels && sanitizedModels.length > 0 ? { models: sanitizedModels } : {}),
      ...(frequency ? { frequency } : {}),
      createdOnPlan,
    });

    // Track prompt creation against tier quota
    if (req.tierQuota) {
      await tierService.incrementQuota(req.tierQuota);
    }

    res.status(201).json({ id: doc._id.toString(), prompt: doc.prompt });
  } catch (err) {
    console.error('addPrompt error:', err.message);
    res.status(500).json({ error: 'Failed to add prompt' });
  }
};

// ─── DELETE /:workspaceNumber/ai-tracker/prompts/:promptId ───────────────

const removePrompt = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
    if (!isValidObjectId(promptId)) return res.status(400).json({ error: 'Invalid prompt ID' });

    const deleted = await AiTrackerPrompt.findOneAndDelete({
      _id: promptId,
      trackerId: tracker._id,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('removePrompt error:', err.message);
    res.status(500).json({ error: 'Failed to remove prompt' });
  }
};

// ─── PUT /:workspaceNumber/ai-tracker/prompts/:promptId ──────────────────

const updatePrompt = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
    if (!isValidObjectId(promptId)) return res.status(400).json({ error: 'Invalid prompt ID' });

    const { models, frequency, active } = req.body;

    const VALID_PLATFORMS = ['chatgpt', 'gemini', 'claude', 'perplexity'];
    const update = {};
    if (Array.isArray(models)) update.models = models.filter((m) => VALID_PLATFORMS.includes(m));
    if (frequency !== undefined) {
      if (!VALID_FREQUENCIES.includes(frequency)) {
        return res.status(400).json({ error: `Invalid frequency. Must be one of: ${VALID_FREQUENCIES.join(', ')}` });
      }
      if (frequency === 'Daily' && !(await isDailyFrequencyAllowed(workspace))) {
        return res.status(403).json({ error: 'Daily frequency requires a Professional or Agency plan' });
      }
      update.frequency = frequency;
    }
    // F5-06: validate `active` is strictly boolean. Pre-fix accepted any value
    // (object, array, number) which Mongoose strict mode would error on or
    // silently coerce — depending on schema config. Explicit reject is cleaner.
    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: '`active` must be a boolean' });
      }
      update.active = active;
    }

    // See updateMonitorPrompt for the prompt-immutable rationale + form-fill tolerance.
    if (Object.keys(update).length === 0) {
      if (req.body.prompt !== undefined) {
        return res.status(400).json({
          error: 'Prompt text cannot be edited after creation. Delete this prompt and add a new one with the corrected text.',
          code: 'PROMPT_TEXT_IMMUTABLE',
        });
      }
      return res.status(400).json({ error: 'No fields to update' });
    }

    // F5-02: when reactivating an inactive prompt, re-run the per-monitor cap
    // check. Pre-fix the cycle "create N active → deactivate all → create N
    // more → reactivate the originals" silently bypassed the cap. We load the
    // doc first to know its current `active` state.
    if (active === true && workspace.organizationId) {
      const existing = await AiTrackerPrompt.findOne({ _id: promptId, trackerId: tracker._id }).select('active locked').lean();
      if (existing && existing.active === false) {
        const { config, tier } = await tierService.getOrgTierConfig(workspace.organizationId);
        const cap = config?.maxAiTrackerPromptsPerMonitor;
        if (cap != null) {
          const activeCount = await AiTrackerPrompt.countDocuments({
            trackerId: tracker._id,
            active: { $ne: false },
            locked: { $ne: true },
          });
          if (activeCount >= cap) {
            return res.status(429).json({
              error: `Your ${tier} plan allows up to ${cap} active prompts per monitor`,
              code: 'PROMPT_CAP_REACHED',
              quota: { limit: cap, used: activeCount, tier, limitKey: 'maxAiTrackerPromptsPerMonitor' },
            });
          }
        }
      }
    }

    const doc = await AiTrackerPrompt.findOneAndUpdate(
      { _id: promptId, trackerId: tracker._id },
      { $set: update },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    // If frequency changed to a shorter interval, pull nextScanAt forward on the tracker.
    //
    // F5-03: pre-fix this was a read-then-write race — `tracker.nextScanAt` was
    // captured at request entry, so a concurrent update setting nextScanAt to an
    // EARLIER value could be silently pushed back by our $set. Now the filter
    // requires nextScanAt to be null/missing OR strictly greater than our value
    // before the $set fires, so we never extend a sooner schedule.
    if (frequency !== undefined) {
      const FREQ_DAYS = { 'Daily': 1, 'Weekly': 7, 'Bi-weekly': 14, 'Monthly': 30 };
      const freqDays = FREQ_DAYS[frequency];
      const baseTime = doc.lastScannedAt ? doc.lastScannedAt.getTime() : Date.now();
      const promptNextDue = new Date(baseTime + freqDays * 24 * 60 * 60 * 1000);
      await AiTracker.findOneAndUpdate(
        {
          _id: tracker._id,
          $or: [
            { nextScanAt: null },
            { nextScanAt: { $exists: false } },
            { nextScanAt: { $gt: promptNextDue } },
          ],
        },
        { $set: { nextScanAt: promptNextDue } }
      );
    }

    res.json({
      id: doc._id.toString(),
      prompt: doc.prompt,
      models: doc.models,
      frequency: doc.frequency,
      active: doc.active,
    });
  } catch (err) {
    console.error('updatePrompt error:', err.message);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/prompts/bulk-delete ───────────────

const bulkDeletePrompts = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Cannot delete more than 500 prompts at once' });
    }
    if (!ids.every(isValidObjectId)) {
      return res.status(400).json({ error: 'All ids must be valid ObjectIds' });
    }

    const result = await AiTrackerPrompt.deleteMany({
      _id: { $in: ids },
      trackerId: tracker._id,
    });

    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error('bulkDeletePrompts error:', err.message);
    res.status(500).json({ error: 'Failed to delete prompts' });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/competitors ───────────────────────

const addCompetitor = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Competitor name is required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Competitor name must be 100 characters or fewer' });
    }

    const doc = await AiTrackerCompetitor.create({
      trackerId: tracker._id,
      name: name.trim(),
      isOwn: false,
    });

    res.status(201).json({ id: doc._id.toString(), name: doc.name });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This competitor is already being tracked' });
    }
    console.error('addCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to add competitor' });
  }
};

// ─── DELETE /:workspaceNumber/ai-tracker/competitors/:competitorId ───────

const removeCompetitor = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { competitorId } = req.params;
    if (!isValidObjectId(competitorId)) return res.status(400).json({ error: 'Invalid competitor ID' });

    const deleted = await AiTrackerCompetitor.findOneAndDelete({
      _id: competitorId,
      trackerId: tracker._id,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Competitor not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('removeCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to remove competitor' });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/competitors/dismiss ───────────────

const dismissSuggestedCompetitor = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Competitor name is required' });
    }

    const trimmed = name.trim();
    // Add to dismissedCompetitors if not already there
    if (!tracker.dismissedCompetitors.includes(trimmed)) {
      await AiTracker.findByIdAndUpdate(tracker._id, {
        $addToSet: { dismissedCompetitors: trimmed },
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('dismissSuggestedCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to dismiss competitor' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-MONITOR ENDPOINT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /:wn/ai-tracker/monitors ────────────────────────────────────────

const listMonitors = async (req, res) => {
  try {
    const workspace = req.workspace;

    const trackers = await AiTracker.find({ workspaceId: workspace._id })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();

    // Single aggregation query instead of N+1 countDocuments
    const promptCounts = await AiTrackerPrompt.aggregate([
      { $match: { trackerId: { $in: trackers.map((t) => t._id) } } },
      { $group: { _id: '$trackerId', count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(promptCounts.map((p) => [p._id.toString(), p.count]));

    const monitors = trackers.map((t) => ({
      id: t._id.toString(),
      name: t.name || t.domain,
      domain: t.domain,
      scanStatus: t.scanStatus,
      lastScanAt: t.lastScanAt ? t.lastScanAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
      promptCount: countMap[t._id.toString()] || 0,
    }));

    res.json({ monitors });
  } catch (err) {
    console.error('listMonitors error:', err.message);
    res.status(500).json({ error: 'Failed to list monitors' });
  }
};

// ─── POST /:wn/ai-tracker/monitors ──────────────────────────────────────

const createMonitor = async (req, res) => {
  // F1-06: hoisted to function scope so the outer catch can also invoke it
  // (see `setup` for full rationale).
  let promptQuotaRollback = null;
  try {
    const workspace = req.workspace;

    const { domain, name, prompts, platforms } = req.body;

    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'Domain is required' });
    }
    const domainTrimmed = domain.trim();
    if (domainTrimmed.length > 253 || domainTrimmed.includes(' ') || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(domainTrimmed)) {
      return res.status(400).json({ error: 'Please enter a valid domain (e.g. example.com)' });
    }
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: 'At least one prompt is required' });
    }
    // Reject submissions where every prompt is empty/whitespace.
    const nonEmptyPromptCount = prompts.filter((p) => typeof p === 'string' && p.trim().length > 0).length;
    if (nonEmptyPromptCount === 0) {
      return res.status(400).json({ error: 'At least one non-empty prompt is required' });
    }
    // F1-07: cap monitor name length (matches frontend `maxLength={100}`).
    if (name != null && typeof name === 'string' && name.trim().length > 100) {
      return res.status(400).json({ error: 'Monitor name must be 100 characters or fewer' });
    }

    // Validate platforms, monitor count, and prompt quota against tier limits
    const validPlatformIds = PLATFORM_DISPLAY.map((p) => p.platformId);
    let selectedPlatforms = validPlatformIds; // default: all
    const orgId = workspace.organizationId;
    let tierConfig = null;
    let tierName = 'free';
    if (orgId) {
      const { config, tier } = await tierService.getOrgTierConfig(orgId);
      tierConfig = config;
      tierName = tier;

      // Check monitor count limit (per workspace, tier from org)
      if (config?.maxAiTrackerMonitors != null) {
        const monitorCount = await AiTracker.countDocuments({ workspaceId: workspace._id });
        if (monitorCount >= config.maxAiTrackerMonitors) {
          return res.status(429).json({
            error: `Your ${tier} plan allows up to ${config.maxAiTrackerMonitors} AI Tracker monitor${config.maxAiTrackerMonitors !== 1 ? 's' : ''} per workspace`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: config.maxAiTrackerMonitors, used: monitorCount, tier, limitKey: 'maxAiTrackerMonitors' },
          });
        }
      }

      // Check prompt quota (atomic: increment first, rollback if over)
      const promptCount = prompts.filter((p) => typeof p === 'string' && p.trim()).length;
      if (config?.maxAiTrackerPromptsPerMonth != null && promptCount > 0) {
        const limitType = config.aiTrackerPromptLimitType || 'monthly';
        let newTotal;
        if (limitType === 'lifetime' && req.user?.userId) {
          const doc = await UserUsageTracker.increment(req.user.userId, 'aiTrackerPromptsCreated', promptCount);
          newTotal = doc?.aiTrackerPromptsCreated ?? promptCount;
        } else {
          const period = tierService.getPeriod(limitType);
          const doc = await UsageTracker.increment(orgId, 'aiTrackerPromptsCreated', period, promptCount);
          newTotal = doc?.aiTrackerPromptsCreated ?? promptCount;
        }
        // F1-06: assign rollback closure so later failure paths can undo
        // this increment. Self-nulling so a second call is a no-op.
        const userId = req.user?.userId;
        promptQuotaRollback = async () => {
          promptQuotaRollback = null;
          try {
            if (limitType === 'lifetime' && userId) {
              await UserUsageTracker.increment(userId, 'aiTrackerPromptsCreated', -promptCount);
            } else {
              const period2 = tierService.getPeriod(limitType);
              await UsageTracker.increment(orgId, 'aiTrackerPromptsCreated', period2, -promptCount);
            }
          } catch (rbErr) {
            console.error('[ai-tracker-setup] prompt quota rollback failed:', rbErr.message);
          }
        };
        if (newTotal > config.maxAiTrackerPromptsPerMonth) {
          await promptQuotaRollback();
          const used = newTotal - promptCount;
          return res.status(429).json({
            error: `Your ${tier} plan allows ${config.maxAiTrackerPromptsPerMonth} AI Tracker prompts (${used} used, ${promptCount} requested)`,
            code: 'QUOTA_EXCEEDED',
            quota: { limit: config.maxAiTrackerPromptsPerMonth, used, tier, limitKey: 'maxAiTrackerPromptsPerMonth' },
          });
        }
      }

      // Validate platform count
      const maxPlatforms = config?.maxAiTrackerPlatforms ?? validPlatformIds.length;
      if (Array.isArray(platforms) && platforms.length > 0) {
        selectedPlatforms = platforms.filter((p) => validPlatformIds.includes(p));
        if (selectedPlatforms.length > maxPlatforms) {
          // F1-06: roll back the prompt-quota increment before the 400.
          if (promptQuotaRollback) await promptQuotaRollback();
          return res.status(400).json({
            error: `Your ${tier} plan allows up to ${maxPlatforms} AI platform${maxPlatforms !== 1 ? 's' : ''}`,
            code: 'PLATFORM_LIMIT',
            quota: { limit: maxPlatforms, requested: selectedPlatforms.length, tier },
          });
        }
      } else {
        selectedPlatforms = validPlatformIds.slice(0, maxPlatforms);
      }
    }

    let monitorName = (name && typeof name === 'string' && name.trim()) ? name.trim() : domain.trim();

    // Check duplicate name — auto-suffix if needed
    console.log(`[createMonitor] workspaceId=${workspace._id}, monitorName="${monitorName}"`);
    const existing = await AiTracker.findOne({ workspaceId: workspace._id, name: monitorName });
    console.log(`[createMonitor] existing check result:`, existing ? `found _id=${existing._id} name="${existing.name}"` : 'null (no match)');
    if (existing) {
      let suffix = 2;
      let candidate = `${monitorName} (${suffix})`;
      while (await AiTracker.findOne({ workspaceId: workspace._id, name: candidate })) {
        suffix++;
        candidate = `${monitorName} (${suffix})`;
        if (suffix > 20) {
          if (promptQuotaRollback) await promptQuotaRollback();
          return res.status(409).json({ error: 'A monitor with this name already exists. Please choose a different name.' });
        }
      }
      monitorName = candidate;
      console.log(`[createMonitor] auto-suffixed to "${monitorName}"`);
    }

    // Create tracker.
    // nextScanAt set to now so a first-scan crash leaves the tracker still
    // visible to the cron sweep (F4-24 mitigation).
    let tracker;
    try {
      console.log(`[createMonitor] creating tracker: workspace=${workspace._id}, name="${monitorName}", domain="${domain.trim()}"`);
      tracker = await AiTracker.create({
        workspaceId: workspace._id,
        name: monitorName,
        domain: domain.trim(),
        defaultModels: selectedPlatforms,
        scanStatus: 'pending',
        nextScanAt: new Date(),
      });
      console.log(`[createMonitor] created successfully: _id=${tracker._id}`);
    } catch (createErr) {
      console.error(`[createMonitor] create error: code=${createErr.code}, message=${createErr.message}`);
      if (promptQuotaRollback) await promptQuotaRollback();
      if (createErr.code === 11000) {
        // Log indexes to diagnose stale unique constraints
        try { const idxs = await AiTracker.collection.indexes(); console.error('[createMonitor] collection indexes:', JSON.stringify(idxs)); } catch {}
        return res.status(409).json({ error: 'A monitor with this name already exists. Please choose a different name.' });
      }
      throw createErr;
    }

    // Create prompts (F1-05: clean up orphan tracker + roll back quota on failure).
    const promptDocs = prompts
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => ({ trackerId: tracker._id, prompt: p.trim() }));
    if (promptDocs.length > 0) {
      try {
        await AiTrackerPrompt.insertMany(promptDocs, { ordered: false });
      } catch (insertErr) {
        if (insertErr.code !== 11000) {
          await AiTracker.deleteOne({ _id: tracker._id }).catch((e) =>
            console.error('[createMonitor] orphan tracker cleanup failed:', e.message));
          if (promptQuotaRollback) await promptQuotaRollback();
          throw insertErr;
        }
      }
    }

    // Usage already incremented atomically above (no separate increment needed)

    // Competitors are now fully auto-detected by the scan engine from AI responses

    // Fire-and-forget: start first scan. The .catch is a safety net for
    // synchronous-throw paths only.
    executeScan(tracker._id, req.user?.userId, { force: true }).catch((err) => {
      console.error('[ai-tracker-monitor] scan kickoff failed:', err.message);
    });

    res.status(201).json({
      monitorId: tracker._id.toString(),
      name: monitorName,
      scanStatus: 'pending',
    });
  } catch (err) {
    // F1-06: catch-net rollback for unhandled error paths. Self-nulling
    // closure means no-op if a structured path already invoked it.
    if (promptQuotaRollback) await promptQuotaRollback();
    console.error('createMonitor error:', err.message);
    res.status(500).json({ error: 'Failed to create monitor' });
  }
};

// ─── DELETE /:wn/ai-tracker/monitors/:monitorId ─────────────────────────

const deleteMonitor = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    // Cascade delete all associated data (delete tracker last to avoid orphans)
    await Promise.all([
      AiTrackerScan.deleteMany({ trackerId: tracker._id }),
      AiTrackerPrompt.deleteMany({ trackerId: tracker._id }),
      AiTrackerCompetitor.deleteMany({ trackerId: tracker._id }),
    ]);
    await AiTracker.findByIdAndDelete(tracker._id);

    res.json({ success: true });
  } catch (err) {
    console.error('deleteMonitor error:', err.message);
    res.status(500).json({ error: 'Failed to delete monitor' });
  }
};

// ─── GET /:wn/ai-tracker/monitors/:monitorId ────────────────────────────

const getMonitor = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    res.json(await buildDashboardResponse(tracker));
  } catch (err) {
    console.error('getMonitor error:', err.message);
    res.status(500).json({ error: 'Failed to fetch monitor data' });
  }
};

// ─── PUT /:wn/ai-tracker/monitors/:monitorId ────────────────────────────

const updateMonitor = async (req, res) => {
  try {
    const workspace = req.workspace;

    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { defaultModels, name } = req.body;

    const update = {};
    if (Array.isArray(defaultModels)) {
      const validPlatformIds = PLATFORM_DISPLAY.map((p) => p.platformId);
      const filtered = defaultModels.filter((p) => validPlatformIds.includes(p));
      // F19-03: see updateTracker for rationale.
      if (filtered.length === 0) {
        return res.status(400).json({ error: 'At least one valid platform must be selected' });
      }
      const orgId = workspace.organizationId;
      if (orgId) {
        const { config, tier } = await tierService.getOrgTierConfig(orgId);
        const maxPlatforms = config?.maxAiTrackerPlatforms ?? validPlatformIds.length;
        if (filtered.length > maxPlatforms) {
          return res.status(400).json({
            error: `Your ${tier} plan allows up to ${maxPlatforms} AI platform${maxPlatforms !== 1 ? 's' : ''}`,
            code: 'PLATFORM_LIMIT',
            quota: { limit: maxPlatforms, requested: filtered.length, tier },
          });
        }
      }
      update.defaultModels = filtered;
      // F19-04: reselection-recovery nextScanAt reset (see updateTracker).
      if (!Array.isArray(tracker.defaultModels) || tracker.defaultModels.length === 0) {
        update.nextScanAt = new Date();
      }
    }
    if (name && typeof name === 'string' && name.trim()) {
      if (name.trim().length > 253) {
        return res.status(400).json({ error: 'Monitor name must be 253 characters or fewer' });
      }
      update.name = name.trim();
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    let doc;
    try {
      doc = await AiTracker.findByIdAndUpdate(tracker._id, { $set: update }, { new: true });
    } catch (updateErr) {
      if (updateErr.code === 11000) {
        return res.status(409).json({ error: 'A monitor with this name already exists' });
      }
      throw updateErr;
    }
    res.json({ tracker: doc.toTrackerState() });
  } catch (err) {
    console.error('updateMonitor error:', err.message);
    res.status(500).json({ error: 'Failed to update monitor' });
  }
};

// ─── Monitor-scoped scan, prompt, competitor handlers ────────────────────

const getMonitorScanStatus = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    res.json({
      status: tracker.scanStatus,
      progress: tracker.scanProgress,
      platformStatuses: tracker.platformStatuses || [],
      availablePlatformIds: computeAvailablePlatformIds(tracker),
      ...(tracker.scanError ? { error: tracker.scanError } : {}),
    });
  } catch (err) {
    console.error('getMonitorScanStatus error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scan status' });
  }
};

const triggerMonitorScan = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    // Recover any scans stuck for 30+ minutes before checking limits
    await recoverStuckScans(tracker.workspaceId);

    if (tracker.scanStatus === 'pending' || tracker.scanStatus === 'scanning') {
      return res.status(409).json({ error: 'A scan is already in progress' });
    }

    // Workspace-level concurrent scan limit (max 2 simultaneous scans)
    const activeScans = await AiTracker.countDocuments({
      workspaceId: tracker.workspaceId,
      scanStatus: { $in: ['pending', 'scanning'] },
    });
    if (activeScans >= 2) {
      return res.status(429).json({ error: 'Too many scans running in this workspace. Please wait for a scan to finish.' });
    }

    const isDev = process.env.NODE_ENV === 'development';
    if (!isDev && tracker.lastScanAt) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (tracker.lastScanAt > hourAgo) {
        return res.status(429).json({ error: 'Please wait at least 1 hour between scans' });
      }
    }

    // Pre-check credit affordability so we can return 402 immediately.
    // Actual deduction happens inside executeScan (shared with cron path).
    // Count only the prompts that will actually run (active + unlocked) so
    // inactive/locked prompts don't inflate the estimate and block scans
    // the user can afford.
    if (req.creditContext?.deductionEnabled) {
      const prompts = await AiTrackerPrompt.countDocuments({
        trackerId: tracker._id,
        active: { $ne: false },
        locked: { $ne: true },
      });
      const platforms = tracker.defaultModels?.length || 0;
      const estimatedCredits = Math.max(1, prompts * platforms * 4);
      const canPay = await creditService.canAfford(req.creditContext.orgId, estimatedCredits, req.user?.userId);
      if (!canPay) {
        return res.status(402).json({
          error: 'Insufficient credits',
          code: 'INSUFFICIENT_CREDITS',
          estimatedCredits,
        });
      }
    }

    // Set to pending — executeScan atomically claims it to prevent double-execution
    await AiTracker.findByIdAndUpdate(tracker._id, {
      $set: { scanStatus: 'pending', scanProgress: 0, scanError: null },
    });
    // executeScan handles its own errors via Phase H; the .catch here only
    // catches a synchronous throw before the first await (essentially never).
    executeScan(tracker._id, req.user?.userId, { force: true }).catch((err) => {
      console.error('[ai-tracker-scan] manual monitor-scan kickoff failed:', err.message);
    });

    res.json({ scanStatus: 'pending' });
  } catch (err) {
    console.error('triggerMonitorScan error:', err.message);
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
};

const addMonitorPrompt = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { prompt, models, frequency } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    if (prompt.trim().length > 500) {
      return res.status(400).json({ error: 'Prompt must be 500 characters or fewer' });
    }

    // Sanitize models to only valid platform IDs
    const VALID_PLATFORMS = ['chatgpt', 'gemini', 'claude', 'perplexity'];
    const sanitizedModels = Array.isArray(models) && models.length > 0
      ? models.filter((m) => VALID_PLATFORMS.includes(m))
      : undefined;

    if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ error: `Invalid frequency. Must be one of: ${VALID_FREQUENCIES.join(', ')}` });
    }
    if (frequency === 'Daily' && !(await isDailyFrequencyAllowed(workspace))) {
      return res.status(403).json({ error: 'Daily frequency requires a Professional or Agency plan' });
    }

    const existing = await AiTrackerPrompt.findOne({ trackerId: tracker._id, prompt: prompt.trim() });
    if (existing) {
      return res.status(409).json({ error: 'This prompt is already being tracked' });
    }

    // F5-04: cache tier config (see addPrompt for rationale).
    let tierInfo = null;
    if (workspace.organizationId) {
      tierInfo = await tierService.getOrgTierConfig(workspace.organizationId);
    }

    // F4-15: enforce per-monitor prompt cap (see addPrompt for full rationale).
    if (tierInfo) {
      const { config, tier } = tierInfo;
      const cap = config?.maxAiTrackerPromptsPerMonitor;
      if (cap != null) {
        const active = await AiTrackerPrompt.countDocuments({
          trackerId: tracker._id,
          active: { $ne: false },
          locked: { $ne: true },
        });
        if (active >= cap) {
          return res.status(429).json({
            error: `Your ${tier} plan allows up to ${cap} active prompts per monitor`,
            code: 'PROMPT_CAP_REACHED',
            quota: { limit: cap, used: active, tier, limitKey: 'maxAiTrackerPromptsPerMonitor' },
          });
        }
      }
    }

    // F5-01: see addPrompt for rationale (middleware-validated signal instead of body trust).
    let createdOnPlan = 'free';
    if (req.tierQuota?.isUserLevel) {
      createdOnPlan = 'free';
    } else if (tierInfo) {
      createdOnPlan = tierInfo.tier === 'free' ? 'free' : 'paid';
    }

    const doc = await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: prompt.trim(),
      ...(sanitizedModels && sanitizedModels.length > 0 ? { models: sanitizedModels } : {}),
      ...(frequency ? { frequency } : {}),
      createdOnPlan,
    });

    // Track prompt creation against tier quota
    if (req.tierQuota) {
      await tierService.incrementQuota(req.tierQuota);
    }

    res.status(201).json({ id: doc._id.toString(), prompt: doc.prompt });
  } catch (err) {
    console.error('addMonitorPrompt error:', err.message);
    res.status(500).json({ error: 'Failed to add prompt' });
  }
};

const updateMonitorPrompt = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
    if (!isValidObjectId(promptId)) return res.status(400).json({ error: 'Invalid prompt ID' });

    const { models, frequency, active } = req.body;

    const VALID_PLATFORMS = ['chatgpt', 'gemini', 'claude', 'perplexity'];
    const update = {};
    if (Array.isArray(models)) update.models = models.filter((m) => VALID_PLATFORMS.includes(m));
    if (frequency !== undefined) {
      if (!VALID_FREQUENCIES.includes(frequency)) {
        return res.status(400).json({ error: `Invalid frequency. Must be one of: ${VALID_FREQUENCIES.join(', ')}` });
      }
      if (frequency === 'Daily' && !(await isDailyFrequencyAllowed(workspace))) {
        return res.status(403).json({ error: 'Daily frequency requires a Professional or Agency plan' });
      }
      update.frequency = frequency;
    }
    // F5-06: strict boolean check (see updatePrompt).
    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: '`active` must be a boolean' });
      }
      update.active = active;
    }

    // Prompt text is immutable after creation (historical scan results would
    // be misleading otherwise). If client ONLY sent `prompt` with no other
    // updatable fields, return a clear error pointing to the correct flow.
    // If client sent `prompt` alongside other valid fields, silently ignore
    // the prompt field (form-fill UIs that send the whole doc back keep
    // working). This matches the pre-fix tolerance while still surfacing
    // the misleading "No fields to update" case explicitly.
    if (Object.keys(update).length === 0) {
      if (req.body.prompt !== undefined) {
        return res.status(400).json({
          error: 'Prompt text cannot be edited after creation. Delete this prompt and add a new one with the corrected text.',
          code: 'PROMPT_TEXT_IMMUTABLE',
        });
      }
      return res.status(400).json({ error: 'No fields to update' });
    }

    // F5-02: cap recheck on reactivation (see updatePrompt for full rationale).
    if (active === true && workspace.organizationId) {
      const existing = await AiTrackerPrompt.findOne({ _id: promptId, trackerId: tracker._id }).select('active locked').lean();
      if (existing && existing.active === false) {
        const { config, tier } = await tierService.getOrgTierConfig(workspace.organizationId);
        const cap = config?.maxAiTrackerPromptsPerMonitor;
        if (cap != null) {
          const activeCount = await AiTrackerPrompt.countDocuments({
            trackerId: tracker._id,
            active: { $ne: false },
            locked: { $ne: true },
          });
          if (activeCount >= cap) {
            return res.status(429).json({
              error: `Your ${tier} plan allows up to ${cap} active prompts per monitor`,
              code: 'PROMPT_CAP_REACHED',
              quota: { limit: cap, used: activeCount, tier, limitKey: 'maxAiTrackerPromptsPerMonitor' },
            });
          }
        }
      }
    }

    const doc = await AiTrackerPrompt.findOneAndUpdate(
      { _id: promptId, trackerId: tracker._id },
      { $set: update },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    // F5-03: atomic nextScanAt pull-forward (see updatePrompt for rationale).
    if (frequency !== undefined) {
      const FREQ_DAYS = { 'Daily': 1, 'Weekly': 7, 'Bi-weekly': 14, 'Monthly': 30 };
      const freqDays = FREQ_DAYS[frequency];
      const baseTime = doc.lastScannedAt ? doc.lastScannedAt.getTime() : Date.now();
      const promptNextDue = new Date(baseTime + freqDays * 24 * 60 * 60 * 1000);
      await AiTracker.findOneAndUpdate(
        {
          _id: tracker._id,
          $or: [
            { nextScanAt: null },
            { nextScanAt: { $exists: false } },
            { nextScanAt: { $gt: promptNextDue } },
          ],
        },
        { $set: { nextScanAt: promptNextDue } }
      );
    }

    res.json({ id: doc._id.toString(), prompt: doc.prompt, models: doc.models, frequency: doc.frequency, active: doc.active });
  } catch (err) {
    console.error('updateMonitorPrompt error:', err.message);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
};

const removeMonitorPrompt = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
    if (!isValidObjectId(promptId)) return res.status(400).json({ error: 'Invalid prompt ID' });

    const deleted = await AiTrackerPrompt.findOneAndDelete({ _id: promptId, trackerId: tracker._id });
    if (!deleted) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('removeMonitorPrompt error:', err.message);
    res.status(500).json({ error: 'Failed to remove prompt' });
  }
};

const bulkDeleteMonitorPrompts = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: 'Cannot delete more than 500 prompts at once' });
    }
    if (!ids.every(isValidObjectId)) {
      return res.status(400).json({ error: 'All ids must be valid ObjectIds' });
    }

    const result = await AiTrackerPrompt.deleteMany({ _id: { $in: ids }, trackerId: tracker._id });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error('bulkDeleteMonitorPrompts error:', err.message);
    res.status(500).json({ error: 'Failed to delete prompts' });
  }
};

const addMonitorCompetitor = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Competitor name is required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Competitor name must be 100 characters or fewer' });
    }

    const doc = await AiTrackerCompetitor.create({ trackerId: tracker._id, name: name.trim(), isOwn: false });
    res.status(201).json({ id: doc._id.toString(), name: doc.name });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This competitor is already being tracked' });
    }
    console.error('addMonitorCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to add competitor' });
  }
};

const removeMonitorCompetitor = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { competitorId } = req.params;
    if (!isValidObjectId(competitorId)) return res.status(400).json({ error: 'Invalid competitor ID' });

    const deleted = await AiTrackerCompetitor.findOneAndDelete({ _id: competitorId, trackerId: tracker._id });
    if (!deleted) {
      return res.status(404).json({ error: 'Competitor not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('removeMonitorCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to remove competitor' });
  }
};

const dismissMonitorSuggestedCompetitor = async (req, res) => {
  try {
    const workspace = req.workspace;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Competitor name is required' });
    }

    const trimmed = name.trim();
    if (!tracker.dismissedCompetitors.includes(trimmed)) {
      await AiTracker.findByIdAndUpdate(tracker._id, {
        $addToSet: { dismissedCompetitors: trimmed },
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('dismissMonitorSuggestedCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to dismiss competitor' });
  }
};

// ─── GET /:wn/ai-tracker/scan-details?date=ISO ─────────────────────────
// Returns platform-level data (aiResponse, fanoutQueries, brandRanking,
// citedUrls) for the scan closest to the requested date.  Used by the
// frontend when viewing a historical date range so detail tabs show the
// correct scan's data instead of always showing the latest scan.

const getScanDetails = async (req, res) => {
  try {
    const workspace = req.workspace;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date query parameter is required' });
    }

    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    // Resolve tracker — legacy single-monitor or multi-monitor
    const tracker = req.params.monitorId
      ? await resolveMonitor(req, workspace, res)
      : await resolveTracker(workspace, res);
    if (!tracker) return; // resolveTracker/resolveMonitor already sent the response

    // Find the scan closest to the target date.
    // Two queries hitting the existing { trackerId, completedAt } index.
    const [scanBefore, scanAfter] = await Promise.all([
      AiTrackerScan.findOne({
        trackerId: tracker._id,
        status: 'ready',
        completedAt: { $lte: targetDate },
      }).sort({ completedAt: -1 }).limit(1).lean(),
      AiTrackerScan.findOne({
        trackerId: tracker._id,
        status: 'ready',
        completedAt: { $gt: targetDate },
      }).sort({ completedAt: 1 }).limit(1).lean(),
    ]);

    let scan = null;
    if (scanBefore && scanAfter) {
      const diffBefore = targetDate - scanBefore.completedAt;
      const diffAfter = scanAfter.completedAt - targetDate;
      scan = diffBefore <= diffAfter ? scanBefore : scanAfter;
    } else {
      scan = scanBefore || scanAfter;
    }

    if (!scan) {
      return res.status(404).json({ error: 'No scan found near the specified date' });
    }

    // Build promptPlatforms map: { promptId → platforms[] }
    const promptPlatforms = {};
    for (const result of scan.results || []) {
      const promptId = result.promptId?.toString();
      if (!promptId) continue;
      promptPlatforms[promptId] = (result.platforms || []).map((pl) => ({
        platformId: pl.platformId,
        mentioned: pl.mentioned,
        position: pl.position ?? null,
        cited: pl.cited,
        citationCount: pl.citationCount || 0,
        citedUrls: pl.citedUrls || [],
        brandRanking: pl.brandRanking || [],
        aiResponse: pl.aiResponse || '',
        sentiment: pl.sentiment || null,
        sentimentScore: pl.sentimentScore ?? null,
        error: pl.error || false,
        fanoutQueries: pl.fanoutQueries || [],
        // F11-02: see buildDashboardResponse for rationale.
        ...(pl.fanoutUnavailable ? { fanoutUnavailable: true } : {}),
      }));
    }

    res.json({
      scanDate: scan.completedAt.toISOString(),
      scanId: scan._id.toString(),
      promptPlatforms,
      competitorResults: scan.competitorResults || [],
    });
  } catch (err) {
    console.error('getScanDetails error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scan details' });
  }
};

module.exports = {
  // Legacy single-monitor
  getTracker,
  updateTracker,
  suggestPrompts,
  setup,
  getScanStatus,
  triggerScan,
  addPrompt,
  updatePrompt,
  removePrompt,
  bulkDeletePrompts,
  addCompetitor,
  removeCompetitor,
  dismissSuggestedCompetitor,
  executeScan,
  // Multi-monitor
  listMonitors,
  createMonitor,
  deleteMonitor,
  getMonitor,
  updateMonitor,
  getMonitorScanStatus,
  triggerMonitorScan,
  addMonitorPrompt,
  updateMonitorPrompt,
  removeMonitorPrompt,
  bulkDeleteMonitorPrompts,
  addMonitorCompetitor,
  removeMonitorCompetitor,
  dismissMonitorSuggestedCompetitor,
  // Shared (works for both legacy and multi-monitor via req.params.monitorId)
  getScanDetails,
  // Dev helpers (no-op in production since _devTimeScale defaults to 1)
  setDevTimeScale,
  getDevTimeScale,
};

// Exported for F4-17 regression tests only — not part of the runtime API.
module.exports.__test = { htmlEscape, computeMetrics, computeTrendData, computeChanges };
