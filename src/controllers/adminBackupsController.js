/**
 * Admin backups — list history and trigger a manual run. The run endpoint
 * responds immediately (202); the dump continues in the background and the
 * UI polls the list until the running record settles.
 */
const backupService = require('../services/backupService');

const getBackups = async (req, res) => {
  try {
    const backups = await backupService.listBackups(10);
    res.json({
      backups,
      running: backupService.isRunning(),
      effectiveDirectory: backupService.effectiveDirectory(),
    });
  } catch (error) {
    console.error('[admin] getBackups error:', error.message);
    res.status(500).json({ error: 'Failed to list backups' });
  }
};

const runBackupNow = async (req, res) => {
  try {
    if (backupService.isRunning()) {
      return res.status(409).json({ error: 'A backup is already running' });
    }
    // Fire and respond — runBackup records success/failure itself
    backupService
      .runBackup(req.user?.email || 'admin')
      .catch((err) => console.error('[admin] background backup error:', err.message));
    console.log(`[admin] Backup triggered by ${req.user?.email}`);
    res.status(202).json({ started: true });
  } catch (error) {
    console.error('[admin] runBackupNow error:', error.message);
    res.status(500).json({ error: 'Failed to start backup' });
  }
};

module.exports = { getBackups, runBackupNow };
