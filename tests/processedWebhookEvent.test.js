/**
 * Tests for ProcessedWebhookEvent.markProcessed — the atomic webhook dedup
 * primitive. The Model.create is stubbed to emulate the unique index:
 *   - first insert succeeds        → { firstTime: true }
 *   - duplicate insert throws 11000 → { firstTime: false }
 *   - any other error propagates    → so the caller lets Stripe retry.
 * No database.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const ProcessedWebhookEvent = require('../src/models/ProcessedWebhookEvent');

const realCreate = ProcessedWebhookEvent.create;
after(() => {
  ProcessedWebhookEvent.create = realCreate;
});

let seen; // emulated unique-index store keyed by eventId
beforeEach(() => {
  seen = new Set();
  ProcessedWebhookEvent.create = async (doc) => {
    if (seen.has(doc.eventId)) {
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    }
    seen.add(doc.eventId);
    return doc;
  };
});

describe('ProcessedWebhookEvent.markProcessed', () => {
  it('returns firstTime:true on a new event', async () => {
    const res = await ProcessedWebhookEvent.markProcessed('evt_1', 'invoice.paid', null);
    assert.deepEqual(res, { firstTime: true });
  });

  it('returns firstTime:false on a duplicate event', async () => {
    await ProcessedWebhookEvent.markProcessed('evt_1', 'invoice.paid', 'acct_9');
    const dup = await ProcessedWebhookEvent.markProcessed('evt_1', 'invoice.paid', 'acct_9');
    assert.deepEqual(dup, { firstTime: false });
  });

  it('propagates non-duplicate errors', async () => {
    ProcessedWebhookEvent.create = async () => {
      throw new Error('connection reset');
    };
    await assert.rejects(
      () => ProcessedWebhookEvent.markProcessed('evt_2', 'x'),
      /connection reset/
    );
  });
});
