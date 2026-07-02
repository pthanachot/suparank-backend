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

    // F4-13: refund orphaned pending CreditTransactions. When a scan crashes
    // between preDeduct and settle (process kill, OOM, server restart), the
    // pre-deducted credits stay locked in `pending` state forever. This sweep
    // refunds any pending tx older than 30 min, releasing the debit.
    try {
      const CreditTransactionStartup = require('./models/CreditTransaction');
      const creditServiceStartup = require('./services/creditService');
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      const orphans = await CreditTransactionStartup.find({
        status: 'pending',
        createdAt: { $lt: thirtyMinAgo },
      }).select('_id').lean();
      let refundedGroups = 0;
      for (const orphan of orphans) {
        try {
          const result = await creditServiceStartup.refund(orphan._id.toString());
          if (result.refunded > 0) refundedGroups++;
        } catch (e) {
          console.error(`[startup] refund failed for tx ${orphan._id}:`, e.message);
        }
      }
      if (refundedGroups > 0) {
        console.log(`[startup] refunded ${refundedGroups} orphaned credit transaction group(s)`);
      }
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

// Maintenance mode gate. Exemptions: /api/auth (admins must be able to log
// in), /api/admin (the dashboard, including the toggle to turn this off),
// /api/internal (server-to-server engine traffic), /health. Stripe webhooks
// are mounted above this middleware so they bypass it entirely.
app.use((req, res, next) => {
  if (!systemSettingsService.getSettings().maintenanceMode) return next();
  const url = req.originalUrl;
  if (
    url.startsWith('/api/auth') ||
    url.startsWith('/api/admin') ||
    url.startsWith('/api/internal') ||
    url.startsWith('/health')
  ) {
    return next();
  }
  return res.status(503).json({ error: 'SupaRank is undergoing maintenance. Please try again shortly.' });
});

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    skip: (req) => req.originalUrl.startsWith('/api/internal/'),
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
app.use('/api/admin', adminRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/contact', contactRoutes);

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
    // don't break the tracker scheduler.
    try {
      const CreditTransactionCron = require('./models/CreditTransaction');
      const creditServiceCron = require('./services/creditService');
      const orphans = await CreditTransactionCron.find({
        status: 'pending',
        createdAt: { $lt: thirtyMinAgo },
      }).select('_id').lean();
      let refundedGroups = 0;
      for (const orphan of orphans) {
        try {
          const result = await creditServiceCron.refund(orphan._id.toString());
          if (result.refunded > 0) refundedGroups++;
        } catch (e) {
          console.error(`[cron] orphan refund failed for tx ${orphan._id}:`, e.message);
        }
      }
      if (refundedGroups > 0) {
        console.log(`[cron] refunded ${refundedGroups} orphaned credit transaction group(s)`);
      }
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
      { $set: { crawlStatus: 'error', crawlError: 'Crawl timed out (recovered by cron)' } }
    );

    const dueSitemaps = await SitemapModel.find({
      crawlStatus: { $in: ['idle', 'completed', 'error'] },
      nextCrawlAt: { $lte: new Date() },
    });

    if (dueSitemaps.length === 0) return;
    console.log(`[cron] ${dueSitemaps.length} sitemap(s) due for crawl`);

    await Promise.allSettled(dueSitemaps.map(async (s) => {
      try {
        const { config } = await tierServiceForCron.getOrgTierConfig(s.organizationId);
        const maxPages = config.maxCrawlPages ?? 500;
        await crawlSitemapSite(s._id, { maxPages });
      } catch (err) {
        console.error(`[cron] sitemap crawl failed for ${s._id}:`, err.message);
      }
    }));
  } catch (err) {
    console.error('[cron] sitemap scheduler error:', err.message);
  }
});

// Health check
app.get('/health', (req, res) => {
  const db = checkConnectionHealth();
  res.status(db.isConnected ? 200 : 503).json({
    status: db.isConnected ? 'ok' : 'error',
    database: db.state,
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
