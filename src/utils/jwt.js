const jwt = require('jsonwebtoken');

/**
 * Generate access token (3 day expiry)
 */
const generateAccessToken = (user, sessionId) => {
  return jwt.sign(
    {
      userId: user._id,
      email: user.email,
      roles: user.roles,
      sessionId,
      tokenVersion: user.tokenVersion,
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: '3d' }
  );
};

/**
 * Generate refresh token (30 day expiry)
 */
const generateRefreshToken = (user, sessionId) => {
  return jwt.sign(
    {
      userId: user._id,
      sessionId,
      tokenVersion: user.tokenVersion,
    },
    process.env.REFRESH_TOKEN_SECRET,
    {
      expiresIn: '30d',
      audience: process.env.JWT_AUDIENCE || 'SupaRank',
      issuer: process.env.JWT_ISSUER || 'SupaRank',
    }
  );
};

/**
 * Generate both tokens
 */
const generateTokens = (user, sessionId) => {
  return {
    accessToken: generateAccessToken(user, sessionId),
    refreshToken: generateRefreshToken(user, sessionId),
  };
};

/**
 * Generate a short-lived IMPERSONATION access token (Phase 19B).
 *
 * Carries the TARGET user's identity plus an `impersonatedBy` claim naming the
 * real admin. Deliberately:
 *   - short expiry (default 30m, ttlMinutes-configurable) — a support session,
 *     not a login;
 *   - NO refresh token is ever issued for it (there is no generateImpersonation-
 *     RefreshToken), so it cannot be silently extended;
 *   - same secret/HS256 as a normal access token, so authenticateToken verifies
 *     it unchanged — the `impersonatedBy` claim is what downstream guards key on
 *     (validateAdmin refuses any impersonated session).
 */
const generateImpersonationToken = (targetUser, sessionId, impersonatorId, ttlMinutes = 30) => {
  return jwt.sign(
    {
      userId: targetUser._id,
      email: targetUser.email,
      roles: targetUser.roles,
      sessionId,
      tokenVersion: targetUser.tokenVersion,
      impersonatedBy: String(impersonatorId),
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: `${ttlMinutes}m` }
  );
};

module.exports = { generateAccessToken, generateRefreshToken, generateTokens, generateImpersonationToken };
