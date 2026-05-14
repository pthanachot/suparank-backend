/**
 * Internal skills bridge — gives the frontend (via Express) a server-
 * authoritative list of skills loaded by the Go writing-engine. Mounted
 * at /api/internal/skills in src/index.js; internalAuth-gated so this is
 * server-to-server only (frontend goes through a user-facing wrapper).
 *
 * The Go writing-engine owns the skill registry (loaded from disk on
 * boot). Express proxies the list here so future work — workspace-
 * scoped skill toggles, user-authored skills in Mongo, etc. — can layer
 * on without changing the writing-engine.
 */

const express = require('express');
const router = express.Router();
const { internalAuth } = require('../middleware/internalAuth');
const writingEngine = require('../services/writingEngine');

router.use(internalAuth);

router.get('/', async (req, res) => {
  try {
    const skills = await writingEngine.listSkills();
    res.json({ skills: Array.isArray(skills) ? skills : [] });
  } catch (err) {
    console.error('[internal/skills] proxy failed:', err.message);
    res.status(502).json({ error: 'writing-engine unreachable', detail: err.message });
  }
});

module.exports = router;
