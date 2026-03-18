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

module.exports = { generateAccessToken, generateRefreshToken, generateTokens };
