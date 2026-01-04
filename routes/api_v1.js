const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// --- IMPORT MODELS ---
// Pastikan path '../models/...' sesuai dengan struktur folder kamu
const Anime = require('../models/Anime');
const Episode = require('../models/Episode');
const User = require('../models/User');
const Comment = require('../models/Comment');
const Bookmark = require('../models/Bookmark');
const Report = require('../models/Report');

// --- IMPORT HELPERS ---
const { encodeAnimeSlugs } = require('../utils/helpers');

// --- KONFIGURASI ---
// SANGAT PENTING: Ganti secret ini dengan string acak yang panjang & aman di production (.env)
const JWT_SECRET = process.env.JWT_SECRET || 'rahasia_negara_wibu_super_aman_12345'; 
const ITEMS_PER_PAGE = 20;

// ==========================================================
// == MIDDLEWARE (KEAMANAN) ==
// ==========================================================

// Middleware untuk memverifikasi Token User (Login Check)
const verifyToken = (req, res, next) => {
  const tokenHeader = req.headers['authorization'];
  if (!tokenHeader) return res.status(403).json({ error: 'Akses ditolak. Token diperlukan.' });

  const token = tokenHeader.split(' ')[1]; // Format header: "Bearer <token>"
  if (!token) return res.status(403).json({ error: 'Format token salah.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token tidak valid atau kadaluarsa.' });
    req.userId = decoded.id; // Simpan ID user ke request agar bisa dipakai di route selanjutnya
    next();
  });
};

// ==========================================================
// == AUTHENTICATION ROUTES (LOGIN/REGISTER) ==
// ==========================================================

// 1. Register User Baru
router.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validasi sederhana
    if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter.' });

    // Cek duplikat username
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: 'Username sudah digunakan.' });

    // Buat user baru (Password di-hash otomatis di User.js pre-save hook)
    const newUser = new User({ username, password });
    await newUser.save();

    res.status(201).json({ message: 'Registrasi berhasil, silakan login.' });
  } catch (error) {
    res.status(500).json({ error: 'Gagal registrasi: ' + error.message });
  }
});

// 2. Login User
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Cari user
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    // Cek password (menggunakan method di User.js)
    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ error: 'Password salah.' });

    // Buat Token JWT
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login berhasil',
      token,
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        avatar: `https://ui-avatars.com/api/?name=${user.username}&background=random` // Avatar default
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Gagal login.' });
  }
});

// 3. Get User Profile (Protected)
router.get('/auth/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password'); // Jangan kirim password
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });
    
    // Hitung statistik user (opsional)
    const commentCount = await Comment.countDocuments({ user: req.userId });
    
    res.json({ 
        ...user.toObject(), 
        commentCount,
        avatar: `https://ui-avatars.com/api/?name=${user.username}&background=random`
    });
  } catch (error) {
    res.status(500).json({ error: 'Gagal memuat profil.' });
  }
});

// ==========================================================
// == HOME & CONTENT ROUTES ==
// ==========================================================

// 4. Home Page (Lengkap: Latest, Episode, Ongoing, Ended)
router.get('/home', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * ITEMS_PER_PAGE;

    // --- Query Definitions ---
    // A. Anime Ongoing (Sedang Tayang)
    const ongoingQuery = Anime.find({ "info.Status": "Ongoing" })
      .sort({ updatedAt: -1 })
      .limit(10)
      .select('pageSlug imageUrl title info.Type info.Rating info.Status')
      .lean();

    // B. Anime Ended (Tamat/Completed)
    const endedQuery = Anime.find({ "info.Status": "Completed" }) // Sesuaikan value DB ("Completed"/"Ended"/"Tamat")
      .sort({ updatedAt: -1 })
      .limit(10)
      .select('pageSlug imageUrl title info.Type info.Rating info.Status')
      .lean();

    // C. Latest Series (Campuran update terbaru)
    const latestQuery = Anime.find({})
      .sort({ createdAt: -1 })
      .limit(7)
      .select('pageSlug imageUrl title info.Type info.Rating info.Status')
      .lean();

    // D. Latest Episodes
    const episodesQuery = Episode.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(18)
      .lean();

    // --- Execute All Queries ---
    const [latestSeries, episodes, totalCount, ongoingSeries, endedSeries] = await Promise.all([
      latestQuery,
      episodesQuery,
      Episode.countDocuments({}),
      ongoingQuery,
      endedQuery 
    ]);

    // --- Encoding URLs (Helper) ---
    const encodedLatest = encodeAnimeSlugs(latestSeries);
    const encodedOngoing = encodeAnimeSlugs(ongoingSeries);
    const encodedEnded = encodeAnimeSlugs(endedSeries);

    // --- Formatting Episodes ---
    const formattedEpisodes = episodes.map(ep => {
       const [encodedEp] = encodeAnimeSlugs([{ imageUrl: ep.animeImageUrl || '/images/default.jpg' }]);
       return {
         watchUrl: `/anime${ep.episodeSlug}`,
         title: ep.title,
         imageUrl: encodedEp.imageUrl,
         episodeSlug: ep.episodeSlug,
         duration: ep.duration ? ep.duration.replace(/PT|H|M|S/g, ':').replace(/:$/, '') : '??:??',
         createdAt: ep.createdAt
       };
    });

    // --- Response ---
    res.json({
      latestSeries: encodedLatest,
      ongoingSeries: encodedOngoing,
      endedSeries: encodedEnded,
      episodes: formattedEpisodes,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE),
        totalEpisodes: totalCount
      }
    });

  } catch (error) {
    console.error("API Home Error:", error);
    res.status(500).json({ error: 'Gagal memuat homepage.' });
  }
});

// 5. Detail Anime
router.get('/anime/:slug', async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const anime = await Anime.findOne({ pageSlug }).lean();
    if (!anime) return res.status(404).json({ error: 'Anime tidak ditemukan.' });

    // Cek apakah user sudah bookmark (jika ada token di header)
    let isBookmarked = false;
    const tokenHeader = req.headers['authorization'];
    if (tokenHeader) {
      try {
        const token = tokenHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const check = await Bookmark.findOne({ userId: decoded.id, animeRef: anime._id });
        if (check) isBookmarked = true;
      } catch (e) {
        // Token invalid/expired, abaikan error, anggap belum bookmark
      }
    }

    const [encodedAnime] = encodeAnimeSlugs([anime]);
    res.json({ ...encodedAnime, isBookmarked });
  } catch (error) {
    console.error(`API Anime Detail Error (${req.params.slug}):`, error);
    res.status(500).json({ error: 'Gagal memuat data anime.' });
  }
});

// 6. Detail Episode (Streaming)
router.get('/episode/:animeId/:episodeNum', async (req, res) => {
  try {
    const { animeId, episodeNum } = req.params;
    const episodeSlug = `/${animeId}/${episodeNum}`;
    
    const episode = await Episode.findOne({ episodeSlug }).lean();
    if (!episode) return res.status(404).json({ error: 'Episode tidak ditemukan.' });

    const [encodedImg] = encodeAnimeSlugs([{ imageUrl: episode.thumbnailUrl }]);

    res.json({
      id: episode._id,
      title: episode.title,
      animeTitle: episode.animeTitle,
      animeSlug: episode.animeSlug,
      thumbnailUrl: encodedImg.imageUrl,
      // Filter stream 'bonus' yang mungkin tidak diinginkan
      streams: episode.streaming ? episode.streaming.filter(s => s.name.toLowerCase() !== 'bonus') : [],
      downloads: episode.downloads || []
    });
  } catch (error) {
    console.error(`API Watch Episode Error:`, error);
    res.status(500).json({ error: 'Gagal memuat data episode.' });
  }
});

// 7. Jadwal Tayang (Schedule)
router.get('/schedule', async (req, res) => {
  try {
    // Mengambil semua anime Ongoing
    const ongoingAnime = await Anime.find({ "info.Status": "Ongoing" })
      .select('title pageSlug imageUrl info.Released updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    const encoded = encodeAnimeSlugs(ongoingAnime);
    
    res.json({ 
      title: "Jadwal Tayang (Ongoing)",
      data: encoded 
    });
  } catch (error) {
    res.status(500).json({ error: 'Gagal load jadwal.' });
  }
});

// 8. Search / Pencarian
router.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    const page = parseInt(req.query.page) || 1;
    const limit = 24;
    const skip = (page - 1) * limit;

    if (!query) return res.json({ results: [] });
    
    const [results, totalCount] = await Promise.all([
        Anime.find({ title: { $regex: query, $options: 'i' } })
          .select('title pageSlug imageUrl info.Rating info.Status')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Anime.countDocuments({ title: { $regex: query, $options: 'i' } })
    ]);
      
    res.json({ 
        pagination: { currentPage: page, totalPages: Math.ceil(totalCount / limit) },
        results: encodeAnimeSlugs(results) 
    });
  } catch (error) {
    res.status(500).json({ error: 'Search error.' });
  }
});

// ==========================================================
// == USER INTERACTION ROUTES ==
// ==========================================================

// 9. Get Komentar Episode
router.get('/comments/:episodeId', async (req, res) => {
  try {
    // Populate 'user' mengambil username & role dari User collection berdasarkan user ID di comment
    const comments = await Comment.find({ episode: req.params.episodeId })
      .populate('user', 'username role') 
      .sort({ createdAt: -1 })
      .lean();

    res.json(comments);
  } catch (error) {
    res.status(500).json({ error: 'Gagal load komentar.' });
  }
});

// 10. Post Komentar (Protected: Butuh Login)
router.post('/comments', verifyToken, async (req, res) => {
  try {
    const { episodeId, content } = req.body;
    
    if (!content) return res.status(400).json({ error: 'Komentar tidak boleh kosong.' });

    const newComment = new Comment({
      episode: episodeId,
      user: req.userId, // ID dari middleware
      content: content
    });

    await newComment.save();
    
    // Return comment dengan data user agar frontend bisa langsung update UI
    const populated = await newComment.populate('user', 'username role');
    
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ error: 'Gagal kirim komentar.' });
  }
});

// 11. Toggle Bookmark / Favorite (Protected)
router.post('/bookmark', verifyToken, async (req, res) => {
  try {
    const { animeId } = req.body; // animeId adalah _id (MongoDB ObjectId) dari Anime
    
    // Cek apakah sudah ada di bookmark user ini
    const existing = await Bookmark.findOne({ userId: req.userId, animeRef: animeId });
    
    if (existing) {
      // Jika ada, HAPUS (Un-bookmark)
      await Bookmark.findByIdAndDelete(existing._id);
      return res.json({ status: 'removed', message: 'Dihapus dari Library' });
    } else {
      // Jika tidak ada, TAMBAH
      const newBookmark = new Bookmark({ userId: req.userId, animeRef: animeId });
      await newBookmark.save();
      return res.json({ status: 'added', message: 'Ditambahkan ke Library' });
    }
  } catch (error) {
    console.error("Bookmark Error:", error);
    res.status(500).json({ error: 'Gagal memproses bookmark.' });
  }
});

// 12. Get User Library/History (Protected)
router.get('/library', verifyToken, async (req, res) => {
  try {
    const bookmarks = await Bookmark.find({ userId: req.userId })
      .populate('animeRef', 'title pageSlug imageUrl info.Rating info.Status') // Ambil info anime yang relevan
      .sort({ createdAt: -1 });

    // Bersihkan hasil (ambil animeRef-nya saja)
    const cleanList = bookmarks
        .filter(b => b.animeRef != null) // Filter jika ada anime yang sudah dihapus dari DB
        .map(b => b.animeRef);

    const encoded = encodeAnimeSlugs(cleanList);
    
    res.json(encoded);
  } catch (error) {
    res.status(500).json({ error: 'Gagal load library.' });
  }
});

// 13. Kirim Report (Protected)
router.post('/report', verifyToken, async (req, res) => {
  try {
    const { pageUrl, message } = req.body;
    const report = new Report({
      pageUrl,
      message,
      user: req.userId
    });
    await report.save();
    res.json({ message: 'Laporan terkirim. Terima kasih!' });
  } catch (error) {
    res.status(500).json({ error: 'Gagal kirim laporan.' });
  }
});

// ==========================================================
// == TAXONOMY ROUTES (GENRE, STATUS, DLL) ==
// ==========================================================

// Helper Function
const handleTaxonomyRequest = async (req, res, filter, title) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 24; 
        const skip = (page - 1) * limit;
        const [results, totalCount] = await Promise.all([
             Anime.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('pageSlug title imageUrl info.Status info.Rating')
                .lean(),
             Anime.countDocuments(filter)
        ]);
        
        res.json({
            title: title,
            pagination: { currentPage: page, totalPages: Math.ceil(totalCount / limit) },
            results: encodeAnimeSlugs(results)
        });
    } catch (e) { 
        console.error("Taxonomy Error:", e);
        res.status(500).json({error: "Gagal mengambil data kategori."}); 
    }
};

router.get('/genre/:slug', (req, res) => {
    // Contoh slug: "action", "slice-of-life" -> di DB mungkin "Action", "Slice of Life"
    const g = req.params.slug.replace(/-/g, ' '); 
    // Menggunakan regex agar case-insensitive
    handleTaxonomyRequest(req, res, { genres: { $regex: g, $options: 'i'} }, `Genre: ${g}`);
});

router.get('/status/:slug', (req, res) => {
    const s = req.params.slug.replace(/-/g, ' ');
    handleTaxonomyRequest(req, res, { "info.Status": { $regex: s, $options: 'i'} }, `Status: ${s}`);
});

router.get('/type/:slug', (req, res) => {
    const t = req.params.slug;
    handleTaxonomyRequest(req, res, { "info.Type": { $regex: t, $options: 'i'} }, `Type: ${t}`);
});

router.get('/tahun/:year', (req, res) => {
    const year = req.params.year;
    handleTaxonomyRequest(req, res, { "info.Released": { $regex: year, $options: 'i'} }, `Tahun: ${year}`);
});

module.exports = router;
