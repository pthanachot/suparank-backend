const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const Session = require('../models/Session');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Protect routes - verifies JWT and attaches req.user
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const token = authHeader.split(' ')[1];

  // QA B32: six routers are mounted on /api/workspace and each runs
  // router.use(authenticateToken), so one request was authenticated six
  // times (12 user reads, 6 session reads, 6 writes, all sequential). The
  // first successful pass records which token it verified on this request;
  // later passes for the SAME token reuse req.user. A different token on the
  // same request (never happens in practice) is verified from scratch.
  if (req._authenticatedToken === token && req.user) return next();

  // Pin the algorithm to mitigate algorithm-confusion attacks
  // (e.g. forged tokens with alg: none) — never rely on the token's own header.
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, { algorithms: ['HS256'] }, async (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    try {
      // QA B32: the user and session reads are independent, so they run in
      // parallel (one database round trip instead of two on every request).
      // The checks below are applied in the same order as before.
      const [user, session] = await Promise.all([
        User.findById(decoded.userId),
        decoded.sessionId ? Session.findById(decoded.sessionId) : Promise.resolve(null),
      ]);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
        return res.status(401).json({ error: 'Token revoked, please login again' });
      }

      if (user.status !== 'active' && user.status !== 'pending_deletion') {
        return res.status(401).json({ error: 'Account is not active' });
      }

      // Check session is still active (not revoked)
      if (decoded.sessionId) {
        if (!session || session.status === 'ended') {
          return res.status(401).json({ error: 'Session has been revoked' });
        }
      }

      req.user = {
        userId: new mongoose.Types.ObjectId(decoded.userId),
        email: decoded.email,
        roles: decoded.roles,
        sessionId: decoded.sessionId,
        tokenVersion: decoded.tokenVersion,
        // Present ONLY on an impersonation token (Phase 19B). Propagated so
        // validateAdmin can hard-block impersonated sessions from admin routes.
        impersonatedBy: decoded.impersonatedBy || null,
      };

      // Fire-and-forget last active update (throttled in the model)
      user.updateLastActive().catch(() => {});

      req._authenticatedToken = token;
      next();
    } catch (dbError) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  });
};

/**
 * Optional auth - doesn't fail if no token
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, { algorithms: ['HS256'] }, async (err, decoded) => {
    if (err) {
      req.user = null;
      return next();
    }

    try {
      const user = await User.findById(decoded.userId);
      if (!user || (user.status !== 'active' && user.status !== 'pending_deletion')) {
        req.user = null;
        return next();
      }

      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
        req.user = null;
        return next();
      }

      req.user = {
        ...decoded,
        userId: new mongoose.Types.ObjectId(decoded.userId),
      };
      next();
    } catch {
      req.user = null;
      next();
    }
  });
};

/**
 * Verify Google ID token
 */
const verifyGoogleToken = async (idToken) => {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return {
    name: payload.name,
    email: payload.email,
    picture: payload.picture,
    googleId: payload.sub,
  };
};

module.exports = { authenticateToken, optionalAuth, verifyGoogleToken };
