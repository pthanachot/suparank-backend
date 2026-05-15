const mongoose = require('mongoose');

const triggerableEmailTemplateSchema = new mongoose.Schema(
  {
    triggerId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    defaultSubject: {
      type: String,
      default: null,
    },
    defaultHtml: {
      type: String,
      default: null,
    },
    lastTriggered: {
      type: Date,
      default: null,
    },
    triggerCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TriggerableEmailTemplate', triggerableEmailTemplateSchema, 'emailtriggers');
