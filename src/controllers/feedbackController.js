const Feedback = require('../models/Feedback');
const { sendEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');
const { htmlEscape, subjectSafe } = require('../utils/htmlEscape');

const SUPPORT_EMAIL = 'support@suparank.ai';

// ─── POST /api/feedback — submit feedback ───────────────────

const submitFeedback = async (req, res) => {
  try {
    const { feature, rating, comment } = req.body;
    const { userId, email } = req.user;

    if (!feature || !rating) {
      return res.status(400).json({ error: 'feature and rating are required' });
    }

    const fb = await Feedback.create({
      userId,
      userEmail: email,
      feature,
      rating,
      comment: (comment || '').slice(0, 500),
    });

    // Send email notification to support (best-effort, non-blocking)
    try {
      const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
      // Escape before applyCustomTemplate: it substitutes into the template
      // with a raw String(value) replace, and `feedback_submitted` always
      // resolves a template, so this is the live path. `feature` and `comment`
      // are user-supplied, which without this let any signed-in user put
      // arbitrary HTML into the support inbox. `stars` is built here from a
      // numeric rating and holds no user input.
      const emailOptions = {
        to: SUPPORT_EMAIL,
        data: {
          feature: htmlEscape(feature),
          rating: String(rating),
          stars,
          comment: htmlEscape(comment || '(no comment)'),
          userEmail: htmlEscape(email),
          submittedAt: htmlEscape(new Date().toISOString()),
        },
      };
      await applyCustomTemplate('feedback_submitted', emailOptions);

      // Undo entity escaping in the Subject only; it is plain text. See subjectSafe.
      if (emailOptions.subject) emailOptions.subject = subjectSafe(emailOptions.subject);

      // See publicContactController. The feedback row is already persisted at
      // this point, so skipping the notification loses only the nudge — an
      // empty email in the support inbox would lose the signal entirely.
      // Skipping the SEND rather than returning early: the success response is
      // built once, below, so the two paths cannot drift apart.
      if (!emailOptions.subject || !emailOptions.html) {
        console.error('[feedback] template resolved to nothing — not sending an empty email');
      } else {
        await sendEmail(emailOptions);
      }
    } catch (emailErr) {
      console.error('[feedback] Failed to send notification email:', emailErr.message);
    }

    res.status(201).json({ success: true, feedbackId: fb._id });
  } catch (error) {
    console.error('[feedback] submitFeedback error:', error.message);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
};

// ─── Admin: GET /api/admin/feedback ─────────────────────────

const getFeedbackList = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 25;
    const { feature, status, minRating, maxRating } = req.query;

    const filter = {};
    if (feature) filter.feature = feature;
    if (status) filter.status = status;
    if (minRating || maxRating) {
      filter.rating = {};
      if (minRating) filter.rating.$gte = Number(minRating);
      if (maxRating) filter.rating.$lte = Number(maxRating);
    }

    const [items, total] = await Promise.all([
      Feedback.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Feedback.countDocuments(filter),
    ]);

    res.json({
      feedback: items,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[feedback] getFeedbackList error:', error.message);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
};

// ─── Admin: GET /api/admin/feedback/stats ───────────────────

const getFeedbackStats = async (req, res) => {
  try {
    const [total, avgAgg, byFeature, dist, byStatus] = await Promise.all([
      Feedback.countDocuments(),
      Feedback.aggregate([{ $group: { _id: null, avg: { $avg: '$rating' } } }]),
      Feedback.aggregate([{ $group: { _id: '$feature', count: { $sum: 1 }, avg: { $avg: '$rating' } } }]),
      Feedback.aggregate([{ $group: { _id: '$rating', count: { $sum: 1 } } }]),
      Feedback.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    const avgRating = avgAgg[0]?.avg ?? 0;
    const ratingDistribution = [1, 2, 3, 4, 5].map((r) => ({
      rating: r,
      count: dist.find((d) => d._id === r)?.count ?? 0,
    }));

    res.json({ total, avgRating, byFeature, ratingDistribution, byStatus });
  } catch (error) {
    console.error('[feedback] getFeedbackStats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch feedback stats' });
  }
};

// ─── Admin: PUT /api/admin/feedback/:id ─────────────────────

const updateFeedback = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body;

    const update = {};
    if (status) update.status = status;
    if (adminNote !== undefined) update.adminNote = adminNote;
    if (status === 'resolved' || status === 'closed') {
      update.adminRespondedAt = new Date();
    }

    // runValidators enforces the status enum (new/in_review/in_progress/
    // resolved/closed) — findByIdAndUpdate skips schema validation by default.
    const fb = await Feedback.findByIdAndUpdate(id, update, { new: true, runValidators: true });
    if (!fb) return res.status(404).json({ error: 'Feedback not found' });

    res.json({ success: true, feedback: fb });
  } catch (error) {
    if (error.name === 'ValidationError') return res.status(400).json({ error: error.message });
    console.error('[feedback] updateFeedback error:', error.message);
    res.status(500).json({ error: 'Failed to update feedback' });
  }
};

module.exports = { submitFeedback, getFeedbackList, getFeedbackStats, updateFeedback };
