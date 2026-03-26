const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: String,
  seq: Number,
});

module.exports = mongoose.model('Counter', counterSchema);
