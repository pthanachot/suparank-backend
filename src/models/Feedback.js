const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, required: true },
    feature: {
      type: String,
      required: true,
      enum: ['content-editor', 'ai-tracker', 'keyword-research', 'brand-voice'],
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '', maxlength: 500 },
    status: {
      type: String,
      enum: ['new', 'in_review', 'in_progress', 'resolved', 'closed'],
      default: 'new',
    },
    adminNote: { type: String, default: '' },
    adminRespondedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

feedbackSchema.index({ feature: 1, createdAt: -1 });
feedbackSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema, 'feedback');
