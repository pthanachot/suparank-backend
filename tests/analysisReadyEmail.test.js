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
 *    that is a whole-platform failure, not a nuisance.
 *
 *    So exactly one email per piece, on its first successful analysis. That is
 *    decided from CONTENT STATE (analyzedAt unset when the run began) and
 *    enforced by an atomic claim on analysisReadyEmailedAt — not by trusting
 *    whichever route started the run. Both earlier caller-derived designs
 *    leaked: `!opts.bill` read "don't charge" as "the user didn't ask", and the
 *    `firstRun` flag that replaced it was threaded by only two of the paths
 *    that can start a first analysis, so the wizard's step-1 fallback produced
 *    a genuine first analysis that silently sent nothing.
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
const Content = require('../src/models/Content');
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
  cFindOneAndUpdate: Content.findOneAndUpdate,
  cUpdateOne: Content.updateOne,
};
after(() => {
  Object.assign(Workspace, { findById: originals.wFindById });
  Object.assign(Content, {
    findOneAndUpdate: originals.cFindOneAndUpdate,
    updateOne: originals.cUpdateOne,
  });
});

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
// Stands in for the persisted content.analysisReadyEmailedAt. The claim is what
// makes the email at-most-once, so it has to be modelled rather than stubbed
// away — including Mongo's behaviour that a `field: null` filter also matches
// documents where the field is absent (every row predating it).
let emailedAt;
let claimAttempts;

beforeEach(() => {
  sent.length = 0;
  emitted.length = 0;
  emailedAt = null;
  claimAttempts = 0;

  Content.findOneAndUpdate = async (filter, update) => {
    claimAttempts++;
    if (filter.analysisReadyEmailedAt === null && emailedAt !== null) return null;
    emailedAt = update.$set.analysisReadyEmailedAt;
    return { _id: filter._id, analysisReadyEmailedAt: emailedAt };
  };
  Content.updateOne = async (_filter, update) => {
    emailedAt = update.$set.analysisReadyEmailedAt;
    return { modifiedCount: 1 };
  };
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
  // The discriminator is the CONTENT, not the caller: the run that finds
  // analyzedAt unset is the first one, and that is the run that emails. `opts`
  // must no longer influence the decision at all, which is what these cases pin
  // — each row is a real startAnalysis call site's opts shape.
  //
  // Two earlier designs keyed off the caller and both leaked. `!opts.bill`
  // treated "don't charge" as "the user didn't ask". Its replacement, an
  // explicit `firstRun` flag, was threaded only by the two creation paths — so
  // the wizard's step-1 fallback (POST /analyze, which passes no opts) ran a
  // genuine first analysis and silently sent nothing, with no log to say why.
  const CALL_SITE_OPTS = [
    ['content creation auto-trigger', {}],
    ['wizard deferred start', {}],
    ['wizard step-1 fallback, POST /analyze', {}],
    ['billed re-score', { bill: { action: 'reScore', userId: 'u1' } }],
    ['free retry of a transient failure', { refresh: true }],
  ];

  for (const [label, opts] of CALL_SITE_OPTS) {
    it(`emails a FIRST analysis started by: ${label}`, async () => {
      await notifyAnalysisOutcome(CONTENT, opts, true, true);
      assert.equal(sent.length, 1, 'a first analysis did not email');
    });

    it(`stays silent on a RE-analysis started by: ${label}`, async () => {
      await notifyAnalysisOutcome(CONTENT, opts, true, false);
      assert.equal(sent.length, 0, 'a re-analysis emailed');
    });
  }

  it('notifies in-app on EVERY path, emailing or not', async () => {
    for (const wasNeverAnalyzed of [true, false]) {
      emitted.length = 0;
      emailedAt = null;
      await notifyAnalysisOutcome(CONTENT, {}, true, wasNeverAnalyzed);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].type, 'analysis.ready');
    }
  });

  it('does NOT email when the analysis failed', async () => {
    await notifyAnalysisOutcome(CONTENT, {}, false, true);
    assert.equal(sent.length, 0);
    assert.equal(emitted[0].type, 'analysis.failed');
  });
});

describe('the first-run decision survives the whole chain', () => {
  // The cases above hand notifyAnalysisOutcome its `wasNeverAnalyzed` argument
  // directly, which skips the two links that actually derive it in production:
  //   runAnalysis loads content → captures !content.analyzedAt
  //     → notifyAnalysisOutcome(content, opts, ready, wasNeverAnalyzed)
  // Break either link and NO email is ever sent, with every case above still
  // green. These read the source to close that gap.
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = path.join(__dirname, '..', 'src');
  const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

  it('runAnalysis captures the flag BEFORE it writes analyzedAt', () => {
    // Ordering is the whole trick. analyzedAt is stamped mid-run, so reading it
    // any later makes every run look like a repeat and nothing ever emails —
    // a failure with no error and no log, exactly like the bug this replaced.
    const src = read('controllers/analysisController.js');
    const captured = src.indexOf('const wasNeverAnalyzed = !content.analyzedAt');
    const written = src.indexOf('analyzedAt: new Date()');
    assert.ok(captured > -1, 'runAnalysis no longer captures wasNeverAnalyzed');
    assert.ok(written > -1, 'analyzedAt is no longer stamped where expected');
    assert.ok(captured < written, 'wasNeverAnalyzed is read AFTER analyzedAt is written');
  });

  it('runAnalysis passes it to the notifier', () => {
    assert.match(
      read('controllers/analysisController.js'),
      /notifyAnalysisOutcome\(content, opts, true, wasNeverAnalyzed\)/,
      'the success notify dropped its wasNeverAnalyzed argument'
    );
  });

  it('the notifier gates on content state, not on the caller', () => {
    const src = read('controllers/analysisController.js');
    assert.match(src, /if \(wasNeverAnalyzed\) await emailAnalysisReady\(/);
    // Both caller-derived inferences that leaked before must stay gone.
    assert.doesNotMatch(
      src,
      /if \(!opts\?\.bill\) await emailAnalysisReady\(/,
      'the billing-flag inference came back'
    );
    assert.doesNotMatch(
      src,
      /if \(opts\?\.firstRun\) await emailAnalysisReady\(/,
      'the caller-threaded firstRun flag came back'
    );
  });

  it('no call site threads a firstRun flag any more', () => {
    // contentController must not mention it at all; analysisController may only
    // in prose explaining why it is gone, never in a startAnalysis call.
    const content = read('controllers/contentController.js');
    const analysis = read('controllers/analysisController.js');
    assert.equal((content.match(/firstRun/g) || []).length, 0, 'contentController still threads firstRun');
    assert.equal((analysis.match(/startAnalysis\([^)]*firstRun[^)]*\)/g) || []).length, 0);
  });
});

describe('gates', () => {
  it('respects the system-wide kill switch', async () => {
    settings = { emailNotificationsEnabled: false };
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 0, 'sent while notifications were disabled platform-wide');
    assert.equal(emitted.length, 1, 'the kill switch should not silence in-app too');
  });

  it("respects the recipient's own preference", async () => {
    user.preferences.emailNotifications = false;
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 0, 'emailed a user who opted out');
  });

  it('sends when the preference is simply absent', async () => {
    user.preferences = {};
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 1, 'an unset preference must default to sending');
  });

  it('skips a user with no address', async () => {
    user.email = '';
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 0);
  });
});

describe('content', () => {
  it('carries a working absolute link to the editor', async () => {
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.match(sent[0].html, /https:\/\/app\.suparank\.ai\/workspace\/12\/drafts\/34/);
  });

  it('uses the org custom domain when one is active (Invariant I1)', async () => {
    domainService.resolveBaseUrl = async () => 'https://seo.northwind.test';
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.match(sent[0].html, /https:\/\/seo\.northwind\.test\/workspace\/12\/drafts\/34/);
  });

  it('passes orgId so a white-label tenant gets their own sender identity', async () => {
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent[0].orgId, 'org1');
  });

  it('escapes a title containing markup', async () => {
    await notifyAnalysisOutcome({ ...CONTENT, title: '<img src=x onerror=1>' }, {}, true, true);
    assert.doesNotMatch(sent[0].html, /<img src=x/, 'content title rendered as live markup');
    assert.match(sent[0].html, /&lt;img src=x/);
  });

  it('leaves the subject readable when the title has an apostrophe', async () => {
    await notifyAnalysisOutcome({ ...CONTENT, title: "Alex's guide" }, {}, true, true);
    assert.match(sent[0].subject, /Alex's guide/);
    assert.doesNotMatch(sent[0].subject, /&#39;/);
  });

  it('falls back to a placeholder title', async () => {
    await notifyAnalysisOutcome({ ...CONTENT, title: '' }, {}, true, true);
    assert.match(sent[0].html, /Untitled/);
  });
});

describe('never breaks the analysis', () => {
  it('survives the template failing to resolve', async () => {
    emailPortal.applyCustomTemplate = async () => {
      throw new Error('mongo down');
    };
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 0, 'sent an email with no subject or body');
  });

  it('survives the user lookup throwing', async () => {
    User.findById = () => {
      throw new Error('mongo down');
    };
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 0);
  });

  it('survives the base-URL lookup throwing', async () => {
    domainService.resolveBaseUrl = async () => {
      throw new Error('dns down');
    };
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 0);
  });

  it('still writes the in-app notification when the email path dies', async () => {
    User.findById = () => {
      throw new Error('mongo down');
    };
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(emitted.length, 1, 'an email failure took the notification with it');
  });
});

describe('at most once per piece', () => {
  it('a second first-run notify does not email again', async () => {
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 1, 'the same piece emailed twice');
  });

  it('two concurrent runs on one piece produce a single email', async () => {
    // Reachable in production: POST /analyze 409s only on 'analyzing', so it
    // will happily start a second run over a 'pending' one, and both then see
    // the same never-analyzed state.
    await Promise.all([
      notifyAnalysisOutcome(CONTENT, {}, true, true),
      notifyAnalysisOutcome(CONTENT, {}, true, true),
    ]);
    assert.equal(sent.length, 1, 'a double start double-sent');
    assert.equal(claimAttempts, 2, 'both runs should have raced for the claim');
  });

  it('releases the claim when the send fails, so a later run can still notify', async () => {
    const emailService = require('../src/utils/emailService');
    const working = emailService.sendEmail;
    emailService.sendEmail = async () => {
      throw new Error('smtp down');
    };
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 0);
    assert.equal(emailedAt, null, 'a failed send left the piece permanently barred');

    emailService.sendEmail = working;
    await notifyAnalysisOutcome(CONTENT, {}, true, true);
    assert.equal(sent.length, 1, 'the run after a failed send did not email');
  });
});

describe('every skip says why', () => {
  // The bug that prompted all this was un-diagnosable from the logs: each gate
  // returned silently, so "no email and no log" was indistinguishable from
  // "the function was never called".
  const logs = [];
  const realLog = console.log;
  const capture = () => {
    console.log = (...a) => logs.push(a.join(' '));
  };
  const release = () => {
    console.log = realLog;
  };

  const CASES = [
    ['system kill switch', () => { settings = { emailNotificationsEnabled: false }; }],
    ['recipient has no address', () => { user.email = ''; }],
    ['user preference off', () => { user.preferences.emailNotifications = false; }],
  ];

  for (const [reason, arrange] of CASES) {
    it(`logs a reason code: ${reason}`, async () => {
      logs.length = 0;
      arrange();
      capture();
      try {
        await notifyAnalysisOutcome(CONTENT, {}, true, true);
      } finally {
        release();
      }
      assert.equal(sent.length, 0);
      assert.ok(
        logs.some((l) => l.includes(`analysis_ready skipped (${reason})`)),
        `no reason code for "${reason}"; captured: ${JSON.stringify(logs)}`
      );
    });
  }

  it('never puts the recipient address in a skip line', async () => {
    logs.length = 0;
    user.preferences.emailNotifications = false;
    capture();
    try {
      await notifyAnalysisOutcome(CONTENT, {}, true, true);
    } finally {
      release();
    }
    assert.ok(logs.length > 0, 'nothing was logged at all');
    for (const line of logs) {
      assert.doesNotMatch(line, /alex@northwind\.test/, 'a skip line leaked the address');
    }
  });
});
