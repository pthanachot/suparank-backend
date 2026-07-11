const Site = require('../models/Site');
const GscConnection = require('../models/GscConnection');
const Content = require('../models/Content');
const Opportunity = require('../models/Opportunity');
const gscService = require('../services/gscService');
const tierService = require('../services/tierService');
const { normalizeUrl } = require('../services/urlNormalize');
const { stemPhrase } = require('../services/stemmer');
// Required as a namespace (not destructured) so tests can stub resyncBriefIfActive.
const aiController = require('./aiController');

// How many striking rows to persist/enrich per refresh. Display caps are far
// smaller (15 content + 10 site); bounding lifecycle work keeps the GET cheap.
const STRIKING_LIFECYCLE_CAP = 50;
// Function words excluded from the relevance overlap so a shared "the"/"for"
// never makes an unrelated query look relevant.
const STOPWORDS = new Set(
  ('a an and the or of to in on for with at by from is are be best how what why '
    + 'vs your you my our their it its this that these those do does can will your')
    .split(/\s+/),
);

// ─── helpers ─────────────────────────────────────────────────────────────────

// Resolve the org GSC connection + the workspace's GSC property. Returns the
// four connection states rather than throwing so panels render, not error.
async function resolveGscContext(workspace) {
  const orgId = workspace.organizationId;
  const conn = await GscConnection.findOne({ organizationId: orgId });
  if (!conn || !conn.refreshToken) return { connected: false };

  // The GSC-connected site for this workspace (the one carrying a property id).
  const site = await Site.findOne({ workspaceId: workspace._id, gscPropertyId: { $nin: [null, ''] } }).lean();
  if (!site || !site.gscPropertyId) return { connected: true, propertyMatched: false };

  return { connected: true, propertyMatched: true, orgId, siteUrl: site.gscPropertyId };
}

// Non-stopword stem set for a phrase.
function relevantStems(phrase) {
  const set = new Set();
  for (const stemmed of stemPhrase(phrase || '').split(/\s+/)) {
    if (stemmed && !STOPWORDS.has(stemmed)) set.add(stemmed);
  }
  return set;
}

// True when the query shares ≥1 non-stopword stem with the content keywords.
function isRelevant(query, keywordStems) {
  if (keywordStems.size === 0) return false;
  for (const s of relevantStems(query)) {
    if (keywordStems.has(s)) return true;
  }
  return false;
}

// Upsert one opportunity: new rows start `open`; existing rows keep their status
// (dismissed/applied/recovered stay) and only refresh metrics. Returns the doc.
async function upsertOpportunity(workspaceId, source, query, page, metrics, extraSet = {}) {
  const filter = { workspaceId, source, query, page };
  const update = { $set: { metrics, ...extraSet }, $setOnInsert: { status: 'open' } };
  const opts = { new: true, upsert: true, setDefaultsOnInsert: true };
  try {
    return await Opportunity.findOneAndUpdate(filter, update, opts).lean();
  } catch (err) {
    // Two concurrent GETs (e.g. React StrictMode fires the panel + card fetches
    // at once) can both try to insert the same key → one hits the unique index
    // (E11000). The row now exists, so retry as a plain update, not an insert.
    if (err && err.code === 11000) {
      return Opportunity.findOneAndUpdate(filter, update, opts).lean();
    }
    throw err;
  }
}

// Refresh striking-distance opportunities and return live rows enriched with
// lifecycle status (dismissed filtered out).
async function syncStriking(workspaceId, orgId, siteUrl) {
  const { rows, truncated } = await gscService.getStrikingDistance(orgId, siteUrl, {});
  const top = rows.slice(0, STRIKING_LIFECYCLE_CAP);

  // Recovery pass: an applied row whose position has climbed to ≤10 flips to
  // recovered (the before/after story). Bounded by the number of applied rows.
  const appliedRows = await Opportunity.find({ workspaceId, source: 'gsc_striking', status: 'applied' }).lean();
  for (const o of appliedRows) {
    const pos = await gscService.getKeywordPosition(orgId, siteUrl, o.query).catch(() => null);
    if (pos !== null && pos <= 10) {
      await Opportunity.updateOne({ _id: o._id }, { $set: { status: 'recovered', recoveredAt: new Date() } });
    }
  }

  const enriched = [];
  for (const r of top) {
    const metrics = {
      position: r.position, impressions: r.impressions, clicks: r.clicks,
      opportunity: r.opportunity, potentialClicks: r.potentialClicks,
    };
    const doc = await upsertOpportunity(workspaceId, 'gsc_striking', r.keyword, '', metrics);
    if (doc.status === 'dismissed') continue; // never resurface
    enriched.push({ ...r, opportunityId: doc._id, status: doc.status });
  }
  return { rows: enriched, truncated };
}

// Refresh decay opportunities by matching declining GSC pages to contents with a
// publishedUrl. Unmatched declining pages are returned display-only.
async function syncDecay(workspaceId, orgId, siteUrl, contents) {
  const { pages } = await gscService.getDecliningPages(orgId, siteUrl);
  const byUrl = new Map();
  for (const c of contents) {
    const n = normalizeUrl(c.publishedUrl);
    if (n) byUrl.set(n, c);
  }

  const matched = [];
  const unmapped = [];
  for (const p of pages) {
    const norm = normalizeUrl(p.page);
    const content = byUrl.get(norm);
    if (!content) { unmapped.push(p); continue; }
    const metrics = {
      position: null, impressions: p.impressions, clicks: p.clicks7,
      opportunity: null, potentialClicks: null,
    };
    // Identity is the PAGE (query ''); the top query is stored as topQuery and
    // refreshed in place, so a drifting top query never re-opens the row.
    const doc = await upsertOpportunity(
      workspaceId, 'gsc_decay', '', norm, metrics,
      { contentId: content._id, topQuery: p.topKeyword || '' },
    );
    if (doc.status === 'dismissed') continue;
    matched.push({
      ...p, opportunityId: doc._id, status: doc.status,
      contentId: content._id, contentNumber: content.contentNumber,
    });
  }
  return { matched, unmapped: unmapped.slice(0, 5) };
}

// Best-effort per-tier credit cost of the agent run that Apply launches (a
// freeform inline action). Shown on the button so the cost is visible.
async function resolveApplyCost(orgId) {
  try {
    const { tier } = await tierService.getOrgTierConfig(orgId);
    const { resolveCredits } = require('../config/creditRules');
    return resolveCredits('inlineAction', { tier });
  } catch {
    return null;
  }
}

// ─── GET workspace-level ───────────────────────────────────────────────────

const getWorkspaceOpportunities = async (req, res) => {
  try {
    const ctx = await resolveGscContext(req.workspace);
    if (!ctx.connected) return res.json({ connected: false });
    if (!ctx.propertyMatched) return res.json({ connected: true, propertyMatched: false });

    const contents = await Content.find({
      workspaceId: req.workspace._id, publishedUrl: { $nin: [null, ''] },
    }).select('_id contentNumber publishedUrl').lean();

    const [{ rows, truncated }, decay, applyCreditCost] = await Promise.all([
      syncStriking(req.workspace._id, ctx.orgId, ctx.siteUrl),
      syncDecay(req.workspace._id, ctx.orgId, ctx.siteUrl, contents),
      resolveApplyCost(ctx.orgId),
    ]);

    res.json({
      connected: true,
      propertyMatched: true,
      opportunities: rows.slice(0, 25),
      decayOpportunities: decay.matched,
      unmappedDecliningPages: decay.unmapped,
      truncated,
      applyCreditCost,
    });
  } catch (err) {
    if (err.code === 'GSC_NOT_CONNECTED') return res.status(400).json({ error: 'GSC access revoked. Please reconnect.', code: 'GSC_REVOKED' });
    if (err.code === 429 || err.status === 429) return res.status(502).json({ error: 'Search Console is rate-limiting requests. Try again shortly.' });
    console.error('getWorkspaceOpportunities error:', err.message);
    res.status(500).json({ error: 'Failed to fetch opportunities' });
  }
};

// ─── GET content-level (relevance split) ─────────────────────────────────────

const getContentOpportunities = async (req, res) => {
  try {
    const content = await Content.findByNumber(req.workspace._id, req.params.contentNumber);
    if (!content) return res.status(404).json({ error: 'Content not found' });
    // B4: same lock gate as getContent — a locked doc leaks no data.
    if (content.locked) return res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });

    const ctx = await resolveGscContext(req.workspace);
    if (!ctx.connected) return res.json({ connected: false });
    if (!ctx.propertyMatched) return res.json({ connected: true, propertyMatched: false });

    const [{ rows, truncated }, applyCreditCost] = await Promise.all([
      syncStriking(req.workspace._id, ctx.orgId, ctx.siteUrl),
      resolveApplyCost(ctx.orgId),
    ]);

    // Relevance split against this content's target keywords.
    const keywordStems = new Set();
    for (const kw of content.targetKeywords || []) {
      for (const s of relevantStems(kw)) keywordStems.add(s);
    }
    const contentOpportunities = [];
    const siteOpportunities = [];
    for (const r of rows) {
      if (isRelevant(r.keyword, keywordStems)) contentOpportunities.push(r);
      else siteOpportunities.push(r);
    }

    // Decay for this content (only if it has a publishedUrl). We only surface
    // THIS article's own decline here — the "unmapped" list is a workspace-level
    // concept (every OTHER declining page) and would be pure noise in a
    // single-article panel, so it's intentionally omitted.
    let decayOpportunities = [];
    if (content.publishedUrl) {
      const decay = await syncDecay(req.workspace._id, ctx.orgId, ctx.siteUrl, [content]);
      decayOpportunities = decay.matched;
    }

    res.json({
      connected: true,
      propertyMatched: true,
      contentOpportunities: contentOpportunities.slice(0, 15),
      siteOpportunities: siteOpportunities.slice(0, 10),
      decayOpportunities,
      truncated,
      applyCreditCost,
    });
  } catch (err) {
    if (err.code === 'GSC_NOT_CONNECTED') return res.status(400).json({ error: 'GSC access revoked. Please reconnect.', code: 'GSC_REVOKED' });
    if (err.code === 429 || err.status === 429) return res.status(502).json({ error: 'Search Console is rate-limiting requests. Try again shortly.' });
    console.error('getContentOpportunities error:', err.message);
    res.status(500).json({ error: 'Failed to fetch opportunities' });
  }
};

// ─── POST apply ──────────────────────────────────────────────────────────────

// The human keyword for an opportunity: the query for striking rows, the stored
// top query for decay rows (whose identity query is '').
function opportunityKeyword(opp) {
  return opp.query || opp.topQuery || '';
}

function buildAgentGoal(opp) {
  const q = opportunityKeyword(opp);
  if (opp.source === 'gsc_decay') {
    const forQuery = q ? ` for the query "${q}"` : '';
    const target = q ? 'the sections that target this query' : 'its core sections';
    return `This published article is losing search traffic${forQuery}. Refresh it: update stale facts and dates, strengthen ${target}, and add depth where competitors now cover more — the goal is to recover lost rankings.`;
  }
  const p = opp.metrics?.position;
  const imp = opp.metrics?.impressions;
  const pos = p != null ? `currently position ${p}` : 'currently on page 2';
  const impr = imp != null ? `, ${imp} impressions/mo` : '';
  return `Strengthen this article for the search query "${q}" (${pos}${impr}): weave the query in naturally, close intent gaps, and add or expand a section if warranted so it can break into the top 10.`;
}

const applyOpportunity = async (req, res) => {
  try {
    const opp = await Opportunity.findOne({ _id: req.params.id, workspaceId: req.workspace._id });
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });

    // Resolve the content this is being applied to: explicit body wins, else the
    // opportunity's own contentId (decay rows carry one).
    let content = null;
    if (req.body?.contentNumber != null) {
      content = await Content.findByNumber(req.workspace._id, req.body.contentNumber);
    } else if (opp.contentId) {
      content = await Content.findById(opp.contentId);
    }
    if (!content) return res.status(400).json({ error: 'A target content is required to apply this opportunity' });
    // B4: never apply an opportunity onto locked content (it mutates the doc —
    // appliedGscQueries — and resyncs the editor session). Same gate as getContent.
    if (content.locked) return res.status(403).json({ error: 'This content is locked. Upgrade your plan to regain access.', locked: true });

    // Mark applied (idempotent: re-applying just refreshes the link/timestamp).
    if (opp.status !== 'applied' && opp.status !== 'recovered') {
      opp.status = 'applied';
      opp.appliedAt = new Date();
    }
    opp.contentId = content._id;
    await opp.save();

    // Append the keyword to the content's applied set (deduped, capped) so brief
    // injection targets it, then resync any live editor session.
    const keyword = opportunityKeyword(opp);
    if (keyword) {
      const set = new Set(content.appliedGscQueries || []);
      if (!set.has(keyword)) {
        content.appliedGscQueries = [...(content.appliedGscQueries || []), keyword].slice(-10);
        await content.save();
      }
    }
    await aiController.resyncBriefIfActive(content._id);

    res.json({ opportunity: opp.toObject(), agentGoal: buildAgentGoal(opp), contentNumber: content.contentNumber });
  } catch (err) {
    console.error('applyOpportunity error:', err.message);
    res.status(500).json({ error: 'Failed to apply opportunity' });
  }
};

// ─── POST dismiss ────────────────────────────────────────────────────────────

const dismissOpportunity = async (req, res) => {
  try {
    const opp = await Opportunity.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspace._id },
      { $set: { status: 'dismissed', dismissedAt: new Date() } },
      { new: true },
    );
    if (!opp) return res.status(404).json({ error: 'Opportunity not found' });
    res.json({ opportunity: opp.toObject() });
  } catch (err) {
    console.error('dismissOpportunity error:', err.message);
    res.status(500).json({ error: 'Failed to dismiss opportunity' });
  }
};

module.exports = {
  getWorkspaceOpportunities,
  getContentOpportunities,
  applyOpportunity,
  dismissOpportunity,
  // exported for tests
  _internals: { isRelevant, relevantStems, buildAgentGoal },
};
