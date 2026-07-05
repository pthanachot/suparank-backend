const mongoose = require('mongoose');

/**
 * ProcessedWebhookEvent (Phase 16) — the idempotency store the Stripe webhook
 * system currently lacks.
 *
 * Stripe may deliver the same event more than once (retries, at-least-once
 * delivery). Every webhook handler should dedup on `event.id` BEFORE doing any
 * side effect. This model is the atomic dedup primitive: the unique index on
 * `eventId` turns "have I seen this event?" into an insert that either succeeds
 * (first time) or fails with duplicate-key 11000 (already processed).
 *
 * Usage at the top of a handler:
 *
 *   if (!(await ProcessedWebhookEvent.markProcessed(
 *          event.id, event.type, event.account)).firstTime) return;
 *
 * A TTL index expires rows 30 days after processing. Stripe only retries for ~3
 * days, so 30 days is ample margin while keeping the collection bounded.
 */
const processedWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      // Stripe event.id — the dedup key.
    },
    type: { type: String, default: null },
    connectedAccountId: {
      type: String,
      default: null,
      // event.account for Connect events; null for platform-account events.
    },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// TTL: auto-remove 30 days after processing (Stripe retries for ~3 days).
processedWebhookEventSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 }
);

/**
 * Atomically record that an event has been processed.
 *
 * Inserts a row keyed on `eventId`. Returns `{ firstTime: true }` on a fresh
 * insert and `{ firstTime: false }` when the row already exists (duplicate-key
 * 11000) — i.e. the event was already processed and the caller should bail out.
 * Any non-11000 error propagates so the caller can let Stripe retry.
 *
 * @param {string} eventId  Stripe event.id
 * @param {string} [type]   Stripe event.type
 * @param {string|null} [connectedAccountId]  Stripe event.account (Connect)
 * @returns {Promise<{ firstTime: boolean }>}
 */
processedWebhookEventSchema.statics.markProcessed = async function (
  eventId,
  type = null,
  connectedAccountId = null
) {
  try {
    await this.create({ eventId, type, connectedAccountId });
    return { firstTime: true };
  } catch (err) {
    if (require('../utils/mongoErrors').isDuplicateKeyError(err)) {
      // Already processed — a concurrent/duplicate delivery lost the race.
      return { firstTime: false };
    }
    throw err;
  }
};

module.exports = mongoose.model('ProcessedWebhookEvent', processedWebhookEventSchema);
