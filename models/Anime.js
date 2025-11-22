const mongoose = require('mongoose');

const animeSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  pageSlug: { 
    type: String, 
    unique: true, 
    required: true, 
    index: true 
  },
  imageUrl: {
    type: String,
    default: '/images/default.jpg'
  },
  synopsis: String,
  
  // --- PERBAIKAN: Struktur 'info' disesuaikan dengan server.js ---
  // Menggunakan sub-dokumen agar validasi lebih ketat & fleksibel
  info: {
    Alternatif: { type: String, default: '' },
    Type: { type: String, default: '' },
    Episode: { type: String, default: '' },
    Status: { type: String, default: 'Unknown' },
    Produser: { type: String, default: '' },
    Released: { type: String, default: '' },
    
    // Field Legacy (Tetap disimpan agar data lama tidak rusak)
    Studio: { type: String },
    Producers: { type: String }
  },

  genres: [String],
  
  episodes: [{
    title: String, // Judul Episode Lengkap
    url: String,   // Slug Episode
    date: String,
  }],

  // Field Legacy untuk judul alternatif (Opsional)
  alternativeTitle: String,

  characters: [{
    name: String,
    role: String,
    imageUrl: String
  }],

  viewCount: {
    type: Number,
    default: 0, 
    index: true 
  }
}, { timestamps: true });

module.exports = mongoose.model('Anime', animeSchema);
