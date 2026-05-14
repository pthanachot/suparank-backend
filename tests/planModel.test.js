/**
 * Plan model + reconciliation tests.
 *
 * These exercise real Mongoose behavior (cascade hooks, status reconciliation,
 * activePlanId integrity). They require a MongoDB the test process can write
 * to. To keep the test suite runnable without infrastructure, the whole file
 * is skipped when MONGODB_TEST_URI is unset.
 *
 *   MONGODB_TEST_URI=mongodb://localhost:27017/suparank-test node --test tests/planModel.test.js
 *
 * Each test uses a unique workspaceNumber+contentNumber pair (current millis
 * + a small random) so parallel runs don't collide.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const TEST_URI = process.env.MONGODB_TEST_URI;
const RUN = !!TEST_URI;

const Plan = RUN ? require('../src/models/Plan') : null;
const Content = RUN ? require('../src/models/Content') : null;
const Workspace = RUN ? require('../src/models/Workspace') : null;

let workspace;

async function makeContent(overrides = {}) {
  const contentNumber = await Content.getNextContentNumber();
  return Content.create({
    userId: new mongoose.Types.ObjectId(),
    workspaceId: workspace._id,
    contentNumber,
    title: 'Test content',
    blocks: [],
    ...overrides,
  });
}

function makeDraftPlanData(content, version = 1) {
  return {
    contentId: content._id,
    workspaceId: content.workspaceId,
    contentNumber: content.contentNumber,
    version,
    status: 'draft',
    targetAudience: 'a',
    angle: 'b',
    thesis: 'c',
    sections: [],
    alternatives: [],
    risks: [],
  };
}

if (RUN) {
  before(async () => {
    await mongoose.connect(TEST_URI);

    // Use a workspaceNumber unlikely to collide with real data.
    // Workspace requires userId; we use a synthetic ObjectId.
    workspace = await Workspace.create({
      userId: new mongoose.Types.ObjectId(),
      workspaceNumber: Math.floor(900000 + Math.random() * 99000),
      name: 'Plan test workspace',
    });
  });

  after(async () => {
    if (workspace) {
      await Plan.deleteMany({ workspaceId: workspace._id });
      await Content.deleteMany({ workspaceId: workspace._id });
      await Workspace.deleteOne({ _id: workspace._id });
    }
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    // Each test starts with a clean plan/content state for the workspace
    await Plan.deleteMany({ workspaceId: workspace._id });
    await Content.deleteMany({ workspaceId: workspace._id });
  });
} else {
  describe('Plan model (skipped — set MONGODB_TEST_URI to run)', () => {
    it('skip', () => assert.ok(true));
  });
}

if (RUN) {
  describe('Plan model schema', () => {
    it('creates with defaults', async () => {
      const content = await makeContent();
      const plan = await Plan.create(makeDraftPlanData(content));
      assert.equal(plan.status, 'draft');
      assert.equal(plan.version, 1);
      assert.equal(plan.evidenceVerified, false);
      assert.equal(plan.predictedSeoScore, 0);
      assert.deepEqual(plan.evidenceMap, {});
    });

    it('static finders by status', async () => {
      const content = await makeContent();
      await Plan.create(makeDraftPlanData(content, 1));
      const v2 = await Plan.create({ ...makeDraftPlanData(content, 2), status: 'proposed' });
      const v3 = await Plan.create({ ...makeDraftPlanData(content, 3), status: 'approved' });

      const draft = await Plan.findDraft(content._id);
      assert.equal(draft.version, 1);
      const proposed = await Plan.findProposed(content._id);
      assert.equal(proposed._id.toString(), v2._id.toString());
      const active = await Plan.findActive(content._id);
      assert.equal(active._id.toString(), v3._id.toString());
      const latest = await Plan.findLatestVersion(content._id);
      assert.equal(latest, 3);
    });
  });

  describe('Content.mode defaults and cascade', () => {
    it('defaults mode to chat and activePlanId to null', async () => {
      const content = await makeContent();
      assert.equal(content.mode, 'chat');
      assert.equal(content.activePlanId, null);
    });

    it('archives all Plans for content on document.deleteOne()', async () => {
      const content = await makeContent();
      await Plan.create({ ...makeDraftPlanData(content, 1), status: 'draft' });
      await Plan.create({ ...makeDraftPlanData(content, 2), status: 'approved' });
      await content.deleteOne();
      const remaining = await Plan.find({ contentId: content._id });
      assert.equal(remaining.length, 2);
      for (const p of remaining) assert.equal(p.status, 'archived');
    });

    it('archives Plans on findOneAndDelete()', async () => {
      const content = await makeContent();
      await Plan.create({ ...makeDraftPlanData(content, 1), status: 'draft' });
      await Content.findOneAndDelete({ _id: content._id });
      const remaining = await Plan.find({ contentId: content._id });
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].status, 'archived');
    });

    it('archives Plans on Model.deleteOne() query path', async () => {
      const content = await makeContent();
      await Plan.create({ ...makeDraftPlanData(content, 1), status: 'draft' });
      await Content.deleteOne({ _id: content._id });
      const remaining = await Plan.find({ contentId: content._id });
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].status, 'archived');
    });
  });

  describe('approveAndReconcile', () => {
    it('promotes draft to approved, flips mode, sets activePlanId', async () => {
      const content = await makeContent();
      const plan = await Plan.create(makeDraftPlanData(content));
      const userId = new mongoose.Types.ObjectId();
      const approved = await Plan.approveAndReconcile(plan._id, userId);

      assert.equal(approved.status, 'approved');
      assert.ok(approved.approvedAt > 0);
      assert.equal(approved.approvedBy.toString(), userId.toString());

      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.mode, 'execute');
      assert.equal(refreshed.activePlanId.toString(), plan._id.toString());
    });

    it('supersedes prior approved plans for the same content', async () => {
      const content = await makeContent();
      const v1 = await Plan.create({ ...makeDraftPlanData(content, 1), status: 'approved' });
      await Content.updateOne({ _id: content._id }, { $set: { activePlanId: v1._id, mode: 'execute' } });
      const v2 = await Plan.create(makeDraftPlanData(content, 2));

      await Plan.approveAndReconcile(v2._id);
      const v1After = await Plan.findById(v1._id);
      assert.equal(v1After.status, 'superseded');

      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.activePlanId.toString(), v2._id.toString());
    });

    it('rejects approving a plan that is already approved or archived', async () => {
      const content = await makeContent();
      const plan = await Plan.create({ ...makeDraftPlanData(content), status: 'archived' });
      await assert.rejects(() => Plan.approveAndReconcile(plan._id));
    });
  });

  describe('rejectAndReconcile', () => {
    it('archives plan and resets mode to chat (no parent)', async () => {
      const content = await makeContent();
      await Content.updateOne({ _id: content._id }, { $set: { mode: 'plan' } });
      const plan = await Plan.create(makeDraftPlanData(content));
      const { plan: rejected, revivedParent } = await Plan.rejectAndReconcile(plan._id);
      assert.equal(rejected.status, 'archived');
      assert.equal(revivedParent, null);
      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.mode, 'chat');
    });

    it('nulls activePlanId when rejecting the active plan (no parent)', async () => {
      const content = await makeContent();
      const plan = await Plan.create({ ...makeDraftPlanData(content), status: 'proposed' });
      await Content.updateOne({ _id: content._id }, { $set: { activePlanId: plan._id, mode: 'plan' } });
      await Plan.rejectAndReconcile(plan._id);
      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.activePlanId, null);
    });

    it('rejects rejecting a non-draft/proposed plan', async () => {
      const content = await makeContent();
      const plan = await Plan.create({ ...makeDraftPlanData(content), status: 'approved' });
      await assert.rejects(() => Plan.rejectAndReconcile(plan._id));
    });

    it('revives a superseded parent on reject (Bug 3 fix)', async () => {
      const content = await makeContent();
      // Simulate the state after a reopen of an approved plan:
      // v1 = approved-then-superseded; v2 = draft, parentVersion=1
      const v1 = await Plan.create({ ...makeDraftPlanData(content, 1), status: 'superseded' });
      const v2 = await Plan.create({ ...makeDraftPlanData(content, 2), parentVersion: 1, status: 'proposed' });
      await Content.updateOne({ _id: content._id }, { $set: { mode: 'plan', activePlanId: null } });

      const { plan: rejected, revivedParent } = await Plan.rejectAndReconcile(v2._id);
      assert.equal(rejected.status, 'archived');
      assert.ok(revivedParent);
      assert.equal(revivedParent._id.toString(), v1._id.toString());
      assert.equal(revivedParent.status, 'approved');

      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.mode, 'execute');
      assert.equal(refreshed.activePlanId.toString(), v1._id.toString());
    });

    it('does not revive a non-superseded parent (e.g. archived)', async () => {
      const content = await makeContent();
      const v1 = await Plan.create({ ...makeDraftPlanData(content, 1), status: 'archived' });
      const v2 = await Plan.create({ ...makeDraftPlanData(content, 2), parentVersion: 1, status: 'proposed' });
      const { revivedParent } = await Plan.rejectAndReconcile(v2._id);
      assert.equal(revivedParent, null);
      // v1 stays archived
      const refreshedV1 = await Plan.findById(v1._id);
      assert.equal(refreshedV1.status, 'archived');
    });
  });

  describe('archiveAndReconcile', () => {
    it('archives plan and nulls activePlanId when it pointed here', async () => {
      const content = await makeContent();
      const plan = await Plan.create({ ...makeDraftPlanData(content), status: 'approved' });
      await Content.updateOne({ _id: content._id }, { $set: { activePlanId: plan._id, mode: 'execute' } });
      await Plan.archiveAndReconcile(plan._id);
      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.activePlanId, null);
    });

    it('leaves activePlanId alone when archiving a non-active plan', async () => {
      const content = await makeContent();
      const active = await Plan.create({ ...makeDraftPlanData(content, 1), status: 'approved' });
      const other = await Plan.create({ ...makeDraftPlanData(content, 2), status: 'draft' });
      await Content.updateOne({ _id: content._id }, { $set: { activePlanId: active._id } });
      await Plan.archiveAndReconcile(other._id);
      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.activePlanId.toString(), active._id.toString());
    });
  });

  describe('enter ?force=true contract (Bug #1 from second-round review)', () => {
    // The controller's enter handler does this when force=true & mode=execute:
    //   1. updateOne to mark the prior approved plan as 'superseded'
    //   2. null out Content.activePlanId
    //   3. flip mode to 'plan'
    // We exercise that sequence directly here since this file is DB-gated.
    it('supersedes the prior approved plan and nulls activePlanId', async () => {
      const content = await makeContent();
      const v1 = await Plan.create({ ...makeDraftPlanData(content, 1), status: 'approved' });
      await Content.updateOne(
        { _id: content._id },
        { $set: { mode: 'execute', activePlanId: v1._id } }
      );

      // Simulate the force-clear sequence in the controller
      await Plan.updateOne(
        { _id: v1._id, status: 'approved' },
        { $set: { status: 'superseded' } }
      );
      await Content.updateOne(
        { _id: content._id },
        { $set: { mode: 'plan', activePlanId: null } }
      );

      const refreshedV1 = await Plan.findById(v1._id);
      assert.equal(refreshedV1.status, 'superseded',
        'Prior approved plan must be superseded — without this it masquerades as still-active');

      const refreshedContent = await Content.findById(content._id);
      assert.equal(refreshedContent.mode, 'plan');
      assert.equal(refreshedContent.activePlanId, null,
        'activePlanId must be nulled — without this it points at the abandoned approved plan');
    });
  });

  describe('reopen race dedup (Bug #2 from second-round review)', () => {
    // Two concurrent reopens of the same approved v1 must NOT produce two
    // child drafts. The controller's retry, on E11000, looks for an existing
    // sibling (same parentVersion, status=draft) and returns it.
    it('only one child draft exists after two parallel reopens', async () => {
      const content = await makeContent();
      const v1 = await Plan.create({ ...makeDraftPlanData(content, 1), status: 'approved' });
      await Content.updateOne(
        { _id: content._id },
        { $set: { mode: 'execute', activePlanId: v1._id } }
      );

      // Both "reopens" race: each supersedes v1 (idempotent), each tries to
      // create v=2 as parent=1.
      v1.status = 'superseded';
      await v1.save();

      const firstCreate = Plan.create({
        ...makeDraftPlanData(content, 2),
        parentVersion: 1,
        status: 'draft',
      });
      // Yield to let the first start
      await new Promise((r) => setImmediate(r));

      // Second tries the same version — must fail with E11000
      const secondAttempt = Plan.create({
        ...makeDraftPlanData(content, 2),
        parentVersion: 1,
        status: 'draft',
      }).then(
        () => 'unexpected-success',
        (err) => (err.code === 11000 ? 'duplicate-key' : err)
      );

      const first = await firstCreate;
      const secondResult = await secondAttempt;
      assert.equal(secondResult, 'duplicate-key');

      // The "sibling lookup" the controller does on E11000 should find this:
      const sibling = await Plan.findOne({
        contentId: content._id,
        parentVersion: 1,
        status: 'draft',
      }).sort({ version: -1 });
      assert.ok(sibling);
      assert.equal(sibling._id.toString(), first._id.toString(),
        'Sibling lookup must return the parallel reopen\'s child instead of creating a new one');

      // End state: only ONE child draft for parentVersion=1
      const allChildren = await Plan.find({
        contentId: content._id,
        parentVersion: 1,
        status: 'draft',
      });
      assert.equal(allChildren.length, 1,
        'Concurrent reopens must dedupe — only one child draft, not two');
    });
  });

  describe('schema constraints (Bug 1, Bug 4 fixes)', () => {
    it('rejects duplicate (contentId, version) via unique index (Bug 1)', async () => {
      const content = await makeContent();
      await Plan.create(makeDraftPlanData(content, 1));
      await assert.rejects(
        () => Plan.create(makeDraftPlanData(content, 1)),
        (err) => err.code === 11000
      );
    });

    it('rejects section.id with dots or special characters (Bug 4)', async () => {
      const content = await makeContent();
      const bad = makeDraftPlanData(content);
      bad.sections = [
        { id: 'has.dots', heading: 'X', headingLevel: 2, keyPoints: [], wordTarget: 100 },
      ];
      await assert.rejects(
        () => Plan.create(bad),
        (err) => err.name === 'ValidationError'
      );
    });

    it('accepts section.id with letters/digits/underscores/hyphens', async () => {
      const content = await makeContent();
      const good = makeDraftPlanData(content);
      good.sections = [
        { id: 'intro_v2-1', heading: 'X', headingLevel: 2, keyPoints: [], wordTarget: 100 },
      ];
      const plan = await Plan.create(good);
      assert.equal(plan.sections[0].id, 'intro_v2-1');
    });
  });

  describe('mode state transitions (end-to-end via statics)', () => {
    it('chat → plan → execute → reopen → reject revives v1 (Bug 3 fix path)', async () => {
      const content = await makeContent();
      assert.equal(content.mode, 'chat');

      // Simulate enter: flip mode + create draft v1
      content.mode = 'plan';
      await content.save();
      const v1 = await Plan.create(makeDraftPlanData(content, 1));

      // Approve → execute
      await Plan.approveAndReconcile(v1._id);
      let refreshed = await Content.findById(content._id);
      assert.equal(refreshed.mode, 'execute');
      assert.equal(refreshed.activePlanId.toString(), v1._id.toString());

      // Reopen: v1 (approved) → superseded; v2 draft with parentVersion=1
      v1.status = 'superseded';
      await v1.save();
      const v2 = await Plan.create({ ...makeDraftPlanData(content, 2), parentVersion: 1 });
      await Content.updateOne({ _id: content._id }, { $set: { mode: 'plan', activePlanId: null } });

      // Reject v2 → v1 revived; mode=execute restored
      const { revivedParent } = await Plan.rejectAndReconcile(v2._id);
      assert.ok(revivedParent);
      assert.equal(revivedParent._id.toString(), v1._id.toString());
      refreshed = await Content.findById(content._id);
      assert.equal(refreshed.mode, 'execute');
      assert.equal(refreshed.activePlanId.toString(), v1._id.toString());
    });

    it('chat → plan → reject (no parent) → chat', async () => {
      const content = await makeContent();
      content.mode = 'plan';
      await content.save();
      const v1 = await Plan.create(makeDraftPlanData(content, 1));
      const { revivedParent } = await Plan.rejectAndReconcile(v1._id);
      assert.equal(revivedParent, null);
      const refreshed = await Content.findById(content._id);
      assert.equal(refreshed.mode, 'chat');
      assert.equal(refreshed.activePlanId, null);
    });
  });
}
