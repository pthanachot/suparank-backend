const mongoose = require('mongoose');
const Content = require('../models/Content');

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

// ─── LIST CONTENTS (summaries) ─────────────────────────────────

const listContents = async (req, res) => {
  try {
    const { status, folder } = req.query;
    const contents = await Content.findSummariesByUser(req.user.userId, { status, folder });
    res.json({ contents });
  } catch (err) {
    console.error('listContents error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contents' });
  }
};

// ─── GET SINGLE CONTENT (full blocks + versions) ──────────────

const getContent = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid content ID' });
    }
    const content = await Content.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
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
    const { title, slug, description, blocks, targetKeyword, score, wordCount, status, folder, platform, versions } = req.body;

    const content = await Content.create({
      userId: req.user.userId,
      title,
      slug,
      description,
      blocks: blocks || [],
      targetKeyword,
      score,
      wordCount,
      status,
      folder,
      platform,
      versions: versions || [],
    });

    res.status(201).json({ content });
  } catch (err) {
    console.error('createContent error:', err.message);
    res.status(500).json({ error: 'Failed to create content' });
  }
};

// ─── UPDATE CONTENT ────────────────────────────────────────────

const updateContent = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid content ID' });
    }
    const allowedFields = [
      'title', 'slug', 'description', 'blocks', 'targetKeyword',
      'score', 'wordCount', 'status', 'folder', 'platform',
      'versions', 'publishedAt', 'scheduledAt',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const content = await Content.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId },
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid content ID' });
    }
    const content = await Content.findOneAndDelete({ _id: req.params.id, userId: req.user.userId });
    if (!content) {
      return res.status(404).json({ error: 'Content not found' });
    }
    res.json({ message: 'Content deleted' });
  } catch (err) {
    console.error('deleteContent error:', err.message);
    res.status(500).json({ error: 'Failed to delete content' });
  }
};

module.exports = { listContents, getContent, createContent, updateContent, deleteContent };
