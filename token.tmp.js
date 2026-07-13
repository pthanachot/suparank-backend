/* eslint-disable */
require('dotenv').config({ path: '/Users/pthanachot/Desktop/react/suparank/backend/.env' });
const { generateAccessToken } = require('./src/utils/jwt');
// Real active owner of workspace 892144 (same fixture as the W5-b smoke).
// No sessionId → authenticateToken skips the Session lookup.
const user = { _id: '69c4b1ee2bf6c9f89e502690', email: 'thanachot.wor@gmail.com', roles: ['member'], tokenVersion: 0 };
process.stdout.write(generateAccessToken(user));
