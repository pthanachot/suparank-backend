/**
 * Admin audit-log read API (Phase 15). Lists/filters/exports AdminAuditLog for
 * the operator. Read-only; all routes are behind adminMiddleware.
 */
const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');

const EXPORT_CAP = 10000;

// Build a Mongo filter from the query params (shared by list + export).
function buildFilter(q) {
  const filter = {};
  if (q.actor) {
    // partial, case-insensitive actor search (regex-escaped — no ReDoS/injection)
    const esc = String(q.actor).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.actorEmail = { $regex: esc, $options: 'i' };
  }
  if (q.action) filter.action = String(q.action);
  if (q.targetType) filter.targetType = String(q.targetType);
  if (q.targetId) filter.targetId = String(q.targetId);
  if (q.startDate || q.endDate) {
    const range = {};
    if (q.startDate) { const d = new Date(q.startDate); if (!isNaN(d.getTime())) range.$gte = d; }
    if (q.endDate) { const d = new Date(String(q.endDate) + 'T23:59:59.999Z'); if (!isNaN(d.getTime())) range.$lte = d; }
    if (Object.keys(range).length) filter.createdAt = range;
  }
  return filter;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ c: new Date(row.createdAt).toISOString(), i: String(row._id) })).toString('base64');
}
function decodeCursor(cursor) {
  try {
    const { c, i } = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
    const date = new Date(c);
    if (isNaN(date.getTime()) || !mongoose.Types.ObjectId.isValid(i)) return null;
    return { date, id: new mongoose.Types.ObjectId(i) };
  } catch {
    return null;
  }
}

const listAuditLog = async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const query = buildFilter(req.query);

    // Keyset pagination on the {createdAt:-1, _id:-1} feed index.
    if (req.query.cursor) {
      const cur = decodeCursor(req.query.cursor);
      if (cur) {
        query.$and = [
          ...(query.$and || []),
          { $or: [{ createdAt: { $lt: cur.date } }, { createdAt: cur.date, _id: { $lt: cur.id } }] },
        ];
      }
    }

    const rows = await AdminAuditLog.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      rows: page,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (error) {
    console.error('[admin] listAuditLog error:', error.message);
    res.status(500).json({ error: 'Failed to list audit log' });
  }
};

// Neutralize CSV/spreadsheet formula injection (same as exportCreditTransactions).
const escCsv = (val) => {
  let s = String(val ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportAuditLog = async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    // Fetch CAP+1 to detect (and surface) truncation rather than silently cap.
    const rows = await AdminAuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(EXPORT_CAP + 1).lean();
    const truncated = rows.length > EXPORT_CAP;
    const out = truncated ? rows.slice(0, EXPORT_CAP) : rows;

    const header = 'Date,Actor,Action,TargetType,TargetId,IP,Impersonated,Meta,Before,After';
    const lines = out.map((r) =>
      [
        r.createdAt ? new Date(r.createdAt).toISOString() : '',
        escCsv(r.actorEmail),
        escCsv(r.action),
        escCsv(r.targetType),
        escCsv(r.targetId),
        escCsv(r.ip),
        r.impersonated ? 'yes' : 'no',
        escCsv(JSON.stringify(r.meta ?? null)),
        escCsv(JSON.stringify(r.before ?? null)),
        escCsv(JSON.stringify(r.after ?? null)),
      ].join(',')
    );
    const csv = [header, ...lines].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=admin-audit-${new Date().toISOString().split('T')[0]}.csv`);
    if (truncated) res.setHeader('X-Truncated', String(EXPORT_CAP)); // surface the cap, not silent
    res.send(csv);
  } catch (error) {
    console.error('[admin] exportAuditLog error:', error.message);
    res.status(500).json({ error: 'Failed to export audit log' });
  }
};

module.exports = { listAuditLog, exportAuditLog, buildFilter, EXPORT_CAP };
