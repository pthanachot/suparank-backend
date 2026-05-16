const Feedback = require('../models/Feedback');
const { sendEmail } = require('../utils/emailService');
const { applyCustomTemplate } = require('./emailPortalController');

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
      const emailOptions = {
        to: SUPPORT_EMAIL,
        data: {
          feature,
          rating: String(rating),
          stars,
          comment: comment || '(no comment)',
          userEmail: email,
          submittedAt: new Date().toISOString(),
        },
      };
      await applyCustomTemplate('feedback_submitted', emailOptions);

      // Fallback if template resolution didn't populate subject/html
      if (!emailOptions.subject) {
        emailOptions.subject = `[SupaRank Feedback] ${stars} — ${feature}`;
        emailOptions.html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
  <h2 style="color:#111;margin-bottom:4px;">New Feedback Received</h2>
  <table style="width:100%;border-collapse:collapse;margin:24px 0;">
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;width:140px;">Feature</td><td style="padding:8px 0;color:#111;">${feature}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">Rating</td><td style="padding:8px 0;color:#FFA163;font-size:20px;">${stars}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;">User</td><td style="padding:8px 0;color:#111;">${email}</td></tr>
    <tr><td style="padding:8px 0;color:#374151;font-weight:600;vertical-align:top;">Comment</td><td style="padding:8px 0;color:#111;">${comment || '(none)'}</td></tr>
  </table>
</div>`;
      }

      await sendEmail(emailOptions);
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

    const fb = await Feedback.findByIdAndUpdate(id, update, { new: true });
    if (!fb) return res.status(404).json({ error: 'Feedback not found' });

    res.json({ success: true, feedback: fb });
  } catch (error) {
    console.error('[feedback] updateFeedback error:', error.message);
    res.status(500).json({ error: 'Failed to update feedback' });
  }
};

module.exports = { submitFeedback, getFeedbackList, getFeedbackStats, updateFeedback };
