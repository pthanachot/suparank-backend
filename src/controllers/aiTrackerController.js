const Workspace = require('../models/Workspace');
const AiTracker = require('../models/AiTracker');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const AiTrackerCompetitor = require('../models/AiTrackerCompetitor');
const AiTrackerScan = require('../models/AiTrackerScan');
const { runScan, PLATFORMS } = require('../services/aiTrackerScanEngine');

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

// ─── Workspace Resolution (same pattern as contentController.js) ──────────

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

function computeMetrics(latestScan, promptCount, competitors) {
  if (!latestScan) return null;

  const results = latestScan.results || [];
  const platformCount = PLATFORMS.length;
  let totalMentions = 0;
  let totalCitations = 0;
  const totalPossible = results.length * platformCount;

  for (const r of results) {
    for (const p of r.platforms) {
      if (p.mentioned) totalMentions++;
      if (p.cited) totalCitations++;
    }
  }

  const visibility = totalPossible > 0 ? Math.round((totalMentions / totalPossible) * 100) : 0;
  const citationRate = totalMentions > 0 ? Math.round((totalCitations / totalMentions) * 100) : 0;

  // Share of voice: own mentions vs total of all competitors + own
  const ownComp = competitors.find((c) => c.isOwn);
  const ownCompResult = ownComp
    ? (latestScan.competitorResults || []).find((cr) => cr.competitorId.equals(ownComp._id))
    : null;
  const ownMentions = ownCompResult ? ownCompResult.mentions : totalMentions;
  const allCompMentions = (latestScan.competitorResults || []).reduce((sum, cr) => sum + cr.mentions, 0);
  const shareOfVoice = allCompMentions > 0 ? Math.round((ownMentions / allCompMentions) * 100) : 0;

  return { visibility, shareOfVoice, citationRate, promptCount };
}

function generatePromptSuggestions(scanResult) {
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
  const mentioned = scanResult.platforms.filter((p) => p.mentioned);
  const cited = scanResult.platforms.filter((p) => p.cited);
  const notMentioned = scanResult.platforms.filter((p) => !p.mentioned);

  if (mentioned.length === 0) {
    suggestions.push('Create comprehensive content targeting this exact query');
    suggestions.push('Add a direct answer in the first paragraph');
    suggestions.push('Use clear H2/H3 structure matching query intent');
  }

  if (mentioned.length > 0 && cited.length === 0) {
    suggestions.push('Add structured data (FAQ schema) to improve citation chances');
    suggestions.push('Include your domain URL naturally in authoritative content');
  }

  if (notMentioned.length > 0 && mentioned.length > 0) {
    const names = notMentioned.map((p) => {
      const display = PLATFORM_DISPLAY.find((d) => d.platformId === p.platformId);
      return display ? display.name : p.platformId;
    });
    suggestions.push(`Improve visibility on ${names.join(', ')} by diversifying content format`);
  }

  suggestions.push('Strengthen E-E-A-T signals (author bio, date, citations)');
  suggestions.push('Add authoritative external citations and sources');
  suggestions.push('Keyword in title and first 100 words');
  suggestions.push('Include FAQ section with exact-match questions');

  return suggestions.slice(0, 6);
}

function formatTrackedPrompts(prompts, latestScan, previousScan, recentScans) {
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
      suggestions: generatePromptSuggestions(null),
      trendHistory: [],
    }));
  }

  return prompts.map((p) => {
    const scanResult = latestScan.results.find((r) => r.promptId.equals(p._id));
    const prevResult = previousScan
      ? previousScan.results.find((r) => r.promptId.equals(p._id))
      : null;

    const currentMentioned = scanResult
      ? scanResult.platforms.filter((pl) => pl.mentioned).length
      : 0;
    const prevMentioned = prevResult
      ? prevResult.platforms.filter((pl) => pl.mentioned).length
      : 0;
    const delta = currentMentioned - prevMentioned;

    let trend = 'stable';
    if (!prevResult) trend = 'new';
    else if (delta > 0) trend = 'up';
    else if (delta < 0) trend = 'down';

    // Normalize trendDelta to percentage (out of total platforms)
    const platformCount = PLATFORMS.length;
    const trendDelta = platformCount > 0 ? Math.round((delta / platformCount) * 100) : 0;

    return {
      id: p._id.toString(),
      prompt: p.prompt,
      platforms: (scanResult ? scanResult.platforms : []).map((pl) => ({
        platformId: pl.platformId,
        mentioned: pl.mentioned,
        tier: pl.tier,
        cited: pl.cited,
        citedFrom: pl.citedFrom || null,
      })),
      lastChecked: latestScan.completedAt
        ? formatRelativeDate(latestScan.completedAt)
        : 'Pending',
      trend,
      trendDelta,
      aiResponse: scanResult ? scanResult.platforms.find((pl) => pl.aiResponse)?.aiResponse : undefined,
      models: p.models,
      frequency: p.frequency,
      active: p.active,
      suggestions: generatePromptSuggestions(scanResult),
      trendHistory: (recentScans || []).map((scan) => {
        const result = scan.results.find((r) => r.promptId.equals(p._id));
        if (!result) return 0;
        const mentionedCount = result.platforms.filter((pl) => pl.mentioned).length;
        const totalCount = result.platforms.length || PLATFORMS.length;
        return Math.round((mentionedCount / totalCount) * 100);
      }).reverse(),
    };
  });
}

function formatCompetitors(competitors, latestScan, previousScan) {
  return competitors.map((c) => {
    const current = latestScan
      ? (latestScan.competitorResults || []).find((cr) => cr.competitorId.equals(c._id))
      : null;
    const prev = previousScan
      ? (previousScan.competitorResults || []).find((cr) => cr.competitorId.equals(c._id))
      : null;

    const visibility = current ? current.visibility : 0;
    const prevVisibility = prev ? prev.visibility : 0;

    // Compute share of voice for this competitor
    const allCompMentions = latestScan
      ? (latestScan.competitorResults || []).reduce((sum, cr) => sum + cr.mentions, 0)
      : 0;
    const shareOfVoice = allCompMentions > 0 && current
      ? Math.round((current.mentions / allCompMentions) * 100)
      : 0;

    return {
      id: c._id.toString(),
      name: c.name,
      isOwn: c.isOwn,
      visibility,
      visibilityDelta: visibility - prevVisibility,
      mentions: current ? current.mentions : 0,
      citations: current ? current.citations : 0,
      shareOfVoice,
    };
  });
}

function computeChanges(latestScan, previousScan) {
  if (!latestScan || !previousScan) return [];

  const changes = [];
  let changeId = 0;

  for (const result of latestScan.results) {
    const prevResult = previousScan.results.find((r) => r.promptId.equals(result.promptId));
    if (!prevResult) continue;

    for (const plat of result.platforms) {
      const prevPlat = prevResult.platforms.find((pp) => pp.platformId === plat.platformId);
      if (!prevPlat) continue;

      const meta = PLATFORM_DISPLAY.find((p) => p.platformId === plat.platformId);

      if (!prevPlat.mentioned && plat.mentioned) {
        changes.push({
          id: `ch_${changeId++}`,
          type: 'gained',
          prompt: result.prompt,
          platform: meta ? meta.name : plat.platformId,
          platformLetter: meta ? meta.letter : plat.platformId[0].toUpperCase(),
          platformColor: meta ? meta.color : 'text-gray-600',
          platformBg: meta ? meta.bgColor : 'bg-gray-50',
          detail: `Now mentioned on ${meta ? meta.name : plat.platformId}`,
        });
      } else if (prevPlat.mentioned && !plat.mentioned) {
        changes.push({
          id: `ch_${changeId++}`,
          type: 'lost',
          prompt: result.prompt,
          platform: meta ? meta.name : plat.platformId,
          platformLetter: meta ? meta.letter : plat.platformId[0].toUpperCase(),
          platformColor: meta ? meta.color : 'text-gray-600',
          platformBg: meta ? meta.bgColor : 'bg-gray-50',
          detail: `Lost mention on ${meta ? meta.name : plat.platformId}`,
        });
      } else if (prevPlat.tier === 'mentioned' && plat.tier === 'top') {
        changes.push({
          id: `ch_${changeId++}`,
          type: 'improved',
          prompt: result.prompt,
          platform: meta ? meta.name : plat.platformId,
          platformLetter: meta ? meta.letter : plat.platformId[0].toUpperCase(),
          platformColor: meta ? meta.color : 'text-gray-600',
          platformBg: meta ? meta.bgColor : 'bg-gray-50',
          detail: `Upgraded to top mention on ${meta ? meta.name : plat.platformId}`,
        });
      } else if (prevPlat.tier === 'top' && plat.tier === 'mentioned') {
        changes.push({
          id: `ch_${changeId++}`,
          type: 'declined',
          prompt: result.prompt,
          platform: meta ? meta.name : plat.platformId,
          platformLetter: meta ? meta.letter : plat.platformId[0].toUpperCase(),
          platformColor: meta ? meta.color : 'text-gray-600',
          platformBg: meta ? meta.bgColor : 'bg-gray-50',
          detail: `Dropped from top to mentioned on ${meta ? meta.name : plat.platformId}`,
        });
      }

      if (!prevPlat.cited && plat.cited) {
        changes.push({
          id: `ch_${changeId++}`,
          type: 'new_citation',
          prompt: result.prompt,
          platform: meta ? meta.name : plat.platformId,
          platformLetter: meta ? meta.letter : plat.platformId[0].toUpperCase(),
          platformColor: meta ? meta.color : 'text-gray-600',
          platformBg: meta ? meta.bgColor : 'bg-gray-50',
          detail: `New citation from ${plat.citedFrom || (meta ? meta.name : plat.platformId)}`,
        });
      }
    }
  }

  return changes;
}

function computeTrendData(scans) {
  return scans.map((scan) => {
    const totalPossible = scan.results.length * PLATFORMS.length;
    let totalMentions = 0;
    for (const r of scan.results) {
      for (const p of r.platforms) {
        if (p.mentioned) totalMentions++;
      }
    }
    const value = totalPossible > 0 ? Math.round((totalMentions / totalPossible) * 100) : 0;
    const d = scan.completedAt || scan.startedAt;
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    return { week: `${month} ${day}`, value };
  }).reverse(); // oldest first
}

function computePlatformStats(latestScan) {
  return PLATFORM_DISPLAY.map((p) => {
    let mentionCount = 0;
    let citationCount = 0;
    let totalPrompts = 0;

    if (latestScan) {
      for (const r of latestScan.results) {
        const plat = r.platforms.find((pl) => pl.platformId === p.platformId);
        if (plat) {
          totalPrompts++;
          if (plat.mentioned) mentionCount++;
          if (plat.cited) citationCount++;
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
      visibility: totalPrompts > 0 ? Math.round((mentionCount / totalPrompts) * 100) : 0,
      mentionCount,
      citationCount,
    };
  });
}

function generateActionItems(latestScan) {
  if (!latestScan) return [];

  const items = [];
  let id = 0;

  // Prompts not mentioned on any platform
  const missingAll = latestScan.results.filter((r) =>
    r.platforms.every((p) => !p.mentioned)
  );
  if (missingAll.length > 0) {
    items.push({
      id: `ai_${id++}`,
      priority: 'high',
      title: `Create targeted content for ${missingAll.length} unmentioned prompt${missingAll.length > 1 ? 's' : ''}`,
      description: `Your brand is not mentioned in any AI platform for ${missingAll.length} tracked prompts. Creating comprehensive content targeting these queries can improve visibility.`,
      impact: `+${Math.min(missingAll.length * 10, 40)}% visibility`,
      type: 'content',
      linkedPrompts: missingAll.map((r) => r.promptId.toString()),
    });
  }

  // Mentioned but not cited
  const mentionedNotCited = latestScan.results.filter((r) =>
    r.platforms.some((p) => p.mentioned && !p.cited)
  );
  if (mentionedNotCited.length > 0) {
    items.push({
      id: `ai_${id++}`,
      priority: 'medium',
      title: 'Add structured data and citations to boost citation rate',
      description: `You are mentioned in ${mentionedNotCited.length} prompts but not cited with links. Adding FAQ schema, clear brand mentions, and authoritative content structure can improve citation rates.`,
      impact: `+${Math.min(mentionedNotCited.length * 5, 25)}% citation rate`,
      type: 'technical',
    });
  }

  // Platform gaps: mentioned on some but not all
  const platformGaps = latestScan.results.filter((r) => {
    const mentioned = r.platforms.filter((p) => p.mentioned);
    return mentioned.length > 0 && mentioned.length < PLATFORMS.length;
  });
  if (platformGaps.length > 0) {
    const gapPlatformIds = [...new Set(
      platformGaps.flatMap((r) =>
        r.platforms.filter((p) => !p.mentioned).map((p) => p.platformId)
      )
    )];
    const gapNames = gapPlatformIds
      .map((pid) => PLATFORM_DISPLAY.find((pd) => pd.platformId === pid)?.name || pid)
      .join(', ');
    items.push({
      id: `ai_${id++}`,
      priority: 'medium',
      title: `Close platform gaps on ${gapNames}`,
      description: `You're mentioned on some platforms but not others for ${platformGaps.length} prompts. Diversifying content format and structure can help reach all AI platforms.`,
      impact: `+${Math.min(platformGaps.length * 8, 30)}% cross-platform visibility`,
      type: 'strategy',
      platformGap: gapPlatformIds,
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
// BACKGROUND SCAN EXECUTION (fire-and-forget)
// ═══════════════════════════════════════════════════════════════════════════

async function executeScan(trackerId) {
  try {
    const tracker = await AiTracker.findById(trackerId);
    if (!tracker) return;

    const prompts = await AiTrackerPrompt.find({ trackerId });
    const competitors = await AiTrackerCompetitor.find({ trackerId });

    // Create scan document
    const scan = await AiTrackerScan.create({ trackerId, startedAt: new Date() });

    // Set tracker to scanning
    await AiTracker.findByIdAndUpdate(trackerId, {
      $set: {
        scanStatus: 'scanning',
        scanProgress: 0,
        scanError: null,
        currentScanId: scan._id,
      },
    });

    // Run the scan engine
    const { results, competitorResults } = await runScan(
      tracker,
      prompts,
      competitors,
      async (progress, platformStatuses) => {
        await AiTracker.findByIdAndUpdate(trackerId, {
          $set: { scanProgress: progress, platformStatuses },
        });
      }
    );

    // Save scan results
    const now = new Date();
    await AiTrackerScan.findByIdAndUpdate(scan._id, {
      $set: { status: 'ready', completedAt: now, results, competitorResults },
    });

    // Update tracker to ready
    await AiTracker.findByIdAndUpdate(trackerId, {
      $set: {
        scanStatus: 'ready',
        scanProgress: 100,
        lastScanAt: now,
        nextScanAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        currentScanId: null,
        platformStatuses: PLATFORM_DISPLAY.map((p) => ({
          platformId: p.platformId,
          status: 'completed',
        })),
      },
    });
  } catch (err) {
    console.error('[ai-tracker-scan] error:', err.message);
    await AiTracker.findByIdAndUpdate(trackerId, {
      $set: { scanStatus: 'failed', scanError: err.message, currentScanId: null },
    }).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED: Build full dashboard response for a tracker
// ═══════════════════════════════════════════════════════════════════════════

async function buildDashboardResponse(tracker) {
  const prompts = await AiTrackerPrompt.find({ trackerId: tracker._id });
  const competitors = await AiTrackerCompetitor.find({ trackerId: tracker._id });

  const recentScans = await AiTrackerScan.find({
    trackerId: tracker._id,
    status: 'ready',
  })
    .sort({ completedAt: -1 })
    .limit(12)
    .lean();

  const latestScan = recentScans[0] || null;
  const previousScan = recentScans[1] || null;

  const metrics = computeMetrics(latestScan, prompts.length, competitors);
  const trackedPrompts = formatTrackedPrompts(prompts, latestScan, previousScan, recentScans);
  const formattedCompetitors = formatCompetitors(competitors, latestScan, previousScan);
  const changes = computeChanges(latestScan, previousScan);
  const trendData = computeTrendData(recentScans);
  const actionItems = generateActionItems(latestScan);
  const platformStats = computePlatformStats(latestScan);

  return {
    tracker: tracker.toTrackerState(),
    metrics,
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { defaultModels } = req.body;

    const update = {};
    if (Array.isArray(defaultModels)) update.defaultModels = defaultModels;

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

const DEFAULT_SUGGESTIONS = [
  { prompt: 'best tools in your industry', category: 'brand', reason: 'High-volume query where your brand could be recommended' },
  { prompt: 'how to solve problems your product addresses', category: 'feature', reason: 'Directly related to your core value proposition' },
  { prompt: 'your brand vs competitors comparison', category: 'comparison', reason: 'Users actively compare products in your space' },
  { prompt: 'best free alternatives in your category', category: 'brand', reason: 'Captures price-sensitive users searching for options' },
  { prompt: 'how to get started with your type of product', category: 'feature', reason: 'High intent query matching onboarding use cases' },
  { prompt: 'industry trends and tools for your market', category: 'industry', reason: 'Broad industry query where your brand could appear' },
  { prompt: 'reviews and recommendations for your product type', category: 'brand', reason: 'Users seeking social proof before purchasing' },
  { prompt: 'tips and best practices in your domain', category: 'industry', reason: 'Educational content where your brand adds authority' },
];

const suggestPrompts = async (req, res) => {
  console.log('[suggest-prompts] route hit, body:', JSON.stringify(req.body));
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) {
      console.log('[suggest-prompts] workspace not found');
      return;
    }
    console.log('[suggest-prompts] workspace resolved:', workspace.workspaceNumber);

    const { domain } = req.body;
    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      console.log('[suggest-prompts] missing domain');
      return res.status(400).json({ error: 'Domain is required' });
    }

    const apiKey = process.env.CHATGPT_API_KEY;
    console.log('[suggest-prompts] CHATGPT_API_KEY present:', !!apiKey);
    if (!apiKey) {
      console.log('[suggest-prompts] no API key, returning default suggestions');
      return res.json({ suggestions: DEFAULT_SUGGESTIONS });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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
            {
              role: 'system',
              content: `You are an AI visibility analyst. Given a website domain, suggest 8 search prompts that users would type into AI assistants (ChatGPT, Gemini, Claude, Perplexity) where this brand could potentially be mentioned or recommended.

Return a JSON object with a "suggestions" key containing an array of exactly 8 items:
{"suggestions": [{"prompt": "the search prompt", "category": "brand", "reason": "why this prompt matters"}]}

Categories: brand, feature, comparison, industry.
- brand: queries where the brand should be directly mentioned
- feature: queries about features/capabilities the brand offers
- comparison: queries comparing the brand to competitors
- industry: broader industry queries where the brand could appear

Make prompts realistic — what real users would ask AI assistants.`,
            },
            { role: 'user', content: `Domain: ${domain.trim()}` },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.error('[suggest-prompts] OpenAI error:', response.status);
        return res.json({ suggestions: DEFAULT_SUGGESTIONS });
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        return res.json({ suggestions: DEFAULT_SUGGESTIONS });
      }

      const parsed = JSON.parse(content);
      const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : Array.isArray(parsed) ? parsed : DEFAULT_SUGGESTIONS;

      // Validate shape
      const valid = suggestions
        .filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim())
        .slice(0, 8)
        .map((s) => ({
          prompt: s.prompt.trim(),
          category: ['brand', 'feature', 'comparison', 'industry'].includes(s.category) ? s.category : 'industry',
          reason: typeof s.reason === 'string' ? s.reason : 'Relevant to your brand visibility',
        }));

      res.json({ suggestions: valid.length > 0 ? valid : DEFAULT_SUGGESTIONS });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error('suggestPrompts error:', err.message);
    res.json({ suggestions: DEFAULT_SUGGESTIONS });
  }
};

// ─── POST /:workspaceNumber/ai-tracker/setup ──────────────────────────────

const setup = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { domain, name, prompts, competitors } = req.body;

    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'Domain is required' });
    }
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: 'At least one prompt is required' });
    }

    const monitorName = (name && typeof name === 'string' && name.trim()) ? name.trim() : domain.trim();

    // Check if monitor with same name already exists
    const existing = await AiTracker.findOne({ workspaceId: workspace._id, name: monitorName });
    if (existing) {
      return res.status(409).json({ error: 'A monitor with this name already exists' });
    }

    // Create tracker
    let tracker;
    try {
      tracker = await AiTracker.create({
        workspaceId: workspace._id,
        name: monitorName,
        domain: domain.trim(),
        scanStatus: 'pending',
      });
    } catch (createErr) {
      if (createErr.code === 11000) {
        return res.status(409).json({ error: 'A monitor with this name already exists' });
      }
      throw createErr;
    }

    // Create prompts
    const promptDocs = prompts
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => ({ trackerId: tracker._id, prompt: p.trim() }));
    if (promptDocs.length > 0) {
      await AiTrackerPrompt.insertMany(promptDocs, { ordered: false }).catch((err) => {
        // Ignore duplicate key errors from compound unique index
        if (err.code !== 11000) throw err;
      });
    }

    // Create own-brand competitor
    const brandName = domain.trim().replace(/^(https?:\/\/)?(www\.)?/, '').split('.')[0];
    const capitalizedBrand = brandName.charAt(0).toUpperCase() + brandName.slice(1);
    await AiTrackerCompetitor.create({
      trackerId: tracker._id,
      name: capitalizedBrand,
      isOwn: true,
    });

    // Create additional competitors
    if (Array.isArray(competitors)) {
      const compDocs = competitors
        .filter((c) => typeof c === 'string' && c.trim())
        .map((c) => ({ trackerId: tracker._id, name: c.trim(), isOwn: false }));
      if (compDocs.length > 0) {
        await AiTrackerCompetitor.insertMany(compDocs);
      }
    }

    // Fire-and-forget: start first scan
    executeScan(tracker._id).catch((err) => {
      console.error('[ai-tracker-setup] scan failed:', err.message);
    });

    res.status(201).json({
      trackerId: tracker._id.toString(),
      scanStatus: 'pending',
    });
  } catch (err) {
    console.error('setup error:', err.message);
    res.status(500).json({ error: 'Failed to set up AI tracker' });
  }
};

// ─── GET /:workspaceNumber/ai-tracker/scan ────────────────────────────────

const getScanStatus = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    res.json({
      status: tracker.scanStatus,
      progress: tracker.scanProgress,
      platformStatuses: tracker.platformStatuses || [],
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    // Check if scan is already in progress
    if (tracker.scanStatus === 'pending' || tracker.scanStatus === 'scanning') {
      return res.status(409).json({ error: 'A scan is already in progress' });
    }

    // Rate limit: at least 1 hour between scans
    if (tracker.lastScanAt) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (tracker.lastScanAt > hourAgo) {
        return res.status(429).json({ error: 'Please wait at least 1 hour between scans' });
      }
    }

    // Set to pending and fire scan
    await AiTracker.findByIdAndUpdate(tracker._id, {
      $set: { scanStatus: 'pending', scanProgress: 0, scanError: null },
    });

    executeScan(tracker._id).catch((err) => {
      console.error('[ai-tracker-scan] manual scan failed:', err.message);
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { prompt, models, frequency } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Check duplicate
    const existing = await AiTrackerPrompt.findOne({
      trackerId: tracker._id,
      prompt: prompt.trim(),
    });
    if (existing) {
      return res.status(409).json({ error: 'This prompt is already being tracked' });
    }

    const doc = await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: prompt.trim(),
      ...(Array.isArray(models) && models.length > 0 ? { models } : {}),
      ...(frequency ? { frequency } : {}),
    });

    res.status(201).json({ id: doc._id.toString(), prompt: doc.prompt });
  } catch (err) {
    console.error('addPrompt error:', err.message);
    res.status(500).json({ error: 'Failed to add prompt' });
  }
};

// ─── DELETE /:workspaceNumber/ai-tracker/prompts/:promptId ───────────────

const removePrompt = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
    const { models, frequency, active } = req.body;

    const update = {};
    if (Array.isArray(models)) update.models = models;
    if (frequency !== undefined) update.frequency = frequency;
    if (active !== undefined) update.active = active;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const doc = await AiTrackerPrompt.findOneAndUpdate(
      { _id: promptId, trackerId: tracker._id },
      { $set: update },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ error: 'Prompt not found' });
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Competitor name is required' });
    }

    const doc = await AiTrackerCompetitor.create({
      trackerId: tracker._id,
      name: name.trim(),
      isOwn: false,
    });

    res.status(201).json({ id: doc._id.toString(), name: doc.name });
  } catch (err) {
    console.error('addCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to add competitor' });
  }
};

// ─── DELETE /:workspaceNumber/ai-tracker/competitors/:competitorId ───────

const removeCompetitor = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveTracker(workspace, res);
    if (!tracker) return;

    const { competitorId } = req.params;
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

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-MONITOR ENDPOINT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /:wn/ai-tracker/monitors ────────────────────────────────────────

const listMonitors = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const trackers = await AiTracker.find({ workspaceId: workspace._id })
      .sort({ createdAt: 1 })
      .lean();

    const monitors = await Promise.all(trackers.map(async (t) => {
      const promptCount = await AiTrackerPrompt.countDocuments({ trackerId: t._id });
      return {
        id: t._id.toString(),
        name: t.name || t.domain,
        domain: t.domain,
        scanStatus: t.scanStatus,
        lastScanAt: t.lastScanAt ? t.lastScanAt.toISOString() : null,
        createdAt: t.createdAt.toISOString(),
        promptCount,
      };
    }));

    res.json({ monitors });
  } catch (err) {
    console.error('listMonitors error:', err.message);
    res.status(500).json({ error: 'Failed to list monitors' });
  }
};

// ─── POST /:wn/ai-tracker/monitors ──────────────────────────────────────

const createMonitor = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { domain, name, prompts, competitors } = req.body;

    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'Domain is required' });
    }
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: 'At least one prompt is required' });
    }

    const monitorName = (name && typeof name === 'string' && name.trim()) ? name.trim() : domain.trim();

    // Check duplicate name
    const existing = await AiTracker.findOne({ workspaceId: workspace._id, name: monitorName });
    if (existing) {
      return res.status(409).json({ error: 'A monitor with this name already exists' });
    }

    // Create tracker
    let tracker;
    try {
      tracker = await AiTracker.create({
        workspaceId: workspace._id,
        name: monitorName,
        domain: domain.trim(),
        scanStatus: 'pending',
      });
    } catch (createErr) {
      if (createErr.code === 11000) {
        return res.status(409).json({ error: 'A monitor with this name already exists' });
      }
      throw createErr;
    }

    // Create prompts
    const promptDocs = prompts
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => ({ trackerId: tracker._id, prompt: p.trim() }));
    if (promptDocs.length > 0) {
      await AiTrackerPrompt.insertMany(promptDocs, { ordered: false }).catch((err) => {
        if (err.code !== 11000) throw err;
      });
    }

    // Create own-brand competitor
    const brandName = domain.trim().replace(/^(https?:\/\/)?(www\.)?/, '').split('.')[0];
    const capitalizedBrand = brandName.charAt(0).toUpperCase() + brandName.slice(1);
    await AiTrackerCompetitor.create({
      trackerId: tracker._id,
      name: capitalizedBrand,
      isOwn: true,
    });

    // Create additional competitors
    if (Array.isArray(competitors)) {
      const compDocs = competitors
        .filter((c) => typeof c === 'string' && c.trim())
        .map((c) => ({ trackerId: tracker._id, name: c.trim(), isOwn: false }));
      if (compDocs.length > 0) {
        await AiTrackerCompetitor.insertMany(compDocs);
      }
    }

    // Fire-and-forget: start first scan
    executeScan(tracker._id).catch((err) => {
      console.error('[ai-tracker-monitor] scan failed:', err.message);
    });

    res.status(201).json({
      monitorId: tracker._id.toString(),
      name: monitorName,
      scanStatus: 'pending',
    });
  } catch (err) {
    console.error('createMonitor error:', err.message);
    res.status(500).json({ error: 'Failed to create monitor' });
  }
};

// ─── DELETE /:wn/ai-tracker/monitors/:monitorId ─────────────────────────

const deleteMonitor = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    // Cascade delete all associated data
    await AiTrackerScan.deleteMany({ trackerId: tracker._id });
    await AiTrackerPrompt.deleteMany({ trackerId: tracker._id });
    await AiTrackerCompetitor.deleteMany({ trackerId: tracker._id });
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { defaultModels, name } = req.body;

    const update = {};
    if (Array.isArray(defaultModels)) update.defaultModels = defaultModels;
    if (name && typeof name === 'string' && name.trim()) update.name = name.trim();

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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    res.json({
      status: tracker.scanStatus,
      progress: tracker.scanProgress,
      platformStatuses: tracker.platformStatuses || [],
      ...(tracker.scanError ? { error: tracker.scanError } : {}),
    });
  } catch (err) {
    console.error('getMonitorScanStatus error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scan status' });
  }
};

const triggerMonitorScan = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    if (tracker.scanStatus === 'pending' || tracker.scanStatus === 'scanning') {
      return res.status(409).json({ error: 'A scan is already in progress' });
    }
    if (tracker.lastScanAt) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (tracker.lastScanAt > hourAgo) {
        return res.status(429).json({ error: 'Please wait at least 1 hour between scans' });
      }
    }

    await AiTracker.findByIdAndUpdate(tracker._id, {
      $set: { scanStatus: 'pending', scanProgress: 0, scanError: null },
    });
    executeScan(tracker._id).catch((err) => {
      console.error('[ai-tracker-scan] manual scan failed:', err.message);
    });

    res.json({ scanStatus: 'pending' });
  } catch (err) {
    console.error('triggerMonitorScan error:', err.message);
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
};

const addMonitorPrompt = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { prompt, models, frequency } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const existing = await AiTrackerPrompt.findOne({ trackerId: tracker._id, prompt: prompt.trim() });
    if (existing) {
      return res.status(409).json({ error: 'This prompt is already being tracked' });
    }

    const doc = await AiTrackerPrompt.create({
      trackerId: tracker._id,
      prompt: prompt.trim(),
      ...(Array.isArray(models) && models.length > 0 ? { models } : {}),
      ...(frequency ? { frequency } : {}),
    });

    res.status(201).json({ id: doc._id.toString(), prompt: doc.prompt });
  } catch (err) {
    console.error('addMonitorPrompt error:', err.message);
    res.status(500).json({ error: 'Failed to add prompt' });
  }
};

const updateMonitorPrompt = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
    const { models, frequency, active } = req.body;

    const update = {};
    if (Array.isArray(models)) update.models = models;
    if (frequency !== undefined) update.frequency = frequency;
    if (active !== undefined) update.active = active;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const doc = await AiTrackerPrompt.findOneAndUpdate(
      { _id: promptId, trackerId: tracker._id },
      { $set: update },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    res.json({ id: doc._id.toString(), prompt: doc.prompt, models: doc.models, frequency: doc.frequency, active: doc.active });
  } catch (err) {
    console.error('updateMonitorPrompt error:', err.message);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
};

const removeMonitorPrompt = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { promptId } = req.params;
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
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
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Competitor name is required' });
    }

    const doc = await AiTrackerCompetitor.create({ trackerId: tracker._id, name: name.trim(), isOwn: false });
    res.status(201).json({ id: doc._id.toString(), name: doc.name });
  } catch (err) {
    console.error('addMonitorCompetitor error:', err.message);
    res.status(500).json({ error: 'Failed to add competitor' });
  }
};

const removeMonitorCompetitor = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;
    const tracker = await resolveMonitor(req, workspace, res);
    if (!tracker) return;

    const { competitorId } = req.params;
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
};
