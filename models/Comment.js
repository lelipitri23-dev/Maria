// File: models/Comment.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const commentSchema = new Schema({
  episode: {
    type: Schema.Types.ObjectId,
    ref: 'Episode',
    required: true,
    index: true 
  },
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User', 
    required: true
  },
  parent: {
    type: Schema.Types.ObjectId,
    ref: 'Comment',
    default: null,
    index: true
  },
  content: {
    type: String,
    required: [true, 'Komentar tidak boleh kosong'],
    trim: true,
    maxlength: 2000
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Comment', commentSchema);