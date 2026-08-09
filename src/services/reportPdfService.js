/**
 * Report → PDF rendering (Phase 14). Env-gated external, cloudflareService
 * style: puppeteer is an optional heavyweight — when it (or its browser
 * binary) is missing, isAvailable() is false and generatePdf throws a
 * 501-status error that the controller maps to a clean JSON response.
 *
 * Rendering strategy: mint a short-lived INTERNAL ReportShare token, point
 * headless Chrome at the frontend's public report page
 * (`${FRONTEND_URL}/r/<token>?pdf=1`), print to A4, delete the token.
 * The frontend page is the single source of report presentation — no
 * duplicate HTML template to keep in sync.
 */

const fs = require('fs');
const ReportShare = require('../models/ReportShare');
const reportService = require('./reportService');
const { appUrl, isConfigured } = require('../config/appUrl');

const INTERNAL_TOKEN_TTL_DAYS = 15 / (24 * 60); // 15 minutes
const NAV_TIMEOUT_MS = 60 * 1000;
const RENDER_STATE_TIMEOUT_MS = 30 * 1000;

// Concurrency cap: each generatePdf spawns a full Chromium. Without a cap a
// client-role user firing parallel PDF requests can OOM the box. Saturated
// requests fail fast with 429 rather than queueing unboundedly.
const MAX_CONCURRENT_PDF = 2;
let _activePdfCount = 0;

// Lazy require — puppeteer may not be installed/downloaded in every env.
let _puppeteer;
let _loadError = null;

function _loadPuppeteer() {
  if (_puppeteer !== undefined) return _puppeteer;
  try {
    // eslint-disable-next-line global-require
    _puppeteer = require('puppeteer');
  } catch (err) {
    _puppeteer = null;
    _loadError = err.message;
  }
  return _puppeteer;
}

/**
 * True when puppeteer is installed AND its browser binary exists on disk.
 * Async because puppeteer v22+ made executablePath() return a Promise
 * (it resolves the managed-browser cache lazily).
 */
async function isAvailable() {
  const puppeteer = _loadPuppeteer();
  if (!puppeteer) return false;
  try {
    const execPath =
      process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath());
    return typeof execPath === 'string' && execPath.length > 0 && fs.existsSync(execPath);
  } catch {
    return false;
  }
}

function _unavailableError(detail) {
  const err = new Error(
    `PDF export is not available on this server${detail ? ` (${detail})` : ''}. ` +
      'Install puppeteer and its Chromium binary to enable it.'
  );
  err.status = 501;
  return err;
}

/**
 * Render a report snapshot to a PDF Buffer. Always closes the browser and
 * always deletes the internal share row, even on failure.
 * Throws err.status=501 when puppeteer is unavailable / FRONTEND_URL is not
 * configured, 429 when the concurrency cap is saturated, and 502 when the
 * report page renders its error state (never a silent broken PDF).
 */
async function generatePdf(reportId) {
  if (_activePdfCount >= MAX_CONCURRENT_PDF) {
    const err = new Error('PDF generation busy — try again shortly');
    err.status = 429;
    throw err;
  }
  _activePdfCount++;
  try {
    return await _generatePdf(reportId);
  } finally {
    _activePdfCount--;
  }
}

async function _generatePdf(reportId) {
  if (!(await isAvailable())) throw _unavailableError(_loadError);
  const puppeteer = _loadPuppeteer();

  // Refuse to silently guess the origin — an unconfigured host would render
  // somebody's dev box (or nothing) into the PDF. This gates on "was an origin
  // explicitly configured", not on one specific var, so APP_URL satisfies it too.
  if (!isConfigured()) {
    const err = new Error(
      'PDF export is not configured on this server: neither APP_URL nor FRONTEND_URL is set.'
    );
    err.status = 501;
    throw err;
  }
  const baseUrl = appUrl();

  // Internal 15-minute token so the headless browser can load the page
  // without auth. Marked internal so it never shows up as a "shared" state
  // and survives share revocation semantics.
  const { share, rawToken } = await reportService.createShare(reportId, {
    ttlDays: INTERNAL_TOKEN_TTL_DAYS,
    internal: true,
  });

  let browser = null;
  try {
    try {
      browser = await puppeteer.launch({
        headless: true,
        // Required for containerized deploys (Railway/Docker run as root
        // without a usable sandbox; /dev/shm is tiny in containers).
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      throw _unavailableError(`browser launch failed: ${err.message}`);
    }

    const page = await browser.newPage();
    await page.goto(`${baseUrl}/r/${rawToken}?pdf=1`, {
      waitUntil: 'networkidle0',
      timeout: NAV_TIMEOUT_MS,
    });

    // The page sets data-report-state="ready" once the report rendered and
    // "error" on the invalid-link card — this selector is the real render
    // signal (networkidle0 alone can't tell a report from an error card).
    await page.waitForSelector('[data-report-state]', {
      timeout: RENDER_STATE_TIMEOUT_MS,
    });
    const reportState = await page.$eval('[data-report-state]', (el) =>
      el.getAttribute('data-report-state')
    );
    if (reportState !== 'ready') {
      const err = new Error(
        `Report page failed to render (state: ${reportState || 'unknown'}) — ` +
          'the share token may be invalid or the report data failed to load.'
      );
      err.status = 502;
      throw err;
    }

    const buffer = await page.pdf({ format: 'A4', printBackground: true });
    return Buffer.from(buffer);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error('[reportPdf] browser close failed:', err.message);
      }
    }
    // Best-effort: the TTL index is the backstop if this delete fails
    try {
      await ReportShare.deleteOne({ _id: share._id });
    } catch (err) {
      console.error('[reportPdf] internal share cleanup failed:', err.message);
    }
  }
}

module.exports = { isAvailable, generatePdf };
