/**
 * Data export service (Phase 18B) — serialise a workspace or an entire org into a
 * downloadable tar.gz. Serves three needs: agency offboarding, client
 * offboarding, and GDPR data portability.
 *
 * Layout (per-workspace):
 *   manifest.json                          — workspace meta + counts + timestamp
 *   content/<num>-<slug>.md | .html | .json
 *   ai-tracker/<name>-<id>/{tracker,prompts,scans}.json
 *   reports/<period>.json
 *   keyword-research.json
 *   brand-voices.json
 *
 * Per-org wraps each workspace under workspaces/<name>-<id>/… and adds org-level
 * files (organization.json, agency-plans.json, client-subscriptions.json,
 * brand-config.json).
 *
 * Content is emitted three ways: Markdown (blocksToMarkdown), a standalone HTML
 * document, and the raw JSON (lossless). The whole archive is built in memory —
 * fine for occasional exports, not for unbounded datasets.
 */

const Content = require('../models/Content');
const AiTracker = require('../models/AiTracker');
const AiTrackerPrompt = require('../models/AiTrackerPrompt');
const AiTrackerScan = require('../models/AiTrackerScan');
const AiThread = require('../models/AiThread');
const AiThreadMessage = require('../models/AiThreadMessage');
const ReportSnapshot = require('../models/ReportSnapshot');
const KeywordResearchHistory = require('../models/KeywordResearchHistory');
const BrandVoice = require('../models/BrandVoice');
const Workspace = require('../models/Workspace');
const Organization = require('../models/Organization');
const AgencyPlan = require('../models/AgencyPlan');
const ClientSubscription = require('../models/ClientSubscription');

const { blocksToMarkdown } = require('./blocksToMarkdown');
const brandService = require('./brandService');
const { createTarGz } = require('../utils/tar');

// ─── helpers ────────────────────────────────────────────────────────

/** File-name-safe slug: ascii, hyphen-separated, capped short so composed tar
 *  paths (org-export prefix + content/tracker segment) stay well within the
 *  ustar 255-byte name+prefix budget. */
function slugify(s, max = 40) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'untitled';
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── blocks → standalone HTML document ──
// block.text already holds inline HTML (produced by the editor / markdownToBlocks),
// so text-bearing blocks are wrapped, not escaped. Plain-text fields (code, table
// cells) ARE escaped.

function renderBlockHtml(b) {
  const t = b.text || '';
  switch (b.type) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return `<${b.type}>${t}</${b.type}>`;
    case 'p': return `<p>${t}</p>`;
    case 'quote': return `<blockquote>${t}</blockquote>`;
    case 'divider': return '<hr>';
    case 'img':
      // width/height let the browser reserve the box before the image loads
      // (no layout shift), matching the editor's own HTML export.
      return b.src
        ? `<figure><img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt || '')}"${
            b.intrinsicWidth && b.intrinsicHeight ? ` width="${b.intrinsicWidth}" height="${b.intrinsicHeight}"` : ''
          }></figure>`
        : '';
    case 'code': {
      const code = escapeHtml(b.codeData?.code || t);
      const lang = b.codeData?.language ? ` class="language-${escapeHtml(b.codeData.language)}"` : '';
      return `<pre><code${lang}>${code}</code></pre>`;
    }
    case 'cta':
      return b.ctaData?.url
        ? `<p><a href="${escapeHtml(b.ctaData.url)}">${escapeHtml(b.ctaData.buttonText || 'Learn more')}</a></p>`
        : '';
    case 'faq':
      return '<dl>' + (b.faqItems || []).map((f) =>
        `<dt>${escapeHtml(f.question || '')}</dt><dd>${escapeHtml(f.answer || '')}</dd>`).join('') + '</dl>';
    case 'table': {
      // tableData stores `headers` and `rows` as SEPARATE fields (rows does NOT
      // include the header) — mirror blocksToMarkdown. Guard non-array rows.
      const headers = Array.isArray(b.tableData?.headers) ? b.tableData.headers : [];
      const rows = Array.isArray(b.tableData?.rows) ? b.tableData.rows : [];
      if (!headers.length && !rows.length) return '';
      // Caption and per-column alignment are real markup, so the archive
      // export carries them too — matching the editor's own HTML export.
      const aligns = Array.isArray(b.tableData?.columnAligns) ? b.tableData.columnAligns : [];
      const alignAttr = (i) =>
        aligns[i] && aligns[i] !== 'left' ? ` style="text-align:${escapeHtml(aligns[i])}"` : '';
      const cap = b.tableData?.caption ? `<caption>${escapeHtml(b.tableData.caption)}</caption>` : '';
      const th = headers.length
        ? `<thead><tr>${headers.map((c, i) => `<th${alignAttr(i)}>${escapeHtml(c)}</th>`).join('')}</tr></thead>`
        : '';
      const tb = rows
        .map((r) => `<tr>${(Array.isArray(r) ? r : []).map((c, i) => `<td${alignAttr(i)}>${escapeHtml(c)}</td>`).join('')}</tr>`)
        .join('');
      return `<table>${cap}${th}<tbody>${tb}</tbody></table>`;
    }
    case 'toggle':
      return `<details><summary>${t}</summary></details>`;
    case 'embed':
      return b.src ? `<p><a href="${escapeHtml(b.src)}">${escapeHtml(b.src)}</a></p>` : '';
    case 'toc': return ''; // navigational; regenerated on import
    default: return t ? `<p>${t}</p>` : '';
  }
}

function renderBlocksHtml(blocks = []) {
  blocks = (blocks || []).filter(Boolean); // tolerate null slots persisted in blocks[]
  const out = [];
  let i = 0;
  while (i < blocks.length) {
    const type = blocks[i].type;
    if (type === 'li' || type === 'ol') {
      const tag = type === 'ol' ? 'ol' : 'ul';
      const items = [];
      while (i < blocks.length && blocks[i].type === type) {
        items.push(`  <li>${blocks[i].text || ''}</li>`);
        i++;
      }
      out.push(`<${tag}>\n${items.join('\n')}\n</${tag}>`);
    } else {
      out.push(renderBlockHtml(blocks[i]));
      i++;
    }
  }
  return out.join('\n');
}

function contentToHtmlDoc(content, blocks = content.blocks) {
  const title = escapeHtml(content.title || 'Untitled');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
<h1>${title}</h1>
${renderBlocksHtml(blocks || [])}
</body>
</html>
`;
}

// ─── per-workspace serialisation ────────────────────────────────────

/**
 * Return an array of { name, data } tar entries for one workspace. `prefix`
 * (e.g. 'workspaces/acme-<id>/') namespaces entries inside an org-level export.
 */
async function serializeWorkspace(workspaceId, prefix = '') {
  const entries = [];
  const p = prefix;

  const workspace = await Workspace.findById(workspaceId)
    .select('workspaceNumber name organizationId color createdAt')
    .lean();
  if (!workspace) return entries;

  // ── content ──
  // B4: exclude locked content BODIES (paid-created, then downgraded to free).
  // The body must not leak — the same invariant contentController.getContent
  // enforces on read. (P5 review: erasureController only DELETES — this tar is
  // the system's only export, so the exclusion must be visible in the manifest
  // and must not swallow the user's own conversation prompts; see below.)
  // -favoritedBy: the per-user star list is internal state, and the .json entry
  // below dumps the whole document — without this the export bundle would carry
  // member ObjectIds. Same invariant contentController enforces on every read.
  const contents = await Content.find({ workspaceId, locked: { $ne: true } }).select('-favoritedBy').lean();
  for (const c of contents) {
    // Filter null slots — blocksToMarkdown/renderBlocksHtml deref block fields and
    // Mongoose can persist a null element in a DocumentArray.
    const blocks = (Array.isArray(c.blocks) ? c.blocks : []).filter(Boolean);
    const base = `${p}content/${c.contentNumber}-${slugify(c.title || c.slug)}`;
    entries.push({ name: `${base}.md`, data: `# ${c.title || 'Untitled'}\n\n${blocksToMarkdown(blocks)}` });
    entries.push({ name: `${base}.html`, data: contentToHtmlDoc(c, blocks) });
    entries.push({ name: `${base}.json`, data: json(c) });
  }

  // ── AI Tracker history (tracker + its prompts + its scans) ──
  const trackers = await AiTracker.find({ workspaceId }).lean();
  for (const tr of trackers) {
    const dir = `${p}ai-tracker/${slugify(tr.name)}-${tr._id}`;
    const [prompts, scans] = await Promise.all([
      AiTrackerPrompt.find({ trackerId: tr._id }).lean(),
      AiTrackerScan.find({ trackerId: tr._id }).sort({ startedAt: 1 }).lean(),
    ]);
    entries.push({ name: `${dir}/tracker.json`, data: json(tr) });
    entries.push({ name: `${dir}/prompts.json`, data: json(prompts) });
    entries.push({ name: `${dir}/scans.json`, data: json(scans) });
  }

  // ── AI conversation threads (Threads P5 — GDPR portability: prompts are
  // user personal data). Grouped per content, children fetched per thread.
  // P5 review: conversations for LOCKED contents export too — the thread is
  // the user's own typed prompts + replies (Art. 20 "data provided by the
  // data subject"), not the paid deliverable, and it never contains the
  // locked body. Only the content body stays excluded; locked dirs are
  // suffixed so the omitted body is legible in the archive.
  const lockedContents = await Content.find({ workspaceId, locked: true })
    .select('_id contentNumber title slug').lean();
  const threadContents = contents.concat(lockedContents.map((c) => ({ ...c, _locked: true })));
  const contentIds = threadContents.map((c) => c._id);
  const threads = contentIds.length ? await AiThread.find({ contentId: { $in: contentIds } }).lean() : [];
  for (const t of threads) {
    if (!t.messageCount) continue; // empty artifacts — nothing to port
    const messages = await AiThreadMessage.find({ threadId: t._id }).sort({ seq: 1 }).lean();
    const c = threadContents.find((x) => String(x._id) === String(t.contentId));
    const cDir = c ? `${c.contentNumber}-${slugify(c.title || c.slug)}${c._locked ? '-locked' : ''}` : String(t.contentId);
    entries.push({ name: `${p}conversations/${cDir}/${t._id}.json`, data: json({ thread: t, messages }) });
  }

  // ── reports ──
  const reports = await ReportSnapshot.find({ workspaceId }).lean();
  for (const r of reports) {
    entries.push({ name: `${p}reports/${r.period || r._id}.json`, data: json(r) });
  }

  // ── keyword research history ──
  const keywords = await KeywordResearchHistory.find({ workspaceId }).sort({ searchedAt: 1 }).lean();
  if (keywords.length) {
    entries.push({ name: `${p}keyword-research.json`, data: json(keywords) });
  }

  // ── brand voices (NOTE: scoped by `workspace`, not `workspaceId`) ──
  const brandVoices = await BrandVoice.find({ workspace: workspaceId }).lean();
  if (brandVoices.length) {
    entries.push({ name: `${p}brand-voices.json`, data: json(brandVoices) });
  }

  // ── manifest ──
  entries.push({
    name: `${p}manifest.json`,
    data: json({
      generatedBy: 'SupaRank data export (Phase 18)',
      exportedAt: new Date().toISOString(),
      workspace: { id: String(workspace._id), number: workspace.workspaceNumber, name: workspace.name },
      counts: {
        content: contents.length,
        // P5 review: locked bodies are withheld by design — say so instead
        // of silently omitting them from a portability archive.
        lockedContentExcluded: lockedContents.length,
        aiTrackers: trackers.length,
        conversations: threads.filter((t) => t.messageCount).length,
        reports: reports.length,
        keywordSearches: keywords.length,
        brandVoices: brandVoices.length,
      },
    }),
  });

  return entries;
}

// ─── per-org serialisation ──────────────────────────────────────────

async function serializeOrg(orgId) {
  const entries = [];

  const org = await Organization.findById(orgId)
    .select('name slug ownerId createdAt lifecycleStatus stripeConnectAccountId connectChargesEnabled')
    .lean();
  if (!org) return entries;

  entries.push({ name: 'organization.json', data: json(org) });

  const [plans, subs, brand, workspaces] = await Promise.all([
    AgencyPlan.find({ organizationId: orgId }).lean(),
    ClientSubscription.find({ organizationId: orgId }).lean(),
    brandService.getBrandForOrg(orgId).catch(() => null),
    Workspace.find({ organizationId: orgId }).select('_id name workspaceNumber').lean(),
  ]);

  if (plans.length) entries.push({ name: 'agency-plans.json', data: json(plans) });
  if (subs.length) entries.push({ name: 'client-subscriptions.json', data: json(subs) });
  if (brand?.config) entries.push({ name: 'brand-config.json', data: json(brand.config) });

  for (const ws of workspaces) {
    const wsPrefix = `workspaces/${slugify(ws.name)}-${ws._id}/`;
    const wsEntries = await serializeWorkspace(ws._id, wsPrefix);
    entries.push(...wsEntries);
  }

  entries.push({
    name: 'manifest.json',
    data: json({
      generatedBy: 'SupaRank data export (Phase 18)',
      exportedAt: new Date().toISOString(),
      organization: { id: String(org._id), name: org.name, slug: org.slug },
      counts: { workspaces: workspaces.length, agencyPlans: plans.length, clientSubscriptions: subs.length },
    }),
  });

  return entries;
}

// ─── archive builders ───────────────────────────────────────────────

async function exportWorkspaceArchive(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select('name workspaceNumber').lean();
  const entries = await serializeWorkspace(workspaceId);
  const filename = `workspace-${ws?.workspaceNumber || workspaceId}-${slugify(ws?.name)}.tar.gz`;
  return { filename, buffer: createTarGz(entries) };
}

async function exportOrgArchive(orgId) {
  const org = await Organization.findById(orgId).select('slug').lean();
  const entries = await serializeOrg(orgId);
  const filename = `org-${slugify(org?.slug)}-export.tar.gz`;
  return { filename, buffer: createTarGz(entries) };
}

module.exports = {
  slugify,
  renderBlocksHtml,
  contentToHtmlDoc,
  serializeWorkspace,
  serializeOrg,
  exportWorkspaceArchive,
  exportOrgArchive,
};
