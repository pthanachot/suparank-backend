const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    displayName: { type: String, required: true },
    description: { type: String, default: '' },
    level: {
      type: Number,
      required: true,
      // 0 = owner (most power), 1 = admin, 2 = editor, 3 = viewer (least power)
    },
    isSystem: {
      type: Boolean,
      default: true,
      // system roles can't be deleted via API
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);
