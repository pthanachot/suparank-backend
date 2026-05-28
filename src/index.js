// Suparank Express backend — single source of truth for all data persistence
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

dotenv.config();

const { connectDB, checkConnectionHealth } = require('./config/database');
const { syncConfig } = require('./scripts/configSync');

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
  })
  .then(() => syncConfig())
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
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.originalUrl.startsWith('/api/internal/'),
});
app.use('/api/', apiLimiter);

// Routes
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

// Scheduled scan: check daily at 3:00 AM for trackers due for scan
// In development, run every minute so frequency logic can be tested without waiting overnight
const cron = require('node-cron');
const AiTracker = require('./models/AiTracker');
const SitemapModel = require('./models/Sitemap');
const Workspace = require('./models/Workspace');
const { executeScan } = require('./controllers/aiTrackerController');
const { crawlSite: crawlSitemapSite } = require('./services/sitemapCrawlerService');
const tierServiceForCron = require('./services/tierService');

const cronSchedule = '0 3 * * *'; // Daily at 3 AM
console.log(`[cron] scheduled tasks: daily at 3 AM`);

let cronConsecutiveFailures = 0;

cron.schedule(cronSchedule, async () => {
  // Circuit breaker: skip ticks with exponential backoff when DB is unreachable
  if (cronConsecutiveFailures > 0) {
    const skipTicks = Math.min(Math.pow(2, cronConsecutiveFailures - 1), 30); // max ~30 min pause in dev
    const shouldSkip = cronConsecutiveFailures > 1 && Math.random() > (1 / skipTicks);
    if (shouldSkip) return; // silently skip to avoid log flood
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

    const dueTrackers = await AiTracker.find({
      scanStatus: { $in: ['ready', 'failed'] },
      nextScanAt: { $lte: new Date() },
    });

    // DB query succeeded — reset circuit breaker
    if (cronConsecutiveFailures > 0) {
      console.log(`[cron] DB connection recovered after ${cronConsecutiveFailures} failure(s)`);
      cronConsecutiveFailures = 0;
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
        console.error(`[cron] scan failed for tracker ${tracker._id}:`, err.message);
      }
    }));
  } catch (err) {
    cronConsecutiveFailures++;
    if (cronConsecutiveFailures <= 3) {
      console.error('[cron] scheduled scan check failed:', err.message);
    } else if (cronConsecutiveFailures === 4) {
      console.error(`[cron] DB unreachable (${cronConsecutiveFailures} consecutive failures), suppressing further logs until recovery`);
    }
    // After 4+ failures, logs are silenced until recovery
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
