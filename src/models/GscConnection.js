const mongoose = require('mongoose');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

const DEV_DEFAULT_KEY = '053d74ffb9ab132bd47b062d2ef8cda040aedd73c9f824b21be4f499e1663fa4';

function getEncryptionKey() {
  const key = process.env.GSC_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('GSC_TOKEN_ENCRYPTION_KEY env var is required in production');
    }
    console.warn('[gsc] GSC_TOKEN_ENCRYPTION_KEY not set — using dev default (NOT safe for production)');
    return Buffer.from(DEV_DEFAULT_KEY, 'hex');
  }
  return Buffer.from(key, 'hex');
}

function encrypt(text) {
  if (!text) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  // Store as iv:tag:ciphertext
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

function decrypt(data) {
  if (!data) return null;
  const key = getEncryptionKey();
  const parts = data.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

const gscConnectionSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      unique: true,
    },
    googleEmail: { type: String, default: null },
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    tokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    connectedAt: { type: Date, default: null },
    lastRefreshedAt: { type: Date, default: null },
    persistData: { type: Boolean, default: true },
  },
  { timestamps: true }
);

gscConnectionSchema.index({ organizationId: 1 }, { unique: true });

module.exports = mongoose.model('GscConnection', gscConnectionSchema);
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;
