// Muat .env di sini agar kita bisa mengakses SITE_URL
require('dotenv').config(); 

const SITE_URL = process.env.SITE_URL || `http://localhost:3000`;
const UPLOAD_WEB_PATH_NAME = 'images';

// --- Fungsi Slugify ---
function slugify(text) {
  if (typeof text !== 'string' || !text) {
    return ''; // Kembalikan string kosong jika input tidak valid
  }
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')       // Ganti spasi dengan -
    .replace(/[^\w\-]+/g, '')   // Hapus semua karakter non-word
    .replace(/\-\-+/g, '-');      // Ganti -- ganda dengan - tunggal
}

// --- Fungsi Format Angka ---
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1
});

function formatCompactNumber(num) {
  if (num === undefined || num === null) {
    return '0'; // Default jika data tidak ada
  }
  try {
    return compactFormatter.format(num);
  } catch (e) {
    return num.toString(); // Fallback jika ada error
  }
}

// --- Fungsi Encode URL Gambar ---
const encodeAnimeSlugs = (animes) => {
  if (!animes || !Array.isArray(animes)) return [];
  return animes.map(anime => {
    if (!anime) return null;
    const encodedSlug = anime.pageSlug ? encodeURIComponent(anime.pageSlug) : null;
    let imageUrl = anime.imageUrl || '/images/default.jpg';
    if (imageUrl.startsWith('http')) {
      // Biarkan
    } else if (imageUrl.startsWith(`/${UPLOAD_WEB_PATH_NAME}`)) {
      imageUrl = SITE_URL + imageUrl;
    } else {
      imageUrl = SITE_URL + imageUrl;
    }
    return { ...anime, pageSlug: encodedSlug, imageUrl: imageUrl };
  }).filter(Boolean);
};

// Ekspor semua fungsi
module.exports = {
  slugify,
  formatCompactNumber,
  encodeAnimeSlugs
};