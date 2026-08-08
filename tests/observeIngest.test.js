'use strict';

/**
 * Wave 0 review fixes — ingestObservations hardening.
 *
 * F2: organizationId is DERIVED from workspaceNumber server-side; the
 *     client-controlled payload.orgId must never become the attribution.
 * F6: oversized payloads are replaced with { _truncated: true }, the event
 *     itself still stored.
 * §3.5: impersonated sessions stamp impersonatedBy on every row.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('./helpers/memoryMongo');

const ObservationEvent = require('../src/models/ObservationEvent');
const Workspace = require('../src/models/Workspace');
const { ingestObservations } = require('../src/controllers/observeController');

const oid = () => new mongoose.Types.ObjectId();

before(async () => { await connect(); });
after(async () => { await disconnect(); });
beforeEach(async () => { await clear(); });

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function ingest(events, user = { userId: oid() }) {
  const res = mockRes();
  await ingestObservations({ body: { events }, user }, res);
  return res;
}

test('F2: organizationId derives from the workspace, never from payload.orgId', async () => {
  const realOrg = oid();
  const spoofOrg = oid();
  // Raw insert: bypass any Workspace schema required fields.
  await Workspace.collection.insertOne({ workspaceNumber: 42, organizationId: realOrg });

  const res = await ingest([
    { event: 'ai_edit_applied', ts: Date.now(), payload: { workspaceNumber: 42, orgId: String(spoofOrg), rung: 'edit' } },
  ]);
  assert.equal(res.body.ok, true);

  const row = await ObservationEvent.findOne({ event: 'ai_edit_applied' }).lean();
  assert.ok(row, 'event stored');
  assert.equal(String(row.organizationId), String(realOrg), 'org comes from the workspace');
  assert.notEqual(String(row.organizationId), String(spoofOrg));
});

test('F2: no workspaceNumber → organizationId null, even with a spoofed orgId', async () => {
  await ingest([
    { event: 'time_to_first_word', ts: Date.now(), payload: { ms: 900, orgId: String(oid()) } },
  ]);
  const row = await ObservationEvent.findOne({ event: 'time_to_first_word' }).lean();
  assert.equal(row.organizationId, null);
});

test('F2: unknown workspaceNumber → organizationId null', async () => {
  await ingest([
    { event: 'ai_edit_applied', ts: Date.now(), payload: { workspaceNumber: 999999 } },
  ]);
  const row = await ObservationEvent.findOne({ event: 'ai_edit_applied' }).lean();
  assert.equal(row.organizationId, null);
});

test('F6: oversized payload is replaced, but its scoping fields survive', async () => {
  const realOrg = oid();
  await Workspace.collection.insertOne({ workspaceNumber: 7, organizationId: realOrg });
  const big = { workspaceNumber: 7, contentNumber: 3, blob: 'x'.repeat(10_000) };
  await ingest([{ event: 'ai_edit_reverted', ts: Date.now(), payload: big }]);
  const row = await ObservationEvent.findOne({ event: 'ai_edit_reverted' }).lean();
  assert.ok(row, 'event still stored');
  assert.deepEqual(row.payload, { _truncated: true }, 'blob replaced');
  assert.equal(row.workspaceNumber, 7, 'scoping read before truncation');
  assert.equal(row.contentNumber, 3);
  assert.equal(String(row.organizationId), String(realOrg), 'org derivation still works');
});

test('§3.5: impersonated sessions stamp impersonatedBy; normal sessions null', async () => {
  const admin = oid();
  await ingest(
    [{ event: 'plan_proposed', ts: Date.now(), payload: {} }],
    { userId: oid(), impersonatedBy: admin }
  );
  await ingest([{ event: 'drift_observed', ts: Date.now(), payload: {} }]);

  const imp = await ObservationEvent.findOne({ event: 'plan_proposed' }).lean();
  assert.equal(imp.impersonatedBy, String(admin));
  const norm = await ObservationEvent.findOne({ event: 'drift_observed' }).lean();
  assert.equal(norm.impersonatedBy, null);
});

test('unknown events are still silently dropped with a 2xx', async () => {
  const res = await ingest([{ event: 'not_a_real_event', ts: Date.now(), payload: {} }]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, 0);
  assert.equal(await ObservationEvent.countDocuments({}), 0);
});
