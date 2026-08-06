// Suparank Express backend — single source of truth for all data persistence
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

dotenv.config();

// Fail-fast on missing env vars so config issues surface at deploy time
// instead of as opaque 500s on the first request. Names match what the
// codebase actually reads (middleware/auth.js uses ACCESS_TOKEN_SECRET,
// not the generic JWT_SECRET).
require('./utils/requireEnv')({
  required: [
    'MONGODB_URI',
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
  ],
  optional: [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GSC_TOKEN_ENCRYPTION_KEY',
    'B2_BUCKET',
    'B2_KEY_ID',
    'B2_APP_KEY',
    'CHATGPT_API_KEY',
  ],
});

// Phase 13: catch a half-configured Stripe test→live cutover at boot. A live key
// with stale/missing price env vars would otherwise fail silently at checkout
// (the webhook drops the subscription). Fatal in production, warn-only in dev.
require('./config/validateStripeConfig').assertStripeConfigAtBoot();

// Catch a mis-configured engine deploy at boot: unset ENGINE_URL /
// WRITING_ENGINE_URL in production would silently point live engine traffic at
// localhost; identical hosts risk cross-wiring the two separate engines.
require('./config/validateEngineConfig').assertEngineConfigAtBoot();

const { connectDB, checkConnectionHealth } = require('./config/database');
const { syncConfig } = require('./scripts/configSync');
const systemSettingsService = require('./services/systemSettingsService');

const app = express();

// Trust proxy for production
app.set('trust proxy', 1);

// Connect to MongoDB, recover dead scans, then sync config from seed files
connectDB()
  .then(async () => {
    // On startup, any scan stuck in 'scanning'/'pending' is dead (server was restarted).
    // Run BEFORE cron fires to prevent race condition.
    const AiTrackerStartup = require('./models/AiTracker');
    const recovered = await AiTrackerStartup.updateMany(
      { scanStatus: { $in: ['scanning', 'pending'] } },
      { $set: { scanStatus: 'failed', scanError: 'Scan interrupted by server restart' } }
    );
    if (recovered.modifiedCount > 0) {
      console.log(`[startup] recovered ${recovered.modifiedCount} interrupted scan(s)`);
    }

    // Recover stuck sitemap crawls on startup
    const SitemapStartup = require('./models/Sitemap');
    const recoveredCrawls = await SitemapStartup.updateMany(
      { crawlStatus: 'crawling' },
      { $set: { crawlStatus: 'error', crawlError: 'Crawl interrupted by server restart' } }
    );
    if (recoveredCrawls.modifiedCount > 0) {
      console.log(`[startup] recovered ${recoveredCrawls.modifiedCount} interrupted sitemap crawl(s)`);
    }

    // Recover analyses stranded mid-run by a restart. A content doc sits at
    // 'analyzing' for the minutes the engine pipeline takes, and every re-run
    // route 409s while it reads that way — so without this sweep an interrupted
    // article is permanently un-analyzable. See
    // analysisController.recoverInterruptedAnalyses for the full rationale.
    // Wrapped: a failed recovery sweep must not stop the API from booting.
    try {
      const { recoverInterruptedAnalyses } = require('./controllers/analysisController');
      const recoveredAnalyses = await recoverInterruptedAnalyses();
      if (recoveredAnalyses > 0) {
        console.log(`[startup] recovered ${recoveredAnalyses} interrupted analysis/analyses`);
      }
    } catch (e) {
      console.error('[startup] analysis recovery sweep failed:', e.message);
    }

    // F4-13: refund orphaned pending CreditTransactions. When a scan crashes
    // between preDeduct and settle (process kill, OOM, server restart), the
    // pre-deducted credits stay locked in `pending` state forever. The sweep
    // itself lives in creditService (single-sourced + tested, Phase 3).
    try {
      const creditServiceStartup = require('./services/creditService');
      await creditServiceStartup.sweepOrphanedPendingCredits({ logPrefix: '[startup]' });
    } catch (e) {
      console.error('[startup] orphan credit sweep failed:', e.message);
    }
  })
  .then(() => syncConfig())
  .then(() => systemSettingsService.loadSettings())
  .then(() => console.log('Database ready'))
  .catch((error) => {
    console.error('Failed to connect to database:', error.message);
    process.exit(1);
  });

// Security
app.use(helmet({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
app.use(cookieParser());

// CORS
const corsOptions = {
  origin: [process.env.FRONTEND_URL || 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600,
};
app.use(cors(corsOptions));

// Stripe webhook (needs raw body — must be before JSON parsing)
const { handleWebhook } = require('./controllers/webhookController');
app.post('/api/billing/webhooks', express.raw({ type: 'application/json' }), handleWebhook);

// Stripe CONNECT webhook (Phase 16) — separate endpoint + secret for
// connected-account events. Also needs the raw body before JSON parsing and
// bypasses the maintenance gate. Idempotent + signature-verified internally.
const { handleConnectWebhook } = require('./controllers/connectWebhookController');
app.post('/api/billing/connect-webhooks', express.raw({ type: 'application/json' }), handleConnectWebhook);
// A missing secret makes EVERY connect event fail signature verification (400)
// — a silent money-core outage. Warn loudly at boot so it's caught in ops, not
// by a client complaint. (Dark feature, so not fatal.)
if (!process.env.STRIPE_CONNECT_WEBHOOK_SECRET) {
  console.warn('[boot] STRIPE_CONNECT_WEBHOOK_SECRET is not set — Connect (SaaS mode) webhooks will reject all events until it is configured.');
}

// Maintenance mode gate — see middleware/maintenanceGate. Exempts /api/auth,
// /api/admin, /api/internal, /health so admins can always log in and toggle it
// off. Stripe webhooks are mounted above this middleware and bypass it entirely.
app.use(require('./middleware/maintenanceGate'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Strip MongoDB operator-injection keys ($ne/$gt/$where/...) from all parsed
// input before any route handler builds a query. (Phase 20 hardening.)
app.use(require('./middleware/mongoSanitize'));

// W0 (writing-moment UX plan): request-timing instrumentation. Logs any
// request slower than REQUEST_TIMING_MIN_MS (default 250ms). SSE routes log
// their full stream duration on finish — long lines there are expected; the
// interesting numbers are the [timing] lines from aiController (setup pushes,
// time-to-first-engine-byte) that break the total down.
const REQUEST_TIMING_MIN_MS = parseInt(process.env.REQUEST_TIMING_MIN_MS || '250', 10);
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (ms >= REQUEST_TIMING_MIN_MS) {
      console.log(`[timing] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// Rate limiting — skip the internal API. Internal traffic comes from the Go
// writing-engine (server-to-server, authenticated by INTERNAL_API_KEY) and
// can legitimately make many CFS reads per plan-mode turn. Throttling it
// like user traffic would intermittently break plan mode.
//
// Uses req.originalUrl (always the full pathname) rather than req.path
// (which depends on Express's mount-stripping behavior). (Bug 4 from M2
// second-round review.)
const ENV_DEFAULT_MAX = process.env.NODE_ENV === 'production' ? 100 : 1000;
function buildApiLimiter() {
  const rl = systemSettingsService.getSettings().rateLimit || {};
  return rateLimit({
    // windowMs is fixed at construction — express-rate-limit only re-evaluates
    // `max` per request, so the limiter is rebuilt on settings change.
    windowMs: rl.windowMs || 15 * 60 * 1000,
    max: () => systemSettingsService.getSettings().rateLimit?.max || ENV_DEFAULT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    // Skip server-to-server engine traffic, and W5-b ghost-text autocomplete —
    // it fires on every typing pause, so throttling it by this per-IP bucket
    // would 429 the whole app for one active writer. It has its OWN per-user
    // limiter in workspaceRoutes (autocompleteLimiter). Match the /ai/autocomplete
    // suffix on originalUrl (with or without a query string).
    skip: (req) => req.originalUrl.startsWith('/api/internal/') ||
      // The notification bell polls every ~90s per tab and has its own per-user
      // limiter (notificationRoutes) — counting it in this per-IP bucket would
      // 429 a whole NATed office for one active user.
      req.originalUrl.startsWith('/api/notifications') ||
      /\/ai\/autocomplete(?:\?|$)/.test(req.originalUrl),
  });
}
let apiLimiter = buildApiLimiter();
// Rebuild only when windowMs actually changes — `max` is already read
// per-request, and every rebuild resets the in-memory hit counters, so
// unrelated settings saves (email toggle, backup config) must not trigger it.
let limiterWindowMs = systemSettingsService.getSettings().rateLimit?.windowMs ?? null;
systemSettingsService.onSettingsChange((settings) => {
  const nextWindowMs = settings.rateLimit?.windowMs ?? null;
  if (nextWindowMs === limiterWindowMs) return;
  limiterWindowMs = nextWindowMs;
  apiLimiter = buildApiLimiter();
});
app.use('/api/', (req, res, next) => apiLimiter(req, res, next));

// Routes
// Note: ObjectId param validation is installed inside each individual route
// module via `installIdValidators(router)` — Express 4.x param callbacks
// are router-local and don't propagate from app to sub-routers.
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const billingRoutes = require('./routes/billingRoutes');
const workspaceRoutes = require('./routes/workspaceRoutes');
const workspaceCrudRoutes = require('./routes/workspaceCrudRoutes');
const aiTrackerRoutes = require('./routes/aiTrackerRoutes');
const keywordRoutes = require('./routes/keywordRoutes');
const imageRoutes = require('./routes/imageRoutes');
const brandVoiceRoutes = require('./routes/brandVoiceRoutes');
const sitesRoutes = require('./routes/sitesRoutes');
const sitemapRoutes = require('./routes/sitemapRoutes');
const orgRoutes = require('./routes/orgRoutes');
const organizationRoutes = require('./routes/organizationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');
const contactRoutes = require('./routes/contactRoutes');
const internalCfsRoutes = require('./routes/internalCfsRoutes');
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/b2-image', imageRoutes);
app.use('/api/workspace', aiTrackerRoutes);
app.use('/api/workspace', keywordRoutes);
app.use('/api/workspace', brandVoiceRoutes);
app.use('/api/workspace', sitesRoutes);
app.use('/api/workspace', sitemapRoutes);
// Static GSC OAuth callback (Google redirects here — workspace number is in the state param)
const { authenticateToken: authForGsc } = require('./middleware/auth');
const sitesController = require('./controllers/sitesController');
app.get('/api/gsc/callback', authForGsc, sitesController.handleGscCallback);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/workspaces', workspaceCrudRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/invites', require('./routes/inviteRoutes'));
app.use('/api/tenant', require('./routes/tenantRoutes'));
app.use('/api/admin', adminRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/contact', contactRoutes);
app.use('/api/observe', require('./routes/observeRoutes')); // Phase 7.3 product metrics

// Public, unauthenticated endpoints (token-gated shared reports)
app.use('/api/public', require('./routes/publicRoutes'));

// Free marketing tools (unauthenticated compute — guarded per-route by
// publicToolsGuard: honeypot, per-IP daily caps, daily budget kill-switch)
app.use('/api/public/tools', require('./routes/publicToolsRoutes'));

// Public contact form (unauthenticated: honeypot, per-IP daily cap, HTML-
// escaped notification email). Mounted after /api/public because publicRoutes
// only handles /reports/:token and cannot swallow this path.
// The authenticated twin at /api/contact above is unchanged.
app.use('/api/public/contact', require('./routes/publicContactRoutes'));

// Internal API for the Go writing-engine (CFS reads, plan writes, skills
// bridge). Gated by internalAuth middleware — NOT user-facing.
app.use('/api/internal/cfs', internalCfsRoutes);
app.use('/api/internal/skills', require('./routes/internalSkillsRoutes'));

// Dev-only routes (never in production, file may not exist)
if (process.env.NODE_ENV !== 'production') {
  try { app.use(require('./routes/devRoutes')); } catch {}
}

// Scheduled scan: check daily at 3:00 AM for trackers due for scan.
// NOTE: the schedule is daily in both dev and prod. _devTimeScale (see
// aiTrackerController.js) only accelerates per-prompt frequency math —
// it does NOT change how often this cron fires. To test the scan loop
// in dev, manually invoke executeScan or change cronSchedule below.
const cron = require('node-cron');
const AiTracker = require('./models/AiTracker');
const SitemapModel = require('./models/Sitemap');
const Workspace = require('./models/Workspace');
const { executeScan } = require('./controllers/aiTrackerController');
const { crawlSite: crawlSitemapSite } = require('./services/sitemapCrawlerService');
const tierServiceForCron = require('./services/tierService');

const cronSchedule = '0 3 * * *'; // Daily at 3 AM
console.log(`[cron] scheduled tasks: daily at 3 AM`);

// F4-26: separate "DB unreachable" from "handler bug". The prior single
// counter incremented on ANY thrown error and muted logs after 4 — masking
// real handler bugs for days. Now:
//  - cronDbFailures: only DB-query failures (drives circuit-breaker)
//  - handler errors are surfaced unconditionally (loud, not muted)
let cronDbFailures = 0;
let cronNextRetryAt = 0; // ms timestamp; deterministic backoff, not Math.random

cron.schedule(cronSchedule, async () => {
  // Circuit breaker: skip ticks deterministically when DB has been failing.
  // Backoff: 2^N minutes, capped at 30. Reset on first successful query.
  if (cronDbFailures > 0 && Date.now() < cronNextRetryAt) {
    return; // not time to retry yet
  }

  try {
    // Recover scans stuck in 'scanning' for 30+ min (e.g. after internet drop)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recovered = await AiTracker.updateMany(
      { scanStatus: { $in: ['scanning', 'pending'] }, updatedAt: { $lt: thirtyMinAgo } },
      { $set: { scanStatus: 'failed', scanError: 'Scan timed out (recovered by cron)' } }
    );
    if (recovered.modifiedCount > 0) {
      console.log(`[cron] recovered ${recovered.modifiedCount} stuck scan(s)`);
    }

    // F4-13: refund orphan pending CreditTransactions (>30 min old). Catches
    // crashes that the startup sweep missed (e.g., scan completed but settle
    // never marked the tx). Wrapped in its own try so cred-system issues
    // don't break the tracker scheduler. Sweep lives in creditService
    // (single-sourced + tested, Phase 3).
    try {
      const creditServiceCron = require('./services/creditService');
      await creditServiceCron.sweepOrphanedPendingCredits({ logPrefix: '[cron]' });
    } catch (e) {
      console.error('[cron] orphan credit sweep failed:', e.message);
    }

    // The due-tracker query is the DB-health signal. Failures here drive the
    // circuit breaker. Everything else (handler errors) is logged unconditionally.
    let dueTrackers;
    try {
      dueTrackers = await AiTracker.find({
        scanStatus: { $in: ['ready', 'failed'] },
        nextScanAt: { $lte: new Date() },
      });

      // DB query succeeded — reset circuit breaker
      if (cronDbFailures > 0) {
        console.log(`[cron] DB connection recovered after ${cronDbFailures} failure(s)`);
        cronDbFailures = 0;
        cronNextRetryAt = 0;
      }
    } catch (dbErr) {
      cronDbFailures++;
      // Deterministic exponential backoff: next retry in 2^(N-1) minutes,
      // capped at 30 min. (Was: Math.random() skip with no log after 4.)
      const backoffMin = Math.min(Math.pow(2, cronDbFailures - 1), 30);
      cronNextRetryAt = Date.now() + backoffMin * 60 * 1000;
      // Log every DB failure but throttle the visible severity. Operators
      // who care can grep '[cron] DB' for the full picture.
      if (cronDbFailures <= 3) {
        console.error(`[cron] DB query failed (${cronDbFailures}):`, dbErr.message);
      } else if (cronDbFailures === 4) {
        console.error(`[cron] DB sustained failure (${cronDbFailures}); next retry in ${backoffMin}min`);
      } else if (cronDbFailures % 10 === 0) {
        // Periodic reminder for prolonged outages
        console.error(`[cron] DB still failing (${cronDbFailures}); next retry in ${backoffMin}min`);
      }
      return;
    }

    console.log(`[cron] tick — ${dueTrackers.length} tracker(s) due`);
    if (dueTrackers.length === 0) return;
    console.log(`[cron] Found ${dueTrackers.length} tracker(s) due for scan`);

    await Promise.allSettled(dueTrackers.map(async (tracker) => {
      const ws = await Workspace.findById(tracker.workspaceId);
      const userId = ws?.userId?.toString() || null;
      try {
        await executeScan(tracker._id, userId);
      } catch (err) {
        // Per-tracker handler errors are NEVER muted — that's the F4-26 fix.
        // A handler bug would have hidden for days under the old shared
        // counter; now it's loud every tick.
        console.error(`[cron] scan failed for tracker ${tracker._id}:`, err.message, err.stack);
      }
    }));
  } catch (err) {
    // Anything that escapes the inner try (e.g., a programmer bug in this
    // file). Never mute these — operator needs to see them.
    console.error('[cron] unexpected handler error:', err.message, err.stack);
  }
});

// ─── Sitemap crawl scheduler (weekly, checked every cron tick) ──────────────
cron.schedule(cronSchedule, async () => {
  try {
    // Recover stuck crawls (30+ min)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await SitemapModel.updateMany(
      { crawlStatus: 'crawling', updatedAt: { $lt: thirtyMinAgo } },
      {
        // Apply backoff on recovery too — otherwise a crawl that chronically hangs
        // is recovered to 'error' with its old (past) nextCrawlAt and re-fires
        // every tick forever (the finding-J bug, for the hang path). Flat 6h here;
        // the next attempt routes through crawlSite's exponential backoff/give-up.
        $set: {
          crawlStatus: 'error',
          crawlError: 'Crawl timed out (recovered by cron)',
          nextCrawlAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        },
        $inc: { crawlFailCount: 1 },
      }
    );

    const dueSitemaps = await SitemapModel.find({
      crawlStatus: { $in: ['idle', 'completed', 'error'] },
      nextCrawlAt: { $lte: new Date() },
    });

    if (dueSitemaps.length === 0) return;
    console.log(`[cron] ${dueSitemaps.length} sitemap(s) due for crawl`);

    // Group by org and crawl each org's due sitemaps SEQUENTIALLY (the per-org
    // guard allows only one active crawl per org), running different orgs in
    // parallel. A flat concurrent fan-out would start an org's sitemaps at once,
    // so all but the lowest-id one would defer to the next tick (finding H1).
    const dueByOrg = new Map();
    for (const s of dueSitemaps) {
      const key = String(s.organizationId);
      if (!dueByOrg.has(key)) dueByOrg.set(key, []);
      dueByOrg.get(key).push(s);
    }
    await Promise.allSettled([...dueByOrg.values()].map(async (orgSitemaps) => {
      for (const s of orgSitemaps) {
        try {
          const { config } = await tierServiceForCron.getOrgTierConfig(s.organizationId);
          const maxPages = config.maxCrawlPages ?? 500;
          await crawlSitemapSite(s._id, { maxPages });
        } catch (err) {
          console.error(`[cron] sitemap crawl failed for ${s._id}:`, err.message);
        }
      }
    }));
  } catch (err) {
    console.error('[cron] sitemap scheduler error:', err.message);
  }
});

// ─── SERP drift sweep (Rec 10) — weekly, Monday 04:00 ───────────────────────
// Near-$0 dynamism: one Serper /api/discover query per eligible content (paid
// orgs, analyzed >21d ago, active <90d, not already flagged; capped batch).
// Flags drifted SERPs for USER-triggered (quota-gated, Rec 5) re-analysis —
// this cron NEVER runs the LLM pipeline. Cost ≈ batchSize × (1 Serper query
// PER targetKeyword, up to 5) — volume enrichment is skipped (skip_volumes).
// Kill-switch: DRIFT_SWEEP_ENABLED=false. Offset to 04:00 Monday to stay
// clear of the 03:00 dailies. Per-doc failures are counted inside the sweep;
// this wrapper only catches programmer errors (loud, never muted).
const { runDriftSweep } = require('./services/driftService');
if (process.env.DRIFT_SWEEP_ENABLED !== 'false') {
  cron.schedule('0 4 * * 1', async () => {
    try {
      await runDriftSweep({ batchSize: 50 });
    } catch (err) {
      console.error('[drift] sweep failed:', err.message, err.stack);
    }
  });
  console.log('[cron] drift sweep scheduled: Mondays 04:00');
} else {
  console.log('[cron] drift sweep disabled (DRIFT_SWEEP_ENABLED=false)');
}

// ─── Outcome snapshots (Rec 14) — weekly, Monday 04:30 ──────────────────────
// Records score/GSC-position/clicks/AI-visibility per analyzed content so the
// editor's Results panel and monthly reports can show before/after deltas.
// $0 external cost: GSC API is free (cached), rest is Mongo. Offset 30min
// after the drift sweep. Kill-switch: OUTCOME_SWEEP_ENABLED=false.
const { runOutcomeSweep } = require('./services/outcomeService');
if (process.env.OUTCOME_SWEEP_ENABLED !== 'false') {
  cron.schedule('30 4 * * 1', async () => {
    try {
      await runOutcomeSweep({ batchSize: 100 });
    } catch (err) {
      console.error('[outcome] sweep failed:', err.message, err.stack);
    }
  });
  console.log('[cron] outcome sweep scheduled: Mondays 04:30');
} else {
  console.log('[cron] outcome sweep disabled (OUTCOME_SWEEP_ENABLED=false)');
}

// ─── Tenant domain status re-check (daily) ──────────────────────────────────
// Advances pending_ssl domains whose Cloudflare cert went active, and demotes
// active domains whose CNAME no longer points at us. Sequential on purpose —
// domain counts are small and we'd rather not burst DNS/CF lookups.
const DomainForCron = require('./models/Domain');
const domainServiceForCron = require('./services/domainService');
cron.schedule(cronSchedule, async () => {
  try {
    const domains = await DomainForCron.find({ status: { $in: ['pending_ssl', 'active'] } });
    if (domains.length === 0) return;
    console.log(`[cron] re-checking ${domains.length} tenant domain(s)`);

    for (const domain of domains) {
      try {
        await domainServiceForCron.refreshDomainStatus(domain);
      } catch (err) {
        console.error(`[cron] domain re-check failed for ${domain.hostname}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] domain re-check scheduler error:', err.message);
  }
});

// ─── Monthly workspace reports (Phase 14) ───────────────────────────────────
// 1st of each month at 03:30 UTC: for every org on a PAID tier
// (active/trialing Subscription), generate the previous month's snapshot for
// each workspace (if missing) and email the org owner + client-role workspace
// members a fresh 90-day share link. Dedupe marker: reportEmailedAt on the
// snapshot — emails go out whenever it is null (manual generation must not
// suppress the monthly email; a crash between generate and email retries on
// the next run), and re-runs (deploy/restart on the 1st) never double-send.
const SubscriptionForReports = require('./models/Subscription');
const ReportSnapshotForCron = require('./models/ReportSnapshot');
const WorkspaceMemberForReports = require('./models/WorkspaceMember');
const OrganizationForReports = require('./models/Organization');
const UserForReports = require('./models/User');
const reportServiceForCron = require('./services/reportService');
const { applyCustomTemplate: applyTemplateForReports } = require('./controllers/emailPortalController');
const { sendEmail: sendEmailForReports } = require('./utils/emailService');

// timezone MUST be UTC: previousPeriod() is UTC month math. If this job
// fired in server-local time on a UTC+N box, midnight-local on the 1st is
// still the PREVIOUS month in UTC — previousPeriod() would compute the wrong
// month, collide with the already-emailed snapshot, and silently skip every
// workspace forever.
cron.schedule('30 3 1 * *', async () => {
  try {
    const period = reportServiceForCron.previousPeriod();
    const paidSubs = await SubscriptionForReports.find({
      status: { $in: ['active', 'trialing'] },
      planId: { $ne: 'free' },
      organizationId: { $ne: null },
    })
      .select('organizationId')
      .lean();

    if (paidSubs.length === 0) return;
    console.log(`[cron] monthly reports (${period}) — ${paidSubs.length} paid org(s)`);

    for (const sub of paidSubs) {
      const orgId = sub.organizationId;
      try {
        const [org, workspaces] = await Promise.all([
          OrganizationForReports.findById(orgId).select('ownerId name').lean(),
          Workspace.find({ organizationId: orgId }).select('_id name').lean(),
        ]);
        if (!org || workspaces.length === 0) continue;

        const owner = await UserForReports.findById(org.ownerId).select('email').lean();
        const baseUrl = await domainServiceForCron.resolveBaseUrl(orgId); // Invariant I1

        for (const ws of workspaces) {
          try {
            let snapshot = await ReportSnapshotForCron.findOne({
              workspaceId: ws._id,
              period,
            })
              .select('_id reportEmailedAt')
              .lean();
            // Skip only when generated AND emailed — a manually generated
            // snapshot (reportEmailedAt null) still gets its monthly email.
            if (snapshot && snapshot.reportEmailedAt) continue;

            if (!snapshot) {
              snapshot = await reportServiceForCron.generateSnapshot(ws._id, period);
            }

            // Recipients: org owner + client-role members of THIS workspace
            const clientMembers = await WorkspaceMemberForReports.find({
              workspaceId: ws._id,
              role: 'client',
              status: 'active',
            })
              .select('email')
              .lean();
            const recipients = [
              ...new Set(
                [owner?.email, ...clientMembers.map((m) => m.email)].filter(Boolean)
              ),
            ];
            if (recipients.length === 0) {
              // Nothing to send — mark done so we don't re-check forever.
              await ReportSnapshotForCron.updateOne(
                { _id: snapshot._id },
                { $set: { reportEmailedAt: new Date() } }
              );
              continue;
            }

            // rotateShare (revoke + create) preserves the one-live-link-per-
            // report invariant — a bare createShare here would stack links.
            const { rawToken } = await reportServiceForCron.rotateShare(snapshot._id, {
              ttlDays: 90,
            });
            const reportUrl = `${baseUrl}/r/${rawToken}`;

            let sentCount = 0;
            for (const to of recipients) {
              try {
                const emailOptions = {
                  to,
                  orgId, // Phase 11 tenant sender identity
                  data: {
                    workspaceName: ws.name || 'Workspace',
                    // Human-readable for the client-facing email ('June 2026').
                    // The raw 'YYYY-MM' period is used for all DB/query work.
                    period: reportServiceForCron.formatPeriodLabel(period),
                    reportUrl,
                  },
                };
                await applyTemplateForReports('monthly_report', emailOptions, orgId);
                await sendEmailForReports(emailOptions);
                sentCount++;
              } catch (emailErr) {
                console.error(`[cron] monthly report email to ${to} failed:`, emailErr.message);
              }
            }

            // Mark emailed only if at least one send succeeded — a total
            // outage (0 sent) leaves the marker null so the next run retries.
            if (sentCount > 0) {
              await ReportSnapshotForCron.updateOne(
                { _id: snapshot._id },
                { $set: { reportEmailedAt: new Date() } }
              );
            }
          } catch (wsErr) {
            console.error(`[cron] monthly report failed for workspace ${ws._id}:`, wsErr.message);
          }
        }
      } catch (orgErr) {
        console.error(`[cron] monthly reports failed for org ${orgId}:`, orgErr.message);
      }
    }
  } catch (err) {
    console.error('[cron] monthly report scheduler error:', err.message);
  }
}, { timezone: 'Etc/UTC' });

// ─── Phase 7: monthly subscription credit grant (daily, idempotent) ─────────
// Grants each active paid org its monthly allocation with one-month rollover.
// grantMonthlyCreditsIfDue keys on the calendar month (UTC), so running DAILY is
// safe — it's a no-op once the month is granted and self-heals a missed day.
// This is what makes a YEARLY plan still receive credits every month: Stripe
// fires an invoice only once a year, so the renewal webhook alone would starve
// months 2–12. Monthly plans are granted by whichever fires first (webhook or
// this cron); the other no-ops. Daily at 04:00 UTC.
const SubscriptionForCredits = require('./models/Subscription');
const creditServiceForGrants = require('./services/creditService');
cron.schedule('0 4 * * *', async () => {
  try {
    const subs = await SubscriptionForCredits.find({
      status: { $in: ['active', 'trialing'] },
      planId: { $ne: 'free' },
      organizationId: { $ne: null },
    }).select('organizationId').lean();
    if (subs.length === 0) return;

    let granted = 0;
    for (const s of subs) {
      try {
        const { config } = await tierServiceForCron.getOrgTierConfig(s.organizationId);
        if (!config?.creditsPerMonth) continue;
        // Re-verify the sub is STILL active immediately before granting: the list
        // above is a snapshot, and a cancellation mid-loop resets creditPeriodKey
        // (for same-month resubscribe), which would otherwise let a stale entry
        // re-grant a just-canceled org. Fresh indexed read → the window shrinks to
        // ~nothing.
        const stillActive = await SubscriptionForCredits.exists({
          organizationId: s.organizationId,
          status: { $in: ['active', 'trialing'] },
          planId: { $ne: 'free' },
        });
        if (!stillActive) continue;
        const r = await creditServiceForGrants.grantMonthlyCreditsIfDue(s.organizationId, config.creditsPerMonth);
        if (r.granted) granted++;
      } catch (err) {
        console.error(`[cron] monthly credit grant failed org=${s.organizationId}:`, err.message);
      }
    }
    if (granted > 0) console.log(`[cron] monthly credits: granted ${granted}/${subs.length} paid org(s)`);
  } catch (err) {
    console.error('[cron] monthly credit grant scheduler error:', err.message);
  }
}, { timezone: 'Etc/UTC' });

// ─── Phase 18 (DARK): tenant lifecycle — suspend agency orgs whose offboarding
// grace (30 days) has elapsed. runDueSuspensions() self-gates on the saasMode
// flag, so this is a silent no-op until Phase 18 launches. Daily at 03:15 UTC.
const lifecycleServiceForCron = require('./services/lifecycleService');
cron.schedule('15 3 * * *', async () => {
  try {
    const result = await lifecycleServiceForCron.runDueSuspensions();
    if (result.due > 0) {
      console.log(`[cron] lifecycle: suspended ${result.suspended}/${result.due} agency org(s) past grace`);
    }
  } catch (err) {
    console.error('[cron] lifecycle suspension scheduler error:', err.message);
  }
}, { timezone: 'Etc/UTC' });

// ─── Phase 18C (DARK): retention purge — permanently erase the client workspaces
// of suspended agency orgs whose 90-day retention (purgeAt) has elapsed.
// runDuePurges() self-gates on the dataErasure flag, so this is a silent no-op
// until Phase 18C launches. Daily at 03:45 UTC (after the suspension sweep).
const deletionServiceForCron = require('./services/deletionService');
cron.schedule('45 3 * * *', async () => {
  try {
    const result = await deletionServiceForCron.runDuePurges();
    if (result.due > 0) {
      console.log(`[cron] retention purge: purged ${result.purged}/${result.due} suspended org(s) past retention`);
    }
  } catch (err) {
    console.error('[cron] retention purge scheduler error:', err.message);
  }
}, { timezone: 'Etc/UTC' });

// ─── Threads P5: nightly prune of archived conversations past retention
// (default 90d, THREAD_ARCHIVE_RETENTION_DAYS). Children-first — a TTL index
// on the thread could not cascade to its messages. Self-gates on the
// aiThreads flag. 04:10 UTC, after the retention purge.
const threadServiceForCron = require('./services/threadService');
cron.schedule('10 4 * * *', async () => {
  try {
    const r = await threadServiceForCron.pruneArchivedThreads();
    if (r.due > 0) {
      console.log(`[cron] thread prune: ${r.threads} thread(s) + ${r.messages} message(s) past retention removed`);
    }
  } catch (err) {
    console.error('[cron] thread prune scheduler error:', err.message);
  }
}, { timezone: 'Etc/UTC' });

// ─── Phase 18D (DARK): hourly restore sweeps —
//  (1) resumeStuckRestores: finish restores stranded in 'restoring' by a crash
//      (not flag-gated: none can exist unless saasMode was live, and darking the
//      flag must not strand them);
//  (2) restoreEntitledSuspended: restore suspended orgs that re-subscribed while
//      mid-'suspending'/'purging' (reconcile has no transient-state branch, so
//      that wakeup would otherwise be lost until the next billing webhook).
// Both are no-ops while saasMode has never been live. Hourly at :20.
const restoreServiceForCron = require('./services/restoreService');
cron.schedule('20 * * * *', async () => {
  try {
    const result = await restoreServiceForCron.resumeStuckRestores();
    if (result.stuck > 0) {
      console.log(`[cron] restore resume: resumed ${result.resumed}/${result.stuck} stranded 'restoring' org(s)`);
    }
    const swept = await restoreServiceForCron.restoreEntitledSuspended();
    if (swept.restored > 0) {
      console.log(`[cron] restore sweep: restored ${swept.restored}/${swept.checked} re-entitled suspended org(s)`);
    }
  } catch (err) {
    console.error('[cron] restore resume scheduler error:', err.message);
  }
}, { timezone: 'Etc/UTC' });

// Health check. DB drives the status code (liveness). E8: the writing-engine is
// probed too, but NON-FATALLY — its reachability is reported for observability
// and never flips the backend's own health (the engine has its own liveness).
app.get('/health', async (req, res) => {
  const db = checkConnectionHealth();
  const engine = await require('./services/writingEngine').checkEngineHealth();
  res.status(db.isConnected ? 200 : 503).json({
    status: db.isConnected ? 'ok' : 'error',
    database: db.state,
    engine,
    uptime: Math.floor(process.uptime()),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  // Mongoose error normalization — convert framework errors that escape
  // per-controller try/catch into clean 4xx responses with stable codes.
  // Eliminates the "leaky generic 500" pattern across all controllers.
  const mongoose = require('mongoose');

  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: err.message,
    });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_ID',
      message: `Invalid ${err.path || 'id'} format`,
    });
  }
  // MongoServerError 11000 = duplicate key (unique index violation)
  if (err && err.code === 11000) {
    return res.status(409).json({
      status: 'error',
      code: 'DUPLICATE_KEY',
      message: 'Resource already exists',
    });
  }

  console.error('Error:', err.message);
  res.status(err.status || 500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// Start server
const PORT = process.env.PORT || 4001;
const server = app.listen(PORT, () => {
  console.log(`SupaRank server running on port ${PORT}`);
});

// Graceful shutdown
const cleanup = async () => {
  console.log('Shutting down...');
  server.close();
  const mongoose = require('mongoose');
  await mongoose.connection.close();
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

module.exports = app;
