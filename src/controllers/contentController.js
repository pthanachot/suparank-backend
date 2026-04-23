const Workspace = require('../models/Workspace');
const Content = require('../models/Content');
const { runAnalysis } = require('./analysisController');
const imageStorage = require('../services/imageStorage');

// Middleware-style: resolve workspace from :workspaceNumber param
async function resolveWorkspace(req, res) {
  const { workspaceNumber } = req.params;
  const workspace = await Workspace.findOne({
    workspaceNumber: Number(workspaceNumber),
    $or: [
      { userId: req.user.userId },
      { 'members.userId': req.user.userId },
    ],
  });
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  return workspace;
}

// ─── LIST CONTENTS (summaries) ─────────────────────────────────

const listContents = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { status, folder } = req.query;
    const contents = await Content.findSummariesByWorkspace(workspace._id, { status, folder });
    res.json({ contents });
  } catch (err) {
    console.error('listContents error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contents' });
  }
};

// ─── GET SINGLE CONTENT (by contentNumber) ─────────────────────

const getContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findByNumber(workspace._id, req.params.contentNumber);
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    // Migrate old public B2 URLs to new /api/b2-image/ path format
    if (content.blocks && Array.isArray(content.blocks)) {
      for (const block of content.blocks) {
        if (block.type === 'img' && block.src) {
          const migrated = imageStorage.migratePublicUrl(block.src);
          if (migrated) block.src = migrated;
        }
      }
    }

    res.json({ content });
  } catch (err) {
    console.error('getContent error:', err.message);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
};

// ─── CREATE CONTENT ────────────────────────────────────────────

const createContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const contentNumber = await Content.getNextContentNumber();
    const { title, slug, description, blocks, targetKeywords, country, device, score, wordCount, status, folder, platform, versions } = req.body;

    const content = await Content.create({
      userId: req.user.userId,
      workspaceId: workspace._id,
      contentNumber,
      title,
      slug,
      description,
      blocks: blocks || [],
      targetKeywords: targetKeywords || [],
      country,
      device,
      score,
      wordCount,
      status,
      folder,
      platform,
      versions: versions || [],
    });

    // Auto-trigger analysis if keywords are provided
    if (content.targetKeywords && content.targetKeywords.length > 0) {
      await Content.findByIdAndUpdate(content._id, { $set: { analysisStatus: 'pending' } });
      runAnalysis(content._id);
    }

    res.status(201).json({ content });
  } catch (err) {
    console.error('createContent error:', err.message);
    res.status(500).json({ error: 'Failed to create content' });
  }
};

// ─── UPDATE CONTENT ────────────────────────────────────────────

const updateContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const allowedFields = [
      'title', 'slug', 'description', 'blocks', 'targetKeywords',
      'country', 'device', 'score', 'wordCount', 'status', 'folder', 'platform',
      'versions', 'publishedAt', 'scheduledAt',
      'contentType', 'contentContext', 'targetWordCount', 'writingMode',
      'styleReferenceContentNumber',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Upload any remaining base64/temp-URL images to B2 before saving
    if (updates.blocks && Array.isArray(updates.blocks) && imageStorage.isEnabled()) {
      for (const block of updates.blocks) {
        if (block.type !== 'img' || !block.src) continue;
        try {
          if (block.src.startsWith('data:image/')) {
            block.src = await imageStorage.uploadFromDataUri(
              block.src, workspace._id.toString(), req.params.contentNumber,
            );
          } else if (block.src.includes('/api/images/img_')) {
            block.src = await imageStorage.uploadFromUrl(
              block.src, workspace._id.toString(), req.params.contentNumber,
            );
          }
        } catch (err) {
          console.error(`B2 upload failed for block ${block.id} (non-fatal):`, err.message);
        }
      }
    }

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber) },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }

    res.json({ content });
  } catch (err) {
    console.error('updateContent error:', err.message);
    res.status(500).json({ error: 'Failed to update content' });
  }
};

// ─── DELETE CONTENT ────────────────────────────────────────────

const deleteContent = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findOneAndDelete({
      workspaceId: workspace._id,
      contentNumber: Number(req.params.contentNumber),
    });
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    res.json({ message: 'Content deleted' });
  } catch (err) {
    console.error('deleteContent error:', err.message);
    res.status(500).json({ error: 'Failed to delete content' });
  }
};

// ─── ADD COMMENT ──────────────────────────────────────────────

const User = require('../models/User');

const addComment = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { blockId, selectedText, text } = req.body;
    if (!blockId || !text) return res.status(400).json({ error: 'blockId and text are required' });

    const user = await User.findById(req.user.userId).select('email profile.name').lean();
    const comment = {
      id: 'c' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      blockId,
      selectedText: selectedText || undefined,
      text,
      authorEmail: user?.email || req.user.email,
      authorName: user?.profile?.name || undefined,
      createdAt: Date.now(),
    };

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber) },
      { $push: { comments: comment } },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    res.json({ comment });
  } catch (err) {
    console.error('addComment error:', err.message);
    res.status(500).json({ error: 'Failed to add comment' });
  }
};

// ─── UPDATE COMMENT (resolve / edit) ──────────────────────────

const updateComment = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const { commentId } = req.params;
    const update = {};
    if (req.body.text !== undefined) update['comments.$.text'] = req.body.text;
    if (req.body.resolvedAt !== undefined) update['comments.$.resolvedAt'] = req.body.resolvedAt;

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber), 'comments.id': commentId },
      { $set: update },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content or comment not found' });

    const updated = content.comments.find(c => c.id === commentId);
    res.json({ comment: updated });
  } catch (err) {
    console.error('updateComment error:', err.message);
    res.status(500).json({ error: 'Failed to update comment' });
  }
};

// ─── DELETE COMMENT ───────────────────────────────────────────

const deleteComment = async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req, res);
    if (!workspace) return;

    const content = await Content.findOneAndUpdate(
      { workspaceId: workspace._id, contentNumber: Number(req.params.contentNumber) },
      { $pull: { comments: { id: req.params.commentId } } },
      { new: true }
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    res.json({ message: 'Comment deleted' });
  } catch (err) {
    console.error('deleteComment error:', err.message);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

module.exports = { listContents, getContent, createContent, updateContent, deleteContent, addComment, updateComment, deleteComment };
