const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    subject: { type: String, required: true },
    htmlContent: { type: String, required: true },
    description: { type: String, default: '' },
    createdBy: { type: String, default: 'admin' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
