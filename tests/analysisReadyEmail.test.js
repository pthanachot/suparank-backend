/**
 * The analysis_ready email — a second delivery channel for the same event that
 * already writes an in-app `analysis.ready` notification.
 *
 * Two things here are easy to get wrong and expensive if wrong:
 *
 * 1. VOLUME. Analysis runs on content creation AND from four other entry
 *    points, three of which are buttons the user just pressed. Emailing all of
 *    them would put a message in the inbox each time someone nudges a draft —
 *    a dozen a day for an active writer, and the fastest route to the sending
 *    domain being filtered. Since this domain also carries password resets,
 *    that is a whole-platform failure, not a nuisance. Only the two creation
 *    paths opt in, via an explicit `firstRun` flag.
 *
 * 2. IT MUST NEVER AFFECT THE ANALYSIS. This is a notification about work that
 *    already succeeded. Every failure mode here — no user, no address, SMTP
 *    down, template broken — has to be swallowed.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

// FIRST — before anything that pulls emailService in transitively. The real
// module builds SMTP transports and fires verify() at load; requiring
// emailPortalController ahead of this stub makes the run attempt a live
// connection to :587 and hang until it gives up.
const sent = [];
require.cache[require.resolve('../src/utils/emailService')] = {
  exports: {
    sendEmail: async (opts) => {
      sent.push(opts);
      return {};
    },
    sendVerificationCodeEmail: async () => ({}),
    sendPasswordResetCodeEmail: async () => ({}),
  },
};

const Workspace = require('../src/models/Workspace');
const User = require('../src/models/User');
const systemSettings = require('../src/services/systemSettingsService');
const domainService = require('../src/services/domainService');
const notificationService = require('../src/services/notificationService');
const emailPortal = require('../src/controllers/emailPortalController');

// Template resolution runs FOR REAL so the variable contract is exercised, but
// its collaborators are stubbed: without this, findOne() buffers against a
// database that is not there and the run hangs rather than fails.
const TriggerableEmailTemplate = require('../src/models/TriggerableEmailTemplate');
const brandService = require('../src/services/brandService');
const flagService = require('../src/services/flagService');
TriggerableEmailTemplate.findOne = () => ({ lean: async () => null });
TriggerableEmailTemplate.findOneAndUpdate = async () => null;
flagService.isFlagLive = async () => false;
const PLATFORM_BRAND = {
  productName: 'SupaRank',
  supportEmail: 'support@suparank.ai',
  primaryColor: '#2B5BE8',
};
brandService.getPlatformBrand = async () => ({ ...PLATFORM_BRAND });
brandService.getBrandForOrg = async () => ({ brand: { ...PLATFORM_BRAND } });

const { notifyAnalysisOutcome } = require('../src/controllers/analysisController');

const originals = {
  wFindById: Workspace.findById,
  uFindById: User.findById,
  settings: systemSettings.getSettings,
  baseUrl: domainService.resolveBaseUrl,
  emit: notificationService.emit,
  apply: emailPortal.applyCustomTemplate,
};
after(() => Object.assign(Workspace, { findById: originals.wFindById }));

const CONTENT = {
  _id: 'c1',
  userId: 'u1',
  workspaceId: 'w1',
  contentNumber: 34,
  title: 'How to rank in 2026',
};

const emitted = [];
let user;
let settings;

beforeEach(() => {
  sent.length = 0;
  emitted.length = 0;
  user = {
    _id: 'u1',
    email: 'alex@northwind.test',
    profile: { name: 'Alex Rivera' },
    preferences: { emailNotifications: true },
  };
  settings = { emailNotificationsEnabled: true };

  Workspace.findById = () => ({
    select: () => ({
      lean: async () => ({ workspaceNumber: 12, name: 'Northwind Media', organizationId: 'org1' }),
    }),
  });
  User.findById = () => ({ select: () => ({ lean: async () => user }) });
  systemSettings.getSettings = () => settings;
  domainService.resolveBaseUrl = async () => 'https://app.suparank.ai';
  notificationService.emit = async (n) => {
    emitted.push(n);
    return n;
  };
  // Resolve through the REAL template so the variable contract is exercised.
  emailPortal.applyCustomTemplate = originals.apply;
});

describe('which analyses email', () => {
  // Mirrors the six real startAnalysis call sites. Only the two creation paths
  // pass firstRun; everything else is a button the user just pressed, so they
  // are already looking at the editor.
  //
  // The first cut of this feature keyed off `!opts.bill` instead, which was
  // wrong — `bill` means "charge for this", not "the user asked for this", so
  // POST /analyze and the free transient-retry both counted as auto-runs and
  // emailed. These cases exist to stop that inference coming back.
  const CALL_SITES = [
    ['content creation auto-trigger (contentController:156)', { firstRun: true }, true],
    ['wizard deferred start (contentController:325)', { firstRun: true }, true],
    ['POST /analyze, user pressed Run (analysisController:1076)', {}, false],
    ['billed re-score (analysisController:1174)', { bill: { action: 'reScore', userId: 'u1' } }, false],
    ['free retry of a transient failure (analysisController:1205)', { refresh: true }, false],
  ];

  for (const [label, opts, shouldEmail] of CALL_SITES) {
    it(`${shouldEmail ? 'emails' : 'does NOT email'}: ${label}`, async () => {
      await notifyAnalysisOutcome(CONTENT, opts, true);
      assert.equal(
        sent.length,
        shouldEmail ? 1 : 0,
        shouldEmail ? 'the auto-run did not email' : 'a user-initiated run emailed'
      );
    });
  }

  it('notifies in-app on EVERY path, emailing or not', async () => {
    for (const [, opts] of CALL_SITES) {
      emitted.length = 0;
      await notifyAnalysisOutcome(CONTENT, opts, true);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].type, 'analysis.ready');
    }
  });

  it('does NOT email when the analysis failed', async () => {
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, false);
    assert.equal(sent.length, 0);
    assert.equal(emitted[0].type, 'analysis.failed');
  });
});

describe('the firstRun signal survives the whole chain', () => {
  // Every test above calls notifyAnalysisOutcome directly, which skips the two
  // links that actually carry the flag in production:
  //   contentController → startAnalysis(id, { firstRun }) → runAnalysis(id, opts)
  //     → notifyAnalysisOutcome(content, opts, ready)
  // Drop `opts` from either hop and NO email is ever sent, with every unit test
  // above still green. These read the source to close that gap.
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = path.join(__dirname, '..', 'src');
  const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

  it('startAnalysis forwards its opts to runAnalysis', () => {
    assert.match(
      read('controllers/analysisController.js'),
      /const startAnalysis = \(contentId, opts\) =>\s*\n?\s*runAnalysis\(contentId, opts\)/,
      'startAnalysis no longer passes opts through — firstRun would never arrive'
    );
  });

  it('both content-creation sites opt in, and only those two', () => {
    const content = read('controllers/contentController.js');
    const withFlag = (content.match(/startAnalysis\([^)]*firstRun: true[^)]*\)/g) || []).length;
    assert.equal(withFlag, 2, `expected 2 firstRun call sites in contentController, found ${withFlag}`);

    // No analysis route may claim to be an auto-run: each is a button press.
    const analysis = read('controllers/analysisController.js');
    const routeCalls = (analysis.match(/startAnalysis\([^)]*firstRun[^)]*\)/g) || []).length;
    assert.equal(routeCalls, 0, 'a user-initiated analysis route marked itself firstRun');
  });

  it('the notifier gates the email on firstRun, not on billing', () => {
    // The original bug: `!opts.bill` treated POST /analyze and the free retry
    // as auto-runs because neither charges.
    const src = read('controllers/analysisController.js');
    assert.match(src, /if \(opts\?\.firstRun\) await emailAnalysisReady\(/);
    assert.doesNotMatch(
      src,
      /if \(!opts\?\.bill\) await emailAnalysisReady\(/,
      'the billing-flag inference came back'
    );
  });
});

describe('gates', () => {
  it('respects the system-wide kill switch', async () => {
    settings = { emailNotificationsEnabled: false };
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent.length, 0, 'sent while notifications were disabled platform-wide');
    assert.equal(emitted.length, 1, 'the kill switch should not silence in-app too');
  });

  it("respects the recipient's own preference", async () => {
    user.preferences.emailNotifications = false;
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent.length, 0, 'emailed a user who opted out');
  });

  it('sends when the preference is simply absent', async () => {
    user.preferences = {};
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent.length, 1, 'an unset preference must default to sending');
  });

  it('skips a user with no address', async () => {
    user.email = '';
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent.length, 0);
  });
});

describe('content', () => {
  it('carries a working absolute link to the editor', async () => {
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.match(sent[0].html, /https:\/\/app\.suparank\.ai\/workspace\/12\/drafts\/34/);
  });

  it('uses the org custom domain when one is active (Invariant I1)', async () => {
    domainService.resolveBaseUrl = async () => 'https://seo.northwind.test';
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.match(sent[0].html, /https:\/\/seo\.northwind\.test\/workspace\/12\/drafts\/34/);
  });

  it('passes orgId so a white-label tenant gets their own sender identity', async () => {
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent[0].orgId, 'org1');
  });

  it('escapes a title containing markup', async () => {
    await notifyAnalysisOutcome({ ...CONTENT, title: '<img src=x onerror=1>' }, { firstRun: true }, true);
    assert.doesNotMatch(sent[0].html, /<img src=x/, 'content title rendered as live markup');
    assert.match(sent[0].html, /&lt;img src=x/);
  });

  it('leaves the subject readable when the title has an apostrophe', async () => {
    await notifyAnalysisOutcome({ ...CONTENT, title: "Alex's guide" }, { firstRun: true }, true);
    assert.match(sent[0].subject, /Alex's guide/);
    assert.doesNotMatch(sent[0].subject, /&#39;/);
  });

  it('falls back to a placeholder title', async () => {
    await notifyAnalysisOutcome({ ...CONTENT, title: '' }, { firstRun: true }, true);
    assert.match(sent[0].html, /Untitled/);
  });
});

describe('never breaks the analysis', () => {
  it('survives the template failing to resolve', async () => {
    emailPortal.applyCustomTemplate = async () => {
      throw new Error('mongo down');
    };
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent.length, 0, 'sent an email with no subject or body');
  });

  it('survives the user lookup throwing', async () => {
    User.findById = () => {
      throw new Error('mongo down');
    };
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent.length, 0);
  });

  it('survives the base-URL lookup throwing', async () => {
    domainService.resolveBaseUrl = async () => {
      throw new Error('dns down');
    };
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(sent.length, 0);
  });

  it('still writes the in-app notification when the email path dies', async () => {
    User.findById = () => {
      throw new Error('mongo down');
    };
    await notifyAnalysisOutcome(CONTENT, { firstRun: true }, true);
    assert.equal(emitted.length, 1, 'an email failure took the notification with it');
  });
});
