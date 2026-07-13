/* eslint-disable */
// Threads Phase 1 smoke fixture: grant 50 dev credits to the owner org so the
// credit-gated agent/chat runs can execute. Dev DB only; removed after smoke.
require('dotenv').config({ path: '/Users/pthanachot/Desktop/react/suparank/backend/.env' });
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'suparank' });
  const creditService = require('./src/services/creditService');
  const r = await creditService.grantGeneralCredits('69febf3a64afc3234bd5c961', 50, 'Threads Phase 1 live-smoke grant (dev)');
  console.log('granted:', JSON.stringify(r && (r.balance ?? r)));
  const bal = await creditService.getBalance?.('69febf3a64afc3234bd5c961');
  console.log('balance now:', JSON.stringify(bal));
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
