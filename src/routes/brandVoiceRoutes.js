const express = require('express');
const multer = require('multer');
const router = express.Router();
const brandVoiceController = require('../controllers/brandVoiceController');
const { authenticateToken } = require('../middleware/auth');

// Multer config: memory storage, 10MB limit, PDF/DOCX/TXT only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, and TXT files are allowed'));
    }
  },
});

// Multer config for avatar images: 5MB limit, common image types
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
    }
  },
});

// All routes require authentication
router.use(authenticateToken);

const { resolveWorkspaceWithRole: rwr, requirePermission: rp } = require('../middleware/permissions');

// Brand voice
router.get('/:workspaceNumber/brand-voice', rwr, rp('brandVoice', 'read'), brandVoiceController.getBrandVoice);
router.put('/:workspaceNumber/brand-voice', rwr, rp('brandVoice', 'manage'), brandVoiceController.saveBrandVoice);
router.post('/:workspaceNumber/brand-voice/test', rwr, rp('brandVoice', 'manage'), brandVoiceController.testBrandVoice);
router.get('/:workspaceNumber/brand-voice/rate-limit', rwr, rp('brandVoice', 'read'), brandVoiceController.getTestRateLimit);

// Avatars
router.get('/:workspaceNumber/brand-voice/avatars', rwr, rp('brandVoice', 'read'), brandVoiceController.listAvatars);
router.get('/:workspaceNumber/brand-voice/avatars/:avatarId', rwr, rp('brandVoice', 'read'), brandVoiceController.getAvatar);
router.post('/:workspaceNumber/brand-voice/avatars', rwr, rp('brandVoice', 'manage'), brandVoiceController.createAvatar);
router.put('/:workspaceNumber/brand-voice/avatars/:avatarId', rwr, rp('brandVoice', 'manage'), brandVoiceController.updateAvatar);
router.delete('/:workspaceNumber/brand-voice/avatars/:avatarId', rwr, rp('brandVoice', 'manage'), brandVoiceController.deleteAvatar);
router.patch('/:workspaceNumber/brand-voice/avatars/:avatarId/toggle', rwr, rp('brandVoice', 'manage'), brandVoiceController.toggleAvatar);
router.post('/:workspaceNumber/brand-voice/avatars/:avatarId/test', rwr, rp('brandVoice', 'manage'), brandVoiceController.testAvatar);

// Google Doc URL import
router.post('/:workspaceNumber/brand-voice/avatars/:avatarId/import-url', rwr, rp('brandVoice', 'manage'), brandVoiceController.importGoogleDoc);

// Avatar file uploads (with multer error handling)
router.post(
  '/:workspaceNumber/brand-voice/avatars/:avatarId/upload',
  rwr,
  rp('brandVoice', 'manage'),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 10 MB.' });
        }
        return res.status(400).json({ error: err.message || 'File upload failed' });
      }
      next();
    });
  },
  brandVoiceController.uploadAvatarFile
);
router.delete(
  '/:workspaceNumber/brand-voice/avatars/:avatarId/upload/:uploadId',
  rwr,
  rp('brandVoice', 'manage'),
  brandVoiceController.deleteAvatarUpload
);

// Avatar image upload
router.post(
  '/:workspaceNumber/brand-voice/avatars/:avatarId/image',
  rwr,
  rp('brandVoice', 'manage'),
  (req, res, next) => {
    imageUpload.single('image')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Image too large. Maximum size is 5 MB.' });
        }
        return res.status(400).json({ error: err.message || 'Image upload failed' });
      }
      next();
    });
  },
  brandVoiceController.uploadAvatarImage
);
router.delete(
  '/:workspaceNumber/brand-voice/avatars/:avatarId/image',
  rwr,
  rp('brandVoice', 'manage'),
  brandVoiceController.deleteAvatarImage
);

module.exports = router;
