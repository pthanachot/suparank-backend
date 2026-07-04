const mongoose = require('mongoose');

const triggerableEmailTemplateSchema = new mongoose.Schema(
  {
    triggerId: {
      type: String,
      required: true,
    },
    // null = the GLOBAL admin override (legacy rows have no field at all —
    // query with $or: [{organizationId: null}, {organizationId: {$exists: false}}]).
    // A set organizationId = a per-tenant override (Phase 12).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
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

// One row per trigger per scope (global scope = organizationId null).
// NOTE: prod Mongo has a legacy unique index on triggerId alone — run
// src/scripts/migrateEmailTemplateIndexes.js before deploying tenant overrides.
triggerableEmailTemplateSchema.index({ triggerId: 1, organizationId: 1 }, { unique: true });

module.exports = mongoose.model('TriggerableEmailTemplate', triggerableEmailTemplateSchema, 'emailtriggers');
