const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  pageUrl: { 
    type: String, 
    required: true 
  },
  message: { 
    type: String, 
    required: true 
  },
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true // Opsional, jika user login
  },
  status: { 
    type: String, 
    enum: ['Baru', 'Dilihat', 'Selesai'], 
    default: 'Baru' 
  },
}, { timestamps: true }); // Otomatis menambah createdAt dan updatedAt

module.exports = mongoose.model('Report', reportSchema);