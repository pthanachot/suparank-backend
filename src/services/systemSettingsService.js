/**
 * systemSettingsService — in-memory cache over the SystemSettings singleton.
 *
 * getSettings() is synchronous and request-path safe. loadSettings() runs once
 * at boot after the DB connects; updateSettings() persists a patch, refreshes
 * the cache, and notifies listeners (e.g. the rate-limiter rebuild in index.js).
 */
const SystemSettings = require('../models/SystemSettings');

const DEFAULTS = Object.freeze({
  maintenanceMode: false,
  emailNotificationsEnabled: true,
  rateLimit: { windowMs: null, max: null },
  adminEmails: [],
  backup: { directory: null, retentionCount: 7 },
});

let cache = { ...DEFAULTS };
const listeners = [];

function toPlain(doc) {
  return {
    maintenanceMode: doc.maintenanceMode ?? DEFAULTS.maintenanceMode,
    emailNotificationsEnabled: doc.emailNotificationsEnabled ?? DEFAULTS.emailNotificationsEnabled,
    rateLimit: {
      windowMs: doc.rateLimit?.windowMs ?? null,
      max: doc.rateLimit?.max ?? null,
    },
    adminEmails: Array.isArray(doc.adminEmails) ? doc.adminEmails : [],
    backup: {
      directory: doc.backup?.directory ?? null,
      retentionCount: doc.backup?.retentionCount ?? DEFAULTS.backup.retentionCount,
    },
  };
}

async function loadSettings() {
  try {
    const doc = await SystemSettings.findOneAndUpdate(
      { key: 'global' },
      { $setOnInsert: { key: 'global' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    cache = toPlain(doc);
    console.log('[systemSettings] Loaded');
  } catch (err) {
    console.error('[systemSettings] Load failed, using defaults:', err.message);
  }
  return cache;
}

function getSettings() {
  return cache;
}

/**
 * @param {object} patch — flat $set patch; nested fields use dot paths
 *   (e.g. { 'rateLimit.max': 200 }).
 */
async function updateSettings(patch) {
  const doc = await SystemSettings.findOneAndUpdate(
    { key: 'global' },
    { $set: patch },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  cache = toPlain(doc);
  for (const fn of listeners) {
    try {
      fn(cache);
    } catch (err) {
      console.error('[systemSettings] listener error:', err.message);
    }
  }
  return cache;
}

function onSettingsChange(fn) {
  listeners.push(fn);
}

module.exports = { loadSettings, getSettings, updateSettings, onSettingsChange, DEFAULTS };
