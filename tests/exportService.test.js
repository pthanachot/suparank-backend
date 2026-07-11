/**
 * Phase 18B — data export serialisation (exportService).
 *
 * Verifies the per-workspace and per-org file layouts, the content triple
 * (MD/HTML/JSON), block→HTML rendering (incl. list grouping), the manifest
 * counts, and that the archive builders emit a real tar.gz. Models mocked.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const exportService = require('../src/services/exportService');
const Content = require('../src/models/Content');
const AiTracker = require('../src/models/AiTracker');
const AiTrackerPrompt = require('../src/models/AiTrackerPrompt');
const AiTrackerScan = require('../src/models/AiTrackerScan');
const ReportSnapshot = require('../src/models/ReportSnapshot');
const KeywordResearchHistory = require('../src/models/KeywordResearchHistory');
const BrandVoice = require('../src/models/BrandVoice');
const Workspace = require('../src/models/Workspace');
const Organization = require('../src/models/Organization');
const AgencyPlan = require('../src/models/AgencyPlan');
const ClientSubscription = require('../src/models/ClientSubscription');
const brandService = require('../src/services/brandService');

// chainable query mock: .select().sort().lean() all resolve to `val`
function q(val) { const o = { select() { return o; }, sort() { return o; }, lean: async () => val }; return o; }

const content = {
  _id: 'c1', workspaceId: 'ws1', contentNumber: 1, title: 'My Post', slug: 'my-post',
  blocks: [
    { type: 'h2', text: 'Intro' },
    { type: 'p', text: 'Hello <strong>world</strong>' },
    { type: 'li', text: 'one' },
    { type: 'li', text: 'two' },
  ],
};
const tracker = { _id: 't1', workspaceId: 'ws1', name: 'Brand Watch', domain: 'acme.com' };
const report = { _id: 'r1', workspaceId: 'ws1', period: '2026-06', data: { visibility: 42 } };
const ws = { _id: 'ws1', workspaceNumber: 7, name: 'Acme Client', organizationId: 'org1' };
const org = { _id: 'org1', name: 'Acme Agency', slug: 'acme', ownerId: 'owner1' };

const real = {};
beforeEach(() => {
  real.contentFind = Content.find; real.trFind = AiTracker.find; real.prFind = AiTrackerPrompt.find;
  real.scanFind = AiTrackerScan.find; real.repFind = ReportSnapshot.find; real.kwFind = KeywordResearchHistory.find;
  real.bvFind = BrandVoice.find; real.wsFindById = Workspace.findById; real.wsFind = Workspace.find;
  real.orgFindById = Organization.findById; real.planFind = AgencyPlan.find; real.subFind = ClientSubscription.find;
  real.brandFor = brandService.getBrandForOrg;

  Content.find = () => q([content]);
  AiTracker.find = () => q([tracker]);
  AiTrackerPrompt.find = () => q([{ _id: 'p1', trackerId: 't1', prompt: 'best crm?' }]);
  AiTrackerScan.find = () => q([{ _id: 's1', trackerId: 't1', status: 'completed' }]);
  ReportSnapshot.find = () => q([report]);
  KeywordResearchHistory.find = () => q([]);
  BrandVoice.find = () => q([]);
  Workspace.findById = () => q(ws);
  Workspace.find = () => q([ws]);
  Organization.findById = () => q(org);
  AgencyPlan.find = () => q([{ _id: 'pl1', name: 'Starter', organizationId: 'org1' }]);
  ClientSubscription.find = () => q([{ _id: 'cs1', organizationId: 'org1', status: 'active' }]);
  brandService.getBrandForOrg = async () => ({ config: { brandName: 'Acme' } });
});

afterEach(() => {
  Content.find = real.contentFind; AiTracker.find = real.trFind; AiTrackerPrompt.find = real.prFind;
  AiTrackerScan.find = real.scanFind; ReportSnapshot.find = real.repFind; KeywordResearchHistory.find = real.kwFind;
  BrandVoice.find = real.bvFind; Workspace.findById = real.wsFindById; Workspace.find = real.wsFind;
  Organization.findById = real.orgFindById; AgencyPlan.find = real.planFind; ClientSubscription.find = real.subFind;
  brandService.getBrandForOrg = real.brandFor;
});

const names = (entries) => entries.map((e) => e.name);
const byName = (entries, n) => entries.find((e) => e.name === n)?.data;

describe('serializeWorkspace', () => {
  it('emits content as MD + HTML + JSON, tracker history, reports, and a manifest', async () => {
    const entries = await exportService.serializeWorkspace('ws1');
    const n = names(entries);
    assert.ok(n.includes('content/1-my-post.md'));
    assert.ok(n.includes('content/1-my-post.html'));
    assert.ok(n.includes('content/1-my-post.json'));
    assert.ok(n.includes('ai-tracker/brand-watch-t1/tracker.json'));
    assert.ok(n.includes('ai-tracker/brand-watch-t1/prompts.json'));
    assert.ok(n.includes('ai-tracker/brand-watch-t1/scans.json'));
    assert.ok(n.includes('reports/2026-06.json'));
    assert.ok(n.includes('manifest.json'));
  });

  it('Markdown carries the title + block text', async () => {
    const entries = await exportService.serializeWorkspace('ws1');
    const md = byName(entries, 'content/1-my-post.md');
    assert.ok(md.includes('# My Post'));
    assert.ok(md.includes('Intro'));
  });

  it('HTML is a full document and groups consecutive list items into <ul>', async () => {
    const entries = await exportService.serializeWorkspace('ws1');
    const html = byName(entries, 'content/1-my-post.html');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<h2>Intro</h2>'));
    assert.ok(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/.test(html), 'list items grouped');
  });

  it('HTML tables use tableData.headers for <th> (not the first data row) and tolerate null rows', async () => {
    const tblContent = {
      _id: 'c2', workspaceId: 'ws1', contentNumber: 2, title: 'Pricing', slug: 'pricing',
      blocks: [
        { type: 'table', tableData: { headers: ['Name', 'Price'], rows: [['Apple', '1'], null, ['Banana', '2']] } },
      ],
    };
    Content.find = () => q([tblContent]);
    const entries = await exportService.serializeWorkspace('ws1');
    const html = byName(entries, 'content/2-pricing.html');
    assert.ok(html.includes('<th>Name</th><th>Price</th>'), 'real headers become <th>');
    assert.ok(html.includes('<td>Apple</td><td>1</td>'), 'first data row stays a data row');
    assert.ok(html.includes('<td>Banana</td><td>2</td>'), 'null row skipped, later rows intact');
    assert.ok(!html.includes('<th>Apple</th>'), 'a data cell is never promoted to a header');
  });

  it('does not crash on a null element in blocks[]', async () => {
    const badContent = {
      _id: 'c3', workspaceId: 'ws1', contentNumber: 3, title: 'Broken', slug: 'broken',
      blocks: [{ type: 'p', text: 'ok' }, null, { type: 'h2', text: 'still here' }],
    };
    Content.find = () => q([badContent]);
    const entries = await exportService.serializeWorkspace('ws1');
    const html = byName(entries, 'content/3-broken.html');
    const md = byName(entries, 'content/3-broken.md');
    assert.ok(html.includes('<h2>still here</h2>'), 'renders blocks after the null');
    assert.ok(md.includes('ok'), 'markdown path also survives the null');
  });

  it('manifest counts reflect the serialised data', async () => {
    const entries = await exportService.serializeWorkspace('ws1');
    const m = JSON.parse(byName(entries, 'manifest.json'));
    assert.equal(m.counts.content, 1);
    assert.equal(m.counts.aiTrackers, 1);
    assert.equal(m.counts.reports, 1);
    assert.equal(m.workspace.name, 'Acme Client');
  });

  it('prefix namespaces every entry (for org-level nesting)', async () => {
    const entries = await exportService.serializeWorkspace('ws1', 'workspaces/acme-ws1/');
    assert.ok(names(entries).every((x) => x.startsWith('workspaces/acme-ws1/')));
  });
});

describe('serializeOrg', () => {
  it('adds org-level files and nests each workspace', async () => {
    const entries = await exportService.serializeOrg('org1');
    const n = names(entries);
    assert.ok(n.includes('organization.json'));
    assert.ok(n.includes('agency-plans.json'));
    assert.ok(n.includes('client-subscriptions.json'));
    assert.ok(n.includes('brand-config.json'));
    assert.ok(n.includes('manifest.json'));
    assert.ok(n.some((x) => x.startsWith('workspaces/acme-client-ws1/') && x.endsWith('manifest.json')));
  });
});

describe('archive builders', () => {
  it('exportWorkspaceArchive emits a gunzip-able tar.gz containing the manifest', async () => {
    const { filename, buffer } = await exportService.exportWorkspaceArchive('ws1');
    assert.ok(filename.endsWith('.tar.gz'));
    assert.equal(buffer[0], 0x1f); // gzip magic
    const tar = zlib.gunzipSync(buffer);
    assert.ok(tar.includes(Buffer.from('manifest.json')), 'archive contains the manifest');
  });
});
