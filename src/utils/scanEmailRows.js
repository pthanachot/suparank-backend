/**
 * The four `<tr>` fragments substituted into the `scan_completed` email.
 *
 * WHY THESE ARE A MODULE. They used to be inline inside
 * aiTrackerController.executeScan, which made them unreachable to anything
 * else — so the preview harness kept a hand-copy of the markup. That copy
 * silently drifted out of the Phase 1 token sweep and spent a while rendering
 * the retired palette, which meant every screenshot taken from the harness was
 * wrong about the email it claimed to be previewing. Importable functions
 * remove the copy, and let the markup be tested directly.
 *
 * ESCAPING. Every interpolated string goes through htmlEscape. Some of it is
 * genuinely hostile: `prompt` is user-authored, and `competitor.name` is
 * extracted by an LLM and therefore reachable by prompt injection. Numbers and
 * server-generated enums are escaped too, for defence in depth.
 *
 * Cells name `font-family` explicitly. Outlook's Word engine does not cascade
 * it into nested tables, so a cell relying on inheritance renders in Times New
 * Roman there and nowhere else.
 */

const { htmlEscape } = require('./htmlEscape');
const { FONT_STACK } = require('./emailTheme');

const BORDER = '#F3F4F6';
const FG = '#111827';
const FG_2 = '#4B5563';
const FG_MUTED = '#9CA3AF';

const cell = (extra = '') => `font-family:${FONT_STACK};${extra}`;

/** Per-platform visibility/mentions/citations, current scan only. */
function buildPlatformRows(platStats = [], resultCount = 0) {
  return platStats
    .map((p) => {
      const total = resultCount - p.errorCount;
      const errorCell =
        p.errorCount > 0
          ? `<td style="${cell('padding:10px 16px;color:#EF4444;font-size:12px;')}">${p.errorCount} error${p.errorCount > 1 ? 's' : ''}</td>`
          : '<td></td>';
      return (
        `<tr style="border-bottom:1px solid ${BORDER};">` +
        `<td style="${cell(`padding:10px 16px;font-weight:600;color:${FG};font-size:13px;`)}">${htmlEscape(p.name)}</td>` +
        `<td style="${cell(`padding:10px 16px;color:${FG_2};font-size:13px;`)}">${htmlEscape(p.visibility)}%</td>` +
        `<td style="${cell(`padding:10px 16px;color:${FG_2};font-size:13px;`)}">${htmlEscape(p.mentionCount)} / ${htmlEscape(total)}</td>` +
        `<td style="${cell(`padding:10px 16px;color:${FG_2};font-size:13px;`)}">${htmlEscape(p.citationCount)}</td>` +
        `${errorCell}</tr>`
      );
    })
    .join('');
}

/** Per-prompt rows: scanned-this-run first (green badge), then carry-forward. */
function buildPromptRows(allEmailResults = []) {
  return allEmailResults
    .map((r) => {
      const valid = r.platforms.filter((p) => !p.error);
      const mentioned = valid.filter((p) => p.mentioned).length;
      const cited = valid.filter((p) => p.cited).length;
      return {
        prompt: r.prompt,
        mentioned,
        total: valid.length,
        mRate: valid.length > 0 ? Math.round((mentioned / valid.length) * 100) : 0,
        cRate: valid.length > 0 ? Math.round((cited / valid.length) * 100) : 0,
        isCarryForward: r._isCarryForward,
        carryDate: r._carryDate,
      };
    })
    .sort((a, b) => {
      if (a.isCarryForward !== b.isCarryForward) return a.isCarryForward ? 1 : -1;
      return b.mRate - a.mRate;
    })
    .map((r, i) => {
      // r.prompt is user-controlled (set during prompt CRUD). Escape before
      // embedding to prevent injection via <style>, <img>, handlers (F4-23).
      const truncated = r.prompt.length > 70 ? `${r.prompt.slice(0, 70)}…` : r.prompt;
      const statusCell = r.isCarryForward
        ? `<td style="${cell('padding:9px 14px;white-space:nowrap;')}"><span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;background:${BORDER};color:#6B7280;">${
            r.carryDate
              ? htmlEscape(new Date(r.carryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
              : 'prev'
          }</span></td>`
        : `<td style="${cell('padding:9px 14px;white-space:nowrap;')}"><span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;background:#ECFDF5;color:#047857;">&#10003; New</span></td>`;
      return (
        `<tr style="border-bottom:1px solid ${BORDER};">${statusCell}` +
        `<td style="${cell(`padding:9px 14px;color:${FG_MUTED};font-size:12px;`)}">${i + 1}</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG};font-size:13px;`)}">${htmlEscape(truncated)}</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG_2};font-size:13px;`)}">${htmlEscape(r.mentioned)}/${htmlEscape(r.total)}</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG_2};font-size:13px;`)}">${htmlEscape(r.mRate)}%</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG_2};font-size:13px;`)}">${htmlEscape(r.cRate)}%</td></tr>`
      );
    })
    .join('');
}

/** Top competitors (max 10). `name` is LLM-extracted — a prompt-injection surface. */
function buildCompetitorRows(sortedCompetitors = []) {
  return sortedCompetitors
    .slice(0, 10)
    .map(
      (c, i) =>
        `<tr style="border-bottom:1px solid ${BORDER};">` +
        `<td style="${cell(`padding:9px 14px;color:${FG_MUTED};font-size:12px;`)}">${i + 1}</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG};font-weight:600;font-size:13px;`)}">${htmlEscape(c.name)}</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG_2};font-size:13px;`)}">${htmlEscape(c.mentions)}</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG_2};font-size:13px;`)}">${htmlEscape(c.citations)}</td>` +
        `<td style="${cell(`padding:9px 14px;color:${FG_2};font-size:13px;`)}">${htmlEscape(c.visibility)}%</td></tr>`
    )
    .join('');
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_BG = { high: '#EF4444', medium: '#D97706', low: '#10B981' };

/**
 * Recommended actions (high priority first, max 5).
 * `accentColor` is the resolved brand primaryColor — the impact column tracks
 * the tenant's brand the same way the CTA does.
 */
function buildActionRows(actionItems = [], accentColor = '#2B5BE8') {
  return [...actionItems]
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 0) - (PRIORITY_ORDER[b.priority] ?? 0))
    .slice(0, 5)
    .map((item) => {
      const bg = PRIORITY_BG[item.priority] || PRIORITY_BG.low;
      return (
        `<tr style="border-bottom:1px solid ${BORDER};">` +
        `<td style="${cell('padding:10px 14px;white-space:nowrap;')}"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;color:#FFFFFF;background:${bg};">${htmlEscape(item.priority)}</span></td>` +
        `<td style="${cell('padding:10px 14px;')}"><div style="color:${FG};font-size:13px;font-weight:600;margin-bottom:2px;">${htmlEscape(item.title)}</div><div style="color:#6B7280;font-size:12px;">${htmlEscape(item.description)}</div></td>` +
        `<td style="${cell(`padding:10px 14px;color:${accentColor};font-size:12px;font-weight:600;white-space:nowrap;`)}">${htmlEscape(item.impact)}</td></tr>`
      );
    })
    .join('');
}

/** Shown when a section has nothing to report. */
const emptyRow = (colspan, text) =>
  `<tr><td colspan="${colspan}" style="${cell(`padding:12px 14px;color:${FG_MUTED};font-size:13px;`)}">${htmlEscape(text)}</td></tr>`;

module.exports = {
  buildPlatformRows,
  buildPromptRows,
  buildCompetitorRows,
  buildActionRows,
  emptyRow,
};
