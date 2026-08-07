/**
 * Set up a downgrade test account that simulates Agency → Free tier downgrade.
 *
 * Creates:
 *   - User: test-e2e-downgrade@suparank.local
 *   - Org: E2E Downgrade Org (no subscription = free tier)
 *   - 3 workspaces: 1 unlocked (default) + 2 locked
 *   - 6 articles: 3 unlocked + 3 locked (createdOnPlan based)
 *   - 3 avatars: 1 unlocked + 2 locked
 *   - 6 keyword histories: 3 unlocked (free) + 3 locked (paid)
 *   - 1 AI tracker with 5 prompts: 2 unlocked (free) + 3 locked (paid)
 *
 * Run:  node setup-downgrade-test.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const http = require('http');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('Set MONGODB_URI to run this script.');
  process.exit(1);
}
const API_PORT = 4001;

const ACCT = {
  email: 'test-e2e-downgrade@suparank.local',
  password: 'TestPass123',
  name: 'E2E Downgrade',
};

// ── HTTP helper ──────────────────────────────────────────────
function apiPost(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(
      {
        method: 'POST',
        hostname: 'localhost',
        port: API_PORT,
        path,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, body: text }); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  // ── 1. Signup via API ──────────────────────────────────────
  console.log('=== 1. Signup ===');
  const signup = await apiPost('/api/auth/email-signup', {
    email: ACCT.email,
    password: ACCT.password,
    name: ACCT.name,
  });
  console.log(`  Status: ${signup.status} — ${signup.body?.message || signup.body?.error || 'ok'}`);

  // ── 2. MongoDB setup ──────────────────────────────────────
  console.log('\n=== 2. MongoDB ===');
  await mongoose.connect(MONGO_URI, { dbName: process.env.DB_NAME || 'suparank' });
  const db = mongoose.connection.db;
  const users       = db.collection('users');
  const orgs        = db.collection('organizations');
  const workspaces  = db.collection('workspaces');
  const contents    = db.collection('contents');
  const avatars     = db.collection('avatars');
  const subs        = db.collection('subscriptions');
  const kwHistories = db.collection('keywordresearchhistories');
  const kwSearches  = db.collection('keywordsearches');
  const aiTrackers  = db.collection('aitrackers');
  const aiPrompts   = db.collection('aitrackerprompts');

  // Find user
  const user = await users.findOne({ email: ACCT.email });
  if (!user) { console.log('  ERROR: user not found'); await mongoose.disconnect(); return; }
  console.log(`  User _id=${user._id}`);

  // Verify
  await users.updateOne({ _id: user._id }, { $set: { verified: true } });

  // Org
  let org = await orgs.findOne({ ownerId: user._id });
  if (!org) {
    const r = await orgs.insertOne({
      name: 'E2E Downgrade Org',
      slug: `e2e-downgrade-${Date.now()}`,
      ownerId: user._id,
      isPersonal: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    org = await orgs.findOne({ _id: r.insertedId });
    console.log(`  Org created _id=${org._id}`);
  } else {
    console.log(`  Org exists _id=${org._id}`);
  }

  // Remove subscription → free tier
  await subs.deleteMany({ organizationId: org._id });
  console.log('  Subscription: removed (free tier)');

  // ── 3. Workspaces (3 total: 1 unlocked + 2 locked) ───────
  console.log('\n=== 3. Workspaces ===');
  const WS_NUMS = [960001, 960002, 960003];
  const wsIds = [];

  for (let i = 0; i < 3; i++) {
    // Delete existing if any (idempotent)
    await workspaces.deleteMany({ organizationId: org._id, workspaceNumber: WS_NUMS[i] });

    const r = await workspaces.insertOne({
      workspaceNumber: WS_NUMS[i],
      userId: user._id,
      organizationId: org._id,
      name: `Downgrade WS ${i + 1}`,
      color: ['#6366F1', '#EC4899', '#F59E0B'][i],
      isDefault: i === 0,
      locked: i >= 1,  // Free tier maxWorkspaces=1 → first unlocked, rest locked
      members: [],
      createdAt: new Date(Date.now() - (3 - i) * 86400000),
      updatedAt: new Date(),
    });
    wsIds.push(r.insertedId);
    console.log(`  WS ${WS_NUMS[i]}: "${['Downgrade WS 1 (default)', 'Downgrade WS 2', 'Downgrade WS 3'][i]}" locked=${i >= 1}`);
  }

  // Set active workspace
  await users.updateOne({ _id: user._id }, { $set: { activeWorkspaceId: wsIds[0] } });

  // ── 4. Articles (6 total: 3 unlocked + 3 locked) ─────────
  console.log('\n=== 4. Articles ===');
  // Clean existing test articles (by contentNumber — unique index)
  await contents.deleteMany({ contentNumber: { $gte: 901, $lte: 906 } });

  for (let i = 1; i <= 6; i++) {
    const isPaid = i > 3;
    await contents.insertOne({
      workspaceId: wsIds[0],
      contentNumber: 900 + i,
      title: `Downgrade Test Article ${i}`,
      slug: `downgrade-test-article-${i}`,
      status: 'draft',
      locked: isPaid,
      createdOnPlan: isPaid ? 'paid' : 'free',
      blocks: [],
      targetKeywords: [],
      score: 0,
      wordCount: 0,
      createdAt: new Date(Date.now() - (7 - i) * 86400000),
      updatedAt: new Date(),
    });
    console.log(`  Article ${i}: contentNumber=${900 + i}, locked=${isPaid}, createdOnPlan=${isPaid ? 'paid' : 'free'}`);
  }

  // ── 5. Avatars (3 total: 1 unlocked + 2 locked) ──────────
  console.log('\n=== 5. Avatars ===');
  await avatars.deleteMany({ workspace: wsIds[0], name: /^Downgrade Test Avatar/ });

  for (let i = 1; i <= 3; i++) {
    await avatars.insertOne({
      workspace: wsIds[0],
      name: `Downgrade Test Avatar ${i}`,
      emoji: ['\u{1F3AD}', '\u{1F3A8}', '\u{1F3AA}'][i - 1],
      isActive: i === 1,
      locked: i > 1,  // Free tier maxBrandVoices=1 → first unlocked, rest locked
      traits: [],
      writingQuirks: [],
      toneOverrides: {},
      vocabulary: {},
      createdAt: new Date(Date.now() - (4 - i) * 86400000),
      updatedAt: new Date(),
    });
    console.log(`  Avatar ${i}: locked=${i > 1}`);
  }

  // ── 6. Keyword Research Histories + Cached Results ──
  console.log('\n=== 6. Keyword Research Histories ===');
  await kwHistories.deleteMany({ workspaceId: wsIds[0], seedKeyword: /^downgrade test/ });

  const kwTestData = [
    { seedKeyword: 'downgrade test seo tools', country: 'US', createdOnPlan: 'free', locked: false },
    { seedKeyword: 'downgrade test content marketing', country: 'US', createdOnPlan: 'free', locked: false },
    { seedKeyword: 'downgrade test keyword research', country: 'US', createdOnPlan: 'free', locked: false },
    { seedKeyword: 'downgrade test link building', country: 'US', createdOnPlan: 'paid', locked: true },
    { seedKeyword: 'downgrade test technical seo', country: 'GB', createdOnPlan: 'paid', locked: true },
    { seedKeyword: 'downgrade test ai writing', country: 'US', createdOnPlan: 'paid', locked: true },
  ];

  // Helper to generate fake related keywords for a seed
  function fakeRelated(seed, count) {
    const related = [];
    const prefixes = ['best', 'top', 'free', 'cheap', 'how to use', 'alternatives to'];
    for (let j = 0; j < count; j++) {
      related.push({
        keyword: `${prefixes[j % prefixes.length]} ${seed} ${j + 1}`,
        searchVolume: Math.floor(Math.random() * 5000) + 100,
        keywordDifficulty: Math.floor(Math.random() * 80) + 10,
        cpc: +(Math.random() * 5).toFixed(2),
        searchIntent: ['informational', 'commercial', 'transactional'][j % 3],
        monthlySearches: Array.from({ length: 12 }, () => Math.floor(Math.random() * 3000) + 200),
        serpFeatures: ['featured_snippet', 'people_also_ask', 'knowledge_panel'].slice(0, (j % 3) + 1),
        isQuestion: j % 4 === 0,
      });
    }
    return related;
  }

  for (let i = 0; i < kwTestData.length; i++) {
    const kw = kwTestData[i];

    // Insert history entry
    await kwHistories.insertOne({
      workspaceId: wsIds[0],
      seedKeyword: kw.seedKeyword,
      country: kw.country,
      searchedAt: new Date(Date.now() - (7 - i) * 86400000),
      locked: kw.locked,
      createdOnPlan: kw.createdOnPlan,
      createdAt: new Date(Date.now() - (7 - i) * 86400000),
      updatedAt: new Date(),
    });

    // Upsert cached KeywordSearch result (so clicking history loads data)
    const related = fakeRelated(kw.seedKeyword, 8);
    await kwSearches.updateOne(
      { seedKeyword: kw.seedKeyword, country: kw.country },
      {
        $set: {
          seedMetrics: {
            keyword: kw.seedKeyword,
            searchVolume: Math.floor(Math.random() * 10000) + 500,
            keywordDifficulty: Math.floor(Math.random() * 70) + 15,
            cpc: +(Math.random() * 4 + 0.5).toFixed(2),
            searchIntent: 'informational',
            monthlySearches: Array.from({ length: 12 }, () => Math.floor(Math.random() * 5000) + 300),
            serpFeatures: ['featured_snippet', 'people_also_ask'],
            isQuestion: false,
          },
          relatedKeywords: related,
          totalCount: related.length,
          fetchedAt: new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );

    console.log(`  KW "${kw.seedKeyword}": locked=${kw.locked}, createdOnPlan=${kw.createdOnPlan}, cached=${related.length} related`);
  }

  // ── 7. AI Tracker + Prompts (5 prompts: 2 free + 3 locked paid) ──
  console.log('\n=== 7. AI Tracker + Prompts ===');
  // Clean ALL trackers with this domain (including orphaned ones from previous script runs)
  const orphanedTrackers = await aiTrackers.find({ domain: 'downgrade-test.com' }).toArray();
  if (orphanedTrackers.length > 0) {
    const orphanedIds = orphanedTrackers.map(t => t._id);
    await aiPrompts.deleteMany({ trackerId: { $in: orphanedIds } });
    await aiTrackers.deleteMany({ _id: { $in: orphanedIds } });
    console.log(`  Cleaned ${orphanedTrackers.length} old tracker(s) + their prompts`);
  }

  const trackerResult = await aiTrackers.insertOne({
    workspaceId: wsIds[0],
    name: 'Downgrade Test Monitor',
    domain: 'downgrade-test.com',
    defaultModels: [],  // Empty = triggers PlatformReselection on free tier (limit=2, had 4)
    scanCadence: 'weekly',
    scanStatus: 'idle',
    scanProgress: 0,
    scanError: null,
    platformStatuses: [],
    lastScanAt: null,
    nextScanAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const trackerId = trackerResult.insertedId;
  console.log(`  Tracker created: _id=${trackerId}`);

  // Clean existing prompts for this tracker
  await aiPrompts.deleteMany({ trackerId });

  const promptTestData = [
    { prompt: 'best seo tools 2025', createdOnPlan: 'free', locked: false },
    { prompt: 'top content marketing platforms', createdOnPlan: 'free', locked: false },
    { prompt: 'best ai writing assistants', createdOnPlan: 'paid', locked: true },
    { prompt: 'top rank tracking software', createdOnPlan: 'paid', locked: true },
    { prompt: 'best keyword research tools', createdOnPlan: 'paid', locked: true },
  ];

  for (const p of promptTestData) {
    await aiPrompts.insertOne({
      trackerId,
      prompt: p.prompt,
      models: ['chatgpt', 'gemini', 'claude', 'perplexity'],
      frequency: 'Weekly',
      active: true,
      locked: p.locked,
      createdOnPlan: p.createdOnPlan,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`  Prompt "${p.prompt}": locked=${p.locked}, createdOnPlan=${p.createdOnPlan}`);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n=== DOWNGRADE TEST ACCOUNT ===');
  console.log('┌─────────────────┬─────────────────────────────────────────────┐');
  console.log('│ Email           │ test-e2e-downgrade@suparank.local          │');
  console.log('│ Password        │ TestPass123                                │');
  console.log('│ Workspace #     │ 960001                                     │');
  console.log('│ Tier            │ free (simulates Agency → Free downgrade)   │');
  console.log('│ Articles        │ 6 total (3 free + 3 paid-locked)          │');
  console.log('│ Workspaces      │ 3 total (1 unlocked + 2 locked)           │');
  console.log('│ Avatars         │ 3 total (1 unlocked + 2 locked)           │');
  console.log('│ KW Histories    │ 6 total (3 free + 3 paid-locked)          │');
  console.log('│ AI Tracker      │ 1 monitor, 5 prompts (2 free + 3 locked)  │');
  console.log('└─────────────────┴─────────────────────────────────────────────┘');

  await mongoose.disconnect();
  console.log('\nDone!');
}

main().catch((e) => { console.error(e); process.exit(1); });
