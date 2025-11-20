// ===================================
// --- IMPORTS & INITIALIZATION ---
// ===================================
require('dotenv').config(); // Load .env file FIRST
const siteName = process.env.SITE_NAME || 'RajaHentai'; // Define siteName globally
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs'); // Diperlukan untuk menyimpan file unggahan
const multer = require('multer'); // Import multer
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');

// --- PERBAIKAN PERFORMA 1: Impor Middleware ---
const compression = require('compression');
const NodeCache = require('node-cache');

// --- BARU: Impor Helper & Rute ---
const { slugify, formatCompactNumber, encodeAnimeSlugs } = require('./utils/helpers');
const apiV1Routes = require('./routes/api_v1');
// const pageRoutes = require('./routes/pageRoutes'); // (Jika Anda memindahkan rute halaman)

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Import Models
const Anime = require('./models/Anime');
const Episode = require('./models/Episode');
const Bookmark = require('./models/Bookmark');
const User = require('./models/User');
const Comment = require('./models/Comment'); // <-- Pastikan Model Comment diimpor
const Report = require('./models/Report');
const { type } = require('os');

const app = express();

// --- PERBAIKAN PERFORMA 2: Inisialisasi Cache ---
// Cache untuk 1 jam (3600 detik) untuk query yang berat
const appCache = new NodeCache({ stdTTL: 3600 });


// --- DIHAPUS ---
// Fungsi slugify, formatCompactNumber, dan encodeAnimeSlugs
// telah dipindahkan ke utils/helpers.js
// ------------------------------

const storage = multer.memoryStorage();
// Filter untuk memastikan hanya gambar yang di-upload
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/webp' || file.mimetype === 'application/json') {
    cb(null, true); // Terima file
  } else {
    cb(new Error('Hanya file .jpg, .png, .webp, atau .json yang diizinkan!'), false); // Tolak file
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // Batas 5MB
});

// ===================================
// --- GLOBAL CONFIGURATION ---
// ===================================
const PORT = process.env.PORT || 3000;
const ITEMS_PER_PAGE = 20;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const DB_URI = process.env.DB_URI; 

// --- PERBAIKAN RENDER: Konfigurasi Persistent Disk ---
const UPLOAD_WEB_PATH_NAME = 'images';
const UPLOAD_DISK_PATH = process.env.RENDER_DISK_PATH || path.join(__dirname, 'public', UPLOAD_WEB_PATH_NAME);

// Pastikan direktori upload ada saat development lokal
if (!process.env.RENDER_DISK_PATH) {
  if (!fs.existsSync(UPLOAD_DISK_PATH)) {
    console.log(`Membuat direktori upload lokal di: ${UPLOAD_DISK_PATH}`);
    fs.mkdirSync(UPLOAD_DISK_PATH, { recursive: true });
  }
}
// --- AKHIR PERBAIKAN RENDER ---


// ===================================
// --- MIDDLEWARE ---
// ===================================

async function checkApiReferer(req, res, next) {
  try {
    const referer = req.headers.referer;
    const allowedHostname = new URL(SITE_URL).hostname;

    if (!referer) {
      return res.status(403).json({ error: 'Akses Ditolak (Direct Access)' });
    }

    const refererHostname = new URL(referer).hostname;
    
    if (refererHostname === allowedHostname) {
      next();
    } else {
      return res.status(403).json({ error: 'Akses Ditolak (Hotlinking)' });
    }
    
  } catch (error) {
    return res.status(403).json({ error: 'Akses Ditolak (Invalid Referer)' });
  }
}

app.use(compression());
app.use(express.static(path.join(__dirname, 'public'))); 
app.use(`/${UPLOAD_WEB_PATH_NAME}`, express.static(UPLOAD_DISK_PATH));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

// --- BARU: Jadikan variabel global untuk EJS ---
app.locals.slugify = slugify;
app.locals.formatCompactNumber = formatCompactNumber;
app.locals.siteName = siteName;
app.locals.SITE_URL = SITE_URL;

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_please_change',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: DB_URI,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60 // 14 hari
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production', 
    maxAge: 1000 * 60 * 60 * 24 * 14 // 14 hari
  }
}));

// Middleware untuk User
app.use((req, res, next) => {
  res.locals.user = req.session.userId ? {
    id: req.session.userId,
    username: req.session.username
  } : null;
  next();
});

// Middleware Cek Login
const isLoggedIn = (req, res, next) => {
  if (req.session && req.session.userId) {
    return next(); 
  } else {
    res.status(401).json({ error: 'Anda harus login untuk melakukan aksi ini' });
  }
};

// ===================================
// --- HELPER FUNCTIONS ---
// ===================================

// --- DIHAPUS ---
// Fungsi encodeAnimeSlugs telah dipindahkan ke utils/helpers.js

// ===================================
// --- ADMIN AUTH MIDDLEWARE ---
// ===================================
const isAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  } else {
    res.redirect('/admin/login');
  }
};

// ===================================
// --- ADMIN ROUTES ---
// ===================================

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin');
  }
  res.render('admin/login', {
    page: 'admin-login', pageTitle: `Admin Login - ${siteName}`, error: req.query.error,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', 
    // siteName dan SITE_URL sekarang global via app.locals
  });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (username === adminUser && password === adminPass) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=Invalid credentials');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Error destroying session:", err);
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});

// --- PERBAIKAN 2: Ambil semua data count ---
app.get('/admin', isAdmin, async (req, res) => { 
  try {
    const [totalAnime, totalEpisodes, totalUsers, totalComments] = await Promise.all([
      Anime.countDocuments(),
      Episode.countDocuments(),
      User.countDocuments(),
      Comment.countDocuments()
    ]);

    res.render('admin/dashboard', {
      page: 'admin-dashboard',
      pageTitle: `Admin Dashboard - ${siteName}`,
      pageDescription: 'Admin dashboard',
      pageImage: '',
      pageUrl: '',
      query: '',
      totalAnime: totalAnime,
      totalEpisodes: totalEpisodes,
      totalUsers: totalUsers,
      totalComments: totalComments
    });

  } catch (error) {
    console.error("Error loading admin dashboard stats:", error);
    res.status(500).send('Gagal memuat statistik dashboard.');
  }
});


// 1. Halaman untuk menampilkan UI Backup/Restore
app.get('/admin/backup', isAdmin, (req, res) => {
  try {
    res.render('admin/backup', {
      page: 'admin-backup',
      pageTitle: `Backup & Restore - ${siteName}`,
      pageDescription: 'Halaman admin untuk backup dan restore database.',
      pageImage: '',
      pageUrl: '',
      query: '',
    });
  } catch (error) {
    console.error("Error rendering backup page:", error);
    res.status(500).send('Error memuat halaman.');
  }
});


// 2. Rute untuk MENGEKSPOR (DOWNLOAD) data
app.get('/admin/backup/export', isAdmin, async (req, res) => {
  try {
    console.log("Memulai proses ekspor database (streaming)...");
    const fileName = `backup_${siteName.toLowerCase()}_${new Date().toISOString().split('T')[0]}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

    res.write(`{ "exportedAt": "${new Date().toISOString()}", "collections": {`);

    // Fungsi helper untuk stream koleksi
    const streamCollection = async (model, collectionName) => {
      res.write(`"${collectionName}": [`);
      const cursor = model.find().lean().cursor();
      let first = true;
      for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        if (!first) res.write(',');
        res.write(JSON.stringify(doc));
        first = false;
      }
      res.write(`]`);
    };

    // Streaming data
    await streamCollection(Anime, 'animes');
    res.write(',');
    await streamCollection(Episode, 'episodes');
    res.write(',');
    await streamCollection(Bookmark, 'bookmarks');
    res.write(',');
    await streamCollection(User, 'users');
    res.write(',');
    await streamCollection(Comment, 'comments'); // <-- Tambahkan Ekspor Komentar
    
    res.write(`} }`); // Tutup collections dan JSON utama
    res.end();
    console.log(`Ekspor streaming berhasil: ${fileName}`);

  } catch (error) {
    console.error("Gagal melakukan ekspor database:", error);
    res.status(500).send('Gagal mengekspor data: ' + error.message);
  }
});


// 3. Rute untuk MENGIMPOR (RESTORE) data
app.post('/admin/backup/import', isAdmin, upload.single('backupFile'), async (req, res) => {
  try {
    console.log("Memulai proses impor database...");
    if (!req.file) return res.status(400).send('Tidak ada file backup yang diupload.');
    if (req.file.mimetype !== 'application/json') return res.status(400).send('File harus berformat .json');

    const jsonString = req.file.buffer.toString('utf8');
    const backupData = JSON.parse(jsonString);

    if (!backupData.collections || !backupData.collections.animes || !backupData.collections.episodes) {
      return res.status(400).send('Format file backup tidak valid.');
    }

    const { animes, episodes, bookmarks, users, comments } = backupData.collections;

    console.log("PERINGATAN: Menghapus semua data lama...");
    await Promise.all([
      Anime.deleteMany({}),
      Episode.deleteMany({}),
      Bookmark.deleteMany({}),
      User.deleteMany({}), 
      Comment.deleteMany({}) // <-- Tambahkan Hapus Komentar
    ]);
    console.log("Data lama berhasil dihapus.");

    console.log(`Memasukkan data baru...`);
    await Promise.all([
      Anime.insertMany(animes),
      Episode.insertMany(episodes),
      (bookmarks && bookmarks.length > 0) ? Bookmark.insertMany(bookmarks) : Promise.resolve(),
      (users && users.length > 0) ? User.insertMany(users) : Promise.resolve(),
      (comments && comments.length > 0) ? Comment.insertMany(comments) : Promise.resolve() // <-- Tambahkan Impor Komentar
    ]);

    console.log("PROSES IMPOR DATABASE BERHASIL.");
    res.send(`
      <style>body { background-color: #222; color: #eee; font-family: sans-serif; padding: 20px; }</style>
      <h2>Impor Berhasil!</h2>
      <p>Database Anda telah berhasil dipulihkan.</p>
      <ul>
        <li>${animes ? animes.length : 0} data Anime diimpor.</li>
        <li>${episodes ? episodes.length : 0} data Episode diimpor.</li>
        <li>${bookmarks ? bookmarks.length : 0} data Bookmark diimpor.</li>
        <li>${users ? users.length : 0} data User diimpor.</li>
        <li>${comments ? comments.length : 0} data Komentar diimpor.</li>
      </ul>
      <a href="/admin" style="color: #87CEEB;">« Kembali ke Dasbor</a>
    `);

  } catch (error) {
    console.error("Gagal melakukan impor database:", error);
    res.status(500).send('Gagal mengimpor data: ' + error.message);
  }
});

// --- Admin Anime List ---
app.get('/admin/anime', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skipVal = (page - 1) * limit;
    const searchQuery = req.query.search || '';
    const query = {};
    if (searchQuery) {
      const regex = new RegExp(searchQuery, 'i');
      query.$or = [ { title: regex }, { pageSlug: regex } ];
    }
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ updatedAt: -1 }).skip(skipVal).limit(limit).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / limit);
    const baseUrl = searchQuery ? `/admin/anime?search=${encodeURIComponent(searchQuery)}` : '/admin/anime';
    res.render('admin/anime-list', {
      animes: animes,
      page: 'admin-anime-list',
      pageTitle: `Admin - Anime List (Hal ${page})`,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: baseUrl,
      searchQuery: searchQuery,
      pageDescription: '', pageImage: '', pageUrl: '', query: '', 
    });
  } catch (error) {
    console.error("Admin Anime List Error:", error);
    res.status(500).send('Error loading admin anime list.');
  }
});

// --- Rute Admin Anime Edit ---
app.get('/admin/anime/:slug/edit', isAdmin, async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const anime = await Anime.findOne({ pageSlug: pageSlug }).lean();
    if (!anime) return res.status(404).send('Anime not found.');
    res.render('admin/edit-anime', {
      anime: anime, page: 'admin-edit-anime', pageTitle: `Edit Anime: ${anime.title} - ${siteName}`,
      pageDescription: '', pageImage: '', pageUrl: '', query: '', 
    });
  } catch (error) { console.error(`Admin Edit Anime GET Error (${req.params.slug}):`, error); res.status(500).send('Error loading anime edit form.'); }
});

// Rute Hapus Anime
app.post('/admin/anime/:slug/delete', isAdmin, async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    console.log(`Mencoba menghapus anime: ${pageSlug}`);

    const animeToDelete = await Anime.findOne({ pageSlug: pageSlug }).lean();
    if (!animeToDelete) {
      console.warn(` > Peringatan: Anime ${pageSlug} tidak ditemukan.`);
      return res.status(404).send('Anime tidak ditemukan');
    }

    const deleteEpisodesResult = await Episode.deleteMany({ animeSlug: pageSlug });
    console.log(` > Menghapus ${deleteEpisodesResult.deletedCount} episode dari koleksi Episode.`);

    const deleteAnimeResult = await Anime.deleteOne({ pageSlug: pageSlug });
    console.log(` > Menghapus ${deleteAnimeResult.deletedCount} anime dari koleksi Anime.`);

    // Hapus juga komentar yang terkait dengan episode anime ini
    const episodeIds = animeToDelete.episodes.map(ep => ep._id); // Asumsi episode punya _id di array
    if (episodeIds && episodeIds.length > 0) {
      const deleteCommentsResult = await Comment.deleteMany({ episode: { $in: episodeIds } });
      console.log(` > Menghapus ${deleteCommentsResult.deletedCount} komentar terkait.`);
    }

    if (animeToDelete.imageUrl && animeToDelete.imageUrl.startsWith('/images/')) {
      try {
        const imagePath = path.join(UPLOAD_DISK_PATH, path.basename(animeToDelete.imageUrl));
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
          console.log(` > Berhasil menghapus file gambar: ${imagePath}`);
        }
      } catch (imgErr) {
        console.warn(` > Gagal menghapus file gambar ${animeToDelete.imageUrl}: ${imgErr.message}`);
      }
    }

    res.redirect('/admin/anime');

  } catch (error) {
    console.error(`Admin Delete Anime POST Error (${req.params.slug}):`, error);
    res.status(500).send(`Error menghapus anime: ${error.message}`);
  }
});

// Rute Update Anime
app.post('/admin/anime/:slug/edit', isAdmin, async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const updateData = req.body;
    const dataToUpdate = {
      title: updateData.title, alternativeTitle: updateData.alternativeTitle,
      synopsis: updateData.synopsis, imageUrl: updateData.imageUrl,
      "info.Status": updateData['info.Status'], "info.Released": updateData['info.Released'],
      "info.Type": updateData['info.Type'], "info.Studio": updateData['info.Studio'],
      "info.Producers": updateData['info.Producers'],
      genres: updateData.genres ? updateData.genres.split(',').map(g => g.trim()).filter(Boolean) : [],
    };
    Object.keys(dataToUpdate).forEach(key => (dataToUpdate[key] === undefined || dataToUpdate[key] === '') && delete dataToUpdate[key]);
    const updatedAnime = await Anime.findOneAndUpdate({ pageSlug: pageSlug }, { $set: dataToUpdate }, { new: true });
    if (!updatedAnime) return res.status(404).send('Anime not found for update.');
    console.log(`Successfully updated anime: ${pageSlug}`);
    res.redirect('/admin/anime');
  } catch (error) { console.error(`Admin Update Anime POST Error (${req.params.slug}):`, error); res.status(500).send('Error updating anime.'); }
});

// --- Rute Admin Episode List ---
app.get('/admin/episodes', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skipVal = (page - 1) * limit;
    const [episodes, totalCount] = await Promise.all([
      Episode.find().sort({ updatedAt: -1 }).skip(skipVal).limit(limit).lean(),
      Episode.countDocuments()
    ]);
    const totalPages = Math.ceil(totalCount / limit);
    res.render('admin/episode-list', {
      episodes: episodes, page: 'admin-episode-list', pageTitle: `Admin - Episode List (Halaman ${page}) - ${siteName}`,
      currentPage: page, totalPages: totalPages, baseUrl: '/admin/episodes',
      pageDescription: '', pageImage: '', pageUrl: '', query: '', 
    });
  } catch (error) { console.error("Admin Episode List Error:", error); res.status(500).send('Error loading admin episode list.'); }
});

// Rute Remote Upload Dood
app.post('/admin/api/remote-upload', isAdmin, delay, async (req, res) => {
  const { episodeSlug, videoUrl } = req.body;
  const DOOD_API_KEY = process.env.DOOD_API_KEY;

  if (!episodeSlug || !videoUrl) {
    return res.status(400).json({ success: false, error: 'Slug episode dan URL video diperlukan.' });
  }
  if (!DOOD_API_KEY) {
    return res.status(500).json({ success: false, error: 'DOOD_API_KEY tidak diatur di server.' });
  }

  try {
    const doodApiUrl = `https://doodapi.co/api/upload/url?key=${DOOD_API_KEY}&url=${encodeURIComponent(videoUrl)}`;
    const doodResponse = await axios.get(doodApiUrl);

    if (doodResponse.data.status !== 200 || !doodResponse.data.result) {
      throw new Error(`DoodAPI Error: ${doodResponse.data.msg || 'Gagal memulai upload'}`);
    }

    const fileCode = doodResponse.data.result.filecode;
    if (!fileCode) {
      throw new Error('DoodAPI mengembalikan respons sukses tetapi filecode tidak ditemukan.');
    }

    const newEmbedUrl = `https://dsvplay.com/e/${fileCode}`;
    const newDownloadUrl = `https://dsvplay.com/d/${fileCode}`;
    console.log(`[DoodUpload] Berhasil! URL Embed: ${newEmbedUrl}`);

    const newStreamLink = { name: "Mirror", url: newEmbedUrl };
    const newDownloadLink = { host: "DoodStream", url: newDownloadUrl };
    const newDownloadQualityGroup = { quality: "480p", links: [newDownloadLink] };

    const updatedEpisode = await Episode.findOneAndUpdate(
      { episodeSlug: episodeSlug },
      {
        $push: {
          streaming: newStreamLink,
          downloads: newDownloadQualityGroup
        }
      },
      { new: true }
    );

    if (!updatedEpisode) {
      return res.status(404).json({ success: false, error: 'Episode tidak ditemukan di DB.' });
    }
    res.json({ success: true, newLink: newStreamLink });

  } catch (error) {
    console.error(`[DoodUpload] Gagal: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Rute Batch Upload (Dinonaktifkan dari HTTP)
app.post('/admin/api/batch-remote-upload-start', isAdmin, async (req, res) => {
  console.error('[BatchUpload] PERINGATAN: Upaya menjalankan batch upload melalui HTTP terdeteksi.');
  console.error('[BatchUpload] Proses ini terlalu lama dan akan gagal. Harap pindahkan ke Cron Job di Render.');
  
  res.status(503).json({ 
    success: false, 
    error: 'Fungsi ini telah dinonaktifkan dari HTTP API untuk mencegah timeout server.' + 
           'Harap jalankan proses ini sebagai "Cron Job" terjadwal di dashboard Render Anda.'
  });
});


// Rute Clear Mirrors
app.post('/admin/api/clear-mirrors-start', isAdmin, async (req, res) => {
  try {
    console.log('[BatchDelete] Memulai proses penghapusan mirror...');
    const mirrorStreamNames = ["Mirror", "Viplay", "EarnVids"];
    const mirrorDownloadQualities = ["Mirror", "Viplay", "EarnVids", "480p", "720p"]; 

    const result = await Episode.updateMany(
      {}, 
      {
        $pull: {
          streaming: { name: { $in: mirrorStreamNames } },
          downloads: { quality: { $in: mirrorDownloadQualities } }
        }
      }
    );
    console.log(`[BatchDelete] Selesai. Dokumen yang dimodifikasi: ${result.modifiedCount}`);
    res.json({ success: true, modifiedCount: result.modifiedCount });

  } catch (error) {
    console.error(`[BatchDelete] Error Kritis: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Rute Halaman Batch Upload
app.get('/admin/batch-upload', isAdmin, (req, res) => {
  res.render('admin/batch-upload', {
    page: 'admin-batch-upload',
    pageTitle: `Batch Remote Upload - ${siteName}`,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', 
  });
});

// Rute Halaman Clear Mirrors
app.get('/admin/clear-mirrors', isAdmin, (req, res) => {
  res.render('admin/clear-mirrors', {
    page: 'admin-clear-mirrors',
    pageTitle: `Hapus Batch Mirror - ${siteName}`,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', 
  });
});

// Rute Admin Halaman Laporan Error
app.get('/admin/reports', isAdmin, async (req, res) => {
  try {
    const reports = await Report.find()
      .populate('user', 'username') // Tampilkan username pelapor jika ada
      .sort({ createdAt: -1 })
      .lean();

    res.render('admin/reports', {
      page: 'admin-reports',
      pageTitle: `Laporan Error - ${siteName}`,
      pageDescription: 'Daftar laporan error dari user.',
      reports: reports,
      pageImage: '', pageUrl: '', query: '', 
    });
  } catch (error) {
    console.error("Admin Reports Page Error:", error);
    res.status(500).send('Gagal memuat laporan.');
  }
});

// Rute Hapus Laporan
app.post('/admin/report/delete/:id', isAdmin, async (req, res) => {
  try {
    await Report.findByIdAndDelete(req.params.id);
    res.redirect('/admin/reports');
  } catch (error) {
    res.status(500).send('Gagal menghapus laporan.');
  }
});

// Rute Edit Episode (GET)
app.get('/admin/episode/:slug(*)/edit', isAdmin, async (req, res) => {
  try {
    const episodeSlug = "/" + decodeURIComponent(req.params.slug);
    const episode = await Episode.findOne({ episodeSlug: episodeSlug }).lean();
    if (!episode) return res.status(404).send('Episode not found.');
    res.render('admin/edit-episode', {
      episode: episode, page: 'admin-edit-episode', pageTitle: `Edit Episode: ${episode.title || episode.episodeSlug} - ${siteName}`,
      pageDescription: '', pageImage: '', pageUrl: '', query: '', 
    });
  } catch (error) { console.error(`Admin Edit Episode GET Error (${req.params.slug}):`, error); res.status(500).send('Error loading episode edit form.'); }
});

// Rute Edit Episode (POST)
app.post('/admin/episode/:slug(*)/edit', isAdmin, async (req, res) => {
  try {
    const episodeSlug = "/" + decodeURIComponent(req.params.slug);
    const formData = req.body;
    const dataToUpdate = {
      title: formData.title,
      thumbnailUrl: formData.thumbnailUrl,
      episodeDate: formData.episodeDate 
    };
    if (formData.streams && Array.isArray(formData.streams)) {
      dataToUpdate.streaming = formData.streams.filter(stream => stream && stream.name && stream.url)
        .map(stream => ({ name: stream.name.trim(), url: stream.url.trim() }));
    } else { dataToUpdate.streaming = []; }
    if (formData.downloads && Array.isArray(formData.downloads)) {
      dataToUpdate.downloads = formData.downloads.filter(qG => qG && qG.quality)
        .map(qG => ({ quality: qG.quality.trim(), links: (qG.links && Array.isArray(qG.links)) ? qG.links.filter(l => l && l.host && l.url).map(l => ({ host: l.host.trim(), url: l.url.trim() })) : [] }))
        .filter(qG => qG.links.length > 0);
    } else { dataToUpdate.downloads = []; }
    Object.keys(dataToUpdate).forEach(key => (dataToUpdate[key] === undefined || dataToUpdate[key] === '') && delete dataToUpdate[key]);

    const updatedEpisode = await Episode.findOneAndUpdate({ episodeSlug: episodeSlug }, { $set: dataToUpdate }, { new: true, runValidators: true });

    if (!updatedEpisode) return res.status(404).send('Episode not found for update.'); 

    console.log(`Successfully updated episode: ${episodeSlug}`);
    res.redirect('/admin/episodes');
  } catch (error) { console.error(`Admin Update Episode POST Error (${req.params.slug}):`, error); res.status(500).send(`Error updating episode: ${error.message}`); }
});

// Rute Hapus Episode
app.post('/admin/episode/:slug(*)/delete', isAdmin, async (req, res) => {
  try {
    const episodeSlug = "/" + decodeURIComponent(req.params.slug);
    console.log(`Mencoba menghapus episode: ${episodeSlug}`);

    const deleteEpisodeResult = await Episode.deleteOne({ episodeSlug: episodeSlug });

    if (deleteEpisodeResult.deletedCount > 0) {
      console.log(` > Sukses menghapus dari koleksi Episode: ${episodeSlug}`);
    } else {
      console.warn(` > Peringatan: Slug ${episodeSlug} tidak ditemukan di koleksi Episode.`);
    }

    const updateAnimeResult = await Anime.updateOne(
      { "episodes.url": episodeSlug },
      { $pull: { episodes: { url: episodeSlug } } }
    );

    if (updateAnimeResult.modifiedCount > 0) {
      console.log(` > Sukses menghapus referensi dari koleksi Anime.`);
    } else {
      console.warn(` > Peringatan: Slug ${episodeSlug} tidak ditemukan di array 'episodes' Anime manapun.`);
    }

    // Hapus juga komentar yang terkait
    const episode = await Episode.findOne({ episodeSlug: episodeSlug }).lean(); // Cari ID episode
    if (episode) {
      const deleteCommentsResult = await Comment.deleteMany({ episode: episode._id });
      console.log(` > Menghapus ${deleteCommentsResult.deletedCount} komentar terkait.`);
    }

    if (deleteEpisodeResult.deletedCount === 0 && updateAnimeResult.modifiedCount === 0) {
      console.error(` > Gagal total: Slug ${episodeSlug} tidak ditemukan di mana pun.`);
    }

    res.redirect('/admin/episodes');

  } catch (error) {
    console.error(`Admin Delete Episode POST Error (${req.params.slug}):`, error);
    res.status(500).send(`Error menghapus episode: ${error.message}`);
  }
});


// Rute Add Anime (GET)
app.get('/admin/anime/add', isAdmin, (req, res) => {
  res.render('admin/add-anime', {
    page: 'admin-add-anime', pageTitle: `Tambah Anime Baru - ${siteName}`,
    pageDescription: '', pageImage: '', pageUrl: '', query: '', 
  });
});

// Rute Add Anime (POST)
app.post('/admin/anime/add', isAdmin, upload.single('animeImage'), async (req, res) => {
  try {
    const formData = req.body;
    const file = req.file;

    if (!formData.title || !formData.pageSlug) {
      return res.status(400).send('Judul dan Slug wajib diisi.');
    }

    const existingAnime = await Anime.findOne({ pageSlug: formData.pageSlug });
    if (existingAnime) {
      return res.status(400).send(`Slug "${formData.pageSlug}" sudah digunakan.`);
    }

    let imageUrl = formData.imageUrl || '/images/default.jpg'; 

    if (file) {
      console.log(`Menerima upload file: ${file.originalname}`);
      const extension = path.extname(file.originalname); 
      const newFilename = `${formData.pageSlug}${extension}`; 
      const localDiskPath = path.join(UPLOAD_DISK_PATH, newFilename);
      const webPath = `/${UPLOAD_WEB_PATH_NAME}/${newFilename}`;
      if (!fs.existsSync(UPLOAD_DISK_PATH)) fs.mkdirSync(UPLOAD_DISK_PATH, { recursive: true });
      fs.writeFileSync(localDiskPath, file.buffer);
      imageUrl = webPath;
      console.log(`File disimpan ke: ${localDiskPath}`);
    }

    // ==========================================================
    // --- PERUBAHAN UTAMA DI SINI ---
    // Mengubah struktur objek 'info' agar sesuai dengan form baru
    // ==========================================================
    const newAnimeData = {
      title: formData.title,
      pageSlug: formData.pageSlug,
      // 'alternativeTitle' (level atas) dihapus, karena sekarang ada di dalam 'info'
      imageUrl: imageUrl,
      synopsis: formData.synopsis || '',
      info: {
        Alternatif: formData['info.Alternatif'] || '', // Kunci BARU
        Type: formData['info.Type'] || '',
        Episode: formData['info.Episode'] || '', // Kunci BARU
        Status: formData['info.Status'] || 'Unknown',
        Produser: formData['info.Produser'] || '', // Kunci BARU
        Released: formData['info.Released'] || '',
        // 'Studio' dan 'Producers' (kunci lama) telah dihapus
      },
      genres: formData.genres ? formData.genres.split(',').map(g => g.trim()).filter(Boolean) : [],
      episodes: [],
      characters: []
    };
    // ==========================================================
    // --- AKHIR PERUBAHAN ---
    // ==========================================================

    const createdAnime = await Anime.create(newAnimeData);
    console.log(`Anime baru ditambahkan: ${createdAnime.pageSlug}`);
    res.redirect('/admin/anime');

  } catch (error) {
    console.error("Admin Add Anime POST Error:", error);
    if (error instanceof multer.MulterError) {
      return res.status(400).send(`Error Multer: ${error.message}`);
    } else if (error.message.includes('Hanya file')) {
      return res.status(400).send(error.message);
    }
    res.status(500).send('Gagal menambahkan anime baru.');
  }
});

// Rute Add Episode (POST)
app.post('/admin/anime/:slug/episodes/add', isAdmin, async (req, res) => {
  const parentPageSlug = decodeURIComponent(req.params.slug);
  try {
    const { episodeTitle, episodeSlug, episodeDate } = req.body;
    if (!episodeTitle || !episodeSlug) return res.status(400).send('Judul dan Slug Episode wajib diisi.');
    const existingEpisode = await Episode.findOne({ episodeSlug: episodeSlug });
    if (existingEpisode) return res.status(400).send(`Slug Episode "${episodeSlug}" sudah digunakan.`);
    const parentAnime = await Anime.findOne({ pageSlug: parentPageSlug });
    if (!parentAnime) return res.status(404).send('Anime induk tidak ditemukan.');
    const newEpisodeForAnime = { title: episodeTitle, url: episodeSlug, date: episodeDate || new Date().toLocaleDateString('id-ID') };
    
    // Buat data episode lengkap untuk koleksi Episode
    const newEpisodeDataForCache = {
      episodeSlug: episodeSlug, 
      title: episodeTitle, 
      streaming: [], 
      downloads: [], 
      thumbnailUrl: '/images/default_thumb.jpg',
      animeTitle: parentAnime.title, 
      animeSlug: parentAnime.pageSlug, 
      animeImageUrl: parentAnime.imageUrl
    };
    const createdEpisode = await Episode.create(newEpisodeDataForCache);
    console.log(`Dokumen cache dibuat untuk Episode "${episodeSlug}"`);

    // Tambahkan referensi ke array Anime
    // (PENTING: Pastikan episode_id ditambahkan jika Anda membutuhkannya untuk menghapus komentar)
    newEpisodeForAnime._id = createdEpisode._id; // <-- Tambahkan ID ke referensi
    await Anime.updateOne(
      { pageSlug: parentPageSlug },
      { $push: { episodes: newEpisodeForAnime } }
    );
    console.log(`Episode "${episodeSlug}" ditambahkan ke array Anime "${parentPageSlug}"`);

    res.redirect(`/admin/anime/${encodeURIComponent(parentPageSlug)}/edit`);
  } catch (error) { console.error(`Admin Add Episode POST Error for ${parentPageSlug}:`, error); res.status(500).send('Gagal menambahkan episode baru.'); }
});


// ===================================
// --- WEBSITE PAGE ROUTES ---
// ===================================

// app.use('/', pageRoutes); // (Ini adalah tempat Anda akan meletakkan rute halaman)

app.get('/player', (req, res) => {
  try {
    res.render('player', { layout: false });
  } catch (error) {
    console.error("Gagal merender player:", error);
    res.status(500).send("Gagal memuat player.");
  }
});

app.get('/random', async (req, res) => {
  try {
    const randomAnime = await Anime.aggregate([ { $sample: { size: 1 } } ]);
    if (randomAnime && randomAnime.length > 0 && randomAnime[0].pageSlug) {
      const slug = randomAnime[0].pageSlug;
      const encodedSlug = encodeURIComponent(slug);
      console.log(`Redirecting to random anime: /anime/${encodedSlug}`);
      res.redirect(`/anime/${encodedSlug}`);
    } else {
      console.warn("Random anime not found, redirecting to .");
      res.redirect('/');
    }
  } catch (error) {
    console.error("Random Page Error:", error);
    res.redirect('/');
  }
});

app.get('/jadwal', (req, res) => {
  res.render('jadwal', {
    page: 'jadwal',
    pageTitle: `Jadwal Rilis - ${siteName}`,
    pageDescription: `Jadwal rilis anime Hentai terbaru dan yang akan datang.`,
    pageImage: `${SITE_URL}/images/default.jpg`,
    pageUrl: SITE_URL + req.originalUrl,
  });
});

app.get('/', (req, res) => {
  try {
    res.render('landing', {
      page: 'landing',
      pageTitle: `${siteName} - Nonton Anime Subtitle Indonesia`,
      pageDescription: 'Situs terbaik untuk nonton anime subtitle Indonesia gratis.',
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL,
      query: '',
    });
  } catch (error) {
    res.status(500).send('Error memuat halaman.');
  }
});

app.get('/home', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = ITEMS_PER_PAGE;
    const skip = (page - 1) * limit;

    const latestSeriesQuery = Anime.find({})
      .sort({ createdAt: -1 })
      .limit(8)
      .select('pageSlug imageUrl title info.Type info.Released info.Status')
      .lean();
    
    const episodesQuery = Episode.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(20)
      .lean();

    const totalEpisodesQuery = Episode.countDocuments({});

    const [episodes, totalCount, latestSeries] = await Promise.all([
      episodesQuery,
      totalEpisodesQuery,
      latestSeriesQuery
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    const formattedEpisodes = episodes.map(ep => {
      let duration = '??:??';
      if (ep.duration) {
        duration = ep.duration.replace('PT', '').replace('H', ':').replace('M', ':').replace('S', '');
      }
      return {
        watchUrl: `/anime${ep.episodeSlug}`,
        title: ep.title,
        imageUrl: ep.animeImageUrl || '/images/default.jpg',
        duration: duration,
        quality: '720p',
        year: new Date(ep.createdAt).getFullYear().toString(),
        createdAt: ep.createdAt
      };
    });

    res.render('home', {
      page: 'home',
      pageTitle: `${siteName} - AV Hentai Subtitle Indonesia`,
      pageDescription: `${siteName} Nonton anime hentai subtitle indonesia. Nikmati sensasi menonton anime hentai, ecchi, uncensored, sub indo kualitas video HD 1080p 720p 480p.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      episodes: formattedEpisodes,
      latestSeries: latestSeries, 
      currentPage: page,
      totalPages: totalPages,
      baseUrl: '/home'
    });

  } catch (error) {
    console.error("Home Page Error:", error);
    res.status(500).send('Terjadi kesalahan: ' + error.message);
  }
});

app.get('/search', async (req, res) => {
  try {
    const searchQuery = req.query.q;
    const page = parseInt(req.query.page) || 1;
    if (!searchQuery) return res.redirect('/');
    const query = { title: new RegExp(searchQuery, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    res.render('list', {
      animes: encodeAnimeSlugs(animes), pageTitle: `Cari: "${searchQuery}" - Halaman ${page} - ${siteName}`,
      query: searchQuery, page: 'list', pageDescription: `Hasil pencarian untuk "${searchQuery}".`,
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      currentPage: page, totalPages: totalPages, baseUrl: `/search?q=${encodeURIComponent(searchQuery)}`, totalCount: totalCount
    });
  } catch (error) { console.error("Search Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

app.get('/genre/:genreSlug', async (req, res) => {
  try {
    const genreSlug = req.params.genreSlug;
    const page = parseInt(req.query.page) || 1;
    
    let allGenres = appCache.get('allGenres');
    if (allGenres == null) {
      console.log("CACHE MISS: Mengambil 'allGenres' dari DB...");
      allGenres = await Anime.distinct('genres');
      appCache.set('allGenres', allGenres); 
    }

    const originalGenre = allGenres.find(g => slugify(g) === genreSlug);
    if (!originalGenre) {
      console.warn(`Genre slug not found: ${genreSlug}`);
      return res.status(404).send('Genre tidak ditemukan.');
    }

    const query = { genres: originalGenre };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Genre: ${originalGenre} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai dengan genre ${originalGenre}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/genre/${genreSlug}`,
      totalCount: totalCount
    });
  } catch (error) { console.error("Genre Filter Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

app.get('/status/:statusSlug', async (req, res) => {
  try {
    const statusSlug = req.params.statusSlug;
    const page = parseInt(req.query.page) || 1;

    let allStatuses = appCache.get('allStatuses');
    if (allStatuses == null) {
      console.log("CACHE MISS: Mengambil 'allStatuses' dari DB...");
      allStatuses = await Anime.distinct('info.Status');
      appCache.set('allStatuses', allStatuses);
    }
    
    const originalStatus = allStatuses.find(s => slugify(s) === statusSlug);
    if (!originalStatus) {
      console.warn(`Status slug not found: ${statusSlug}`);
      // --- PERBAIKAN 3: Ubah 44 menjadi 404 ---
      return res.status(404).send('Status tidak ditemukan.');
    }

    const query = { "info.Status": new RegExp(`^${originalStatus}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Status: ${originalStatus} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai dengan status ${originalStatus}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/status/${statusSlug}`,
      totalCount: totalCount
    });
  } catch (error) { console.error(`Status Filter Error (${req.params.statusSlug}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

app.get('/type/:typeSlug', async (req, res) => {
  try {
    const typeSlug = req.params.typeSlug;
    const page = parseInt(req.query.page) || 1;
    
    let allTypes = appCache.get('allTypes');
    if (allTypes == null) {
      console.log("CACHE MISS: Mengambil 'allTypes' dari DB...");
      allTypes = await Anime.distinct('info.Type');
      appCache.set('allTypes', allTypes);
    }

    const originalType = allTypes.find(t => slugify(t) === typeSlug);
    if (!originalType) {
      console.warn(`Type slug not found: ${typeSlug}`);
      return res.status(404).send('Type tidak ditemukan.');
    }

    const query = { "info.Type": new RegExp(`^${originalType}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Type: ${originalType} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai type ${originalType}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/type/${typeSlug}`,
      totalCount: totalCount
    });
  } catch (error) { console.error(`Type Filter Error (${req.params.typeSlug}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

app.get('/studio/:studioSlug', async (req, res) => {
  try {
    const studioSlug = req.params.studioSlug;
    const page = parseInt(req.query.page) || 1;

    let allStudios = appCache.get('allStudios');
    if (allStudios == null) {
      console.log("CACHE MISS: Mengambil 'allStudios' dari DB...");
      allStudios = await Anime.distinct('info.Studio');
      appCache.set('allStudios', allStudios);
    }
    
    const originalStudio = allStudios.find(s => slugify(s) === studioSlug);
    if (!originalStudio) {
      console.warn(`Studio slug not found: ${studioSlug}`);
      return res.status(404).send('Studio tidak ditemukan.');
    }

    const query = { "info.Studio": new RegExp(`^${originalStudio}$`, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Studio: ${originalStudio} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai studio ${originalStudio}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/studio/${studioSlug}`,
      totalCount: totalCount
    });
  } catch (error) { console.error(`Studio Filter Error (${req.params.studioSlug}):`, error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

app.get('/hentai-list', async (req, res) => {
   try {
    const page = parseInt(req.query.page) || 1;
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
  
      // 1. Definisikan query untuk 'latestSeries'
      const latestSeriesQuery = Anime.find({})
        .sort({ createdAt: -1 })
        .limit(7) // Anda bisa sesuaikan jumlah ini
        .select('pageSlug imageUrl title info.Type info.Released info.Status')
        .lean();
   
      // 2. Tambahkan 'latestSeriesQuery' ke Promise.all
    const [animes, totalCount, latestSeries] = await Promise.all([
     Anime.find().sort({ _id: +1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(), 
        Anime.countDocuments(),
        latestSeriesQuery // <-- Ditambahkan di sini
    ]);
  
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
    
      res.render('hentai-list', {
        // 3. Encode 'animes' dan 'latestSeries' sebelum dikirim
     animes: encodeAnimeSlugs(animes), 
     page: 'hentai-list', 
     pageTitle: `Daftar Hentai Subtitle Indonesia - Halaman ${page} - ${siteName}`,
     pageDescription: 'Lihat semua koleksi hentai kami.', 
     pageImage: `${SITE_URL}/images/default.jpg`, 
     pageUrl: SITE_URL + req.originalUrl,
     currentPage: page, 
     totalPages: totalPages, 
     baseUrl: '/hentai-list', 
     totalCount: totalCount,
     latestSeries: encodeAnimeSlugs(latestSeries) // <-- Variabel sekarang sudah ada
    });
   } catch (error) { 
      console.error("Anime List Error:", error); 
      res.status(500).send('Terjadi kesalahan: ' + error.message); 
    }
  });

app.get('/genre-list', async (req, res) => {
  try {
    let genres = appCache.get('allGenres');
    if (genres == null) {
      console.log("CACHE MISS: Mengambil 'allGenres' dari DB...");
      genres = await Anime.distinct('genres');
      appCache.set('allGenres', genres);
    }
    
    genres.sort();
    res.render('genre-list', {
      genres: genres, page: 'genre-list', pageTitle: `Daftar Genre - ${siteName}`,
      pageDescription: 'Jelajahi hentai berdasarkan genre.', pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, 
    });
  } catch (error) { console.error("Genre List Error:", error); res.status(500).send('Terjadi kesalahan: ' + error.message); }
});

app.get('/tahun-list', async (req, res) => {
  try {
    let allReleasedDates = appCache.get('allReleasedDates');
    if (allReleasedDates == null) {
      console.log("CACHE MISS: Mengambil 'allReleasedDates' dari DB...");
      allReleasedDates = await Anime.distinct('info.Released');
      appCache.set('allReleasedDates', allReleasedDates);
    }

    const yearRegex = /(\d{4})/;
    const years = allReleasedDates
      .map(dateStr => {
        const match = dateStr.match(yearRegex);
        return match ? match[1] : null; 
      })
      .filter(Boolean); 

    const uniqueYears = [...new Set(years)].sort((a, b) => b - a);

    res.render('tahun-list', { 
      years: uniqueYears,
      page: 'tahun-list',
      pageTitle: `Daftar Tahun Rilis - ${siteName}`,
      pageDescription: 'Jelajahi hentai berdasarkan tahun rilis.',
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      totalCount: uniqueYears.length
    });
  } catch (error) {
    console.error("Tahun List Error:", error);
    res.status(500).send('Terjadi kesalahan: ' + error.message);
  }
});

app.get('/tahun/:year', async (req, res) => {
  try {
    const year = req.params.year;
    if (!/^\d{4}$/.test(year)) {
      return res.status(404).send('Tahun tidak valid.');
    }
    const page = parseInt(req.query.page) || 1;
    const query = { "info.Released": new RegExp(year, 'i') };
    const skipVal = (page - 1) * ITEMS_PER_PAGE;
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip(skipVal).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

    res.render('list', {
      animes: encodeAnimeSlugs(animes),
      pageTitle: `Tahun Rilis: ${year} - Halaman ${page} - ${siteName}`,
      query: '', page: 'list',
      pageDescription: `Daftar hentai yang rilis pada tahun ${year}.`,
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      currentPage: page,
      totalPages: totalPages,
      baseUrl: `/tahun/${year}`, 
      totalCount: totalCount
    });
  } catch (error) {
    console.error(`Tahun Filter Error (${req.params.year}):`, error);
    res.status(500).send('Terjadi kesalahan: ' + error.message);
  }
});

// RUTE NONTON
app.get('/anime/:animeId/:episodeNum', async (req, res) => {
 try {
  const { animeId, episodeNum } = req.params;
  const episodeSlug = `/${animeId}/${episodeNum}`; 

  const latestSeriesQuery = Anime.find({})
      .sort({ createdAt: -1 })
      .limit(8)
      .select('pageSlug imageUrl title info.Type info.Released info.Status')
      .lean();

  const [episodeData, parentAnime, recommendations, latestSeries] = await Promise.all([
   Episode.findOne({ episodeSlug: episodeSlug }).lean(), 
   Anime.findOne({ "episodes.url": episodeSlug }).lean(),
   Anime.aggregate([{ $sample: { size: 7 } }]),
      latestSeriesQuery
  ]);

  if (!episodeData) {
   console.error(`Gagal mendapatkan data episode dari DB untuk slug: ${episodeSlug}`);
   return res.status(404).render('404', {
    page: '404', pageTitle: `404 - ${siteName}`, pageDescription: 'Episode tidak ditemukan.',
    pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', 
   });
  }

  if (episodeData.streaming) episodeData.streaming = episodeData.streaming.map(s => ({ ...s, url: s.url ? Buffer.from(s.url).toString('base64') : null }));
  if (episodeData.downloads) episodeData.downloads = episodeData.downloads.map(q => ({ ...q, links: q.links.map(l => ({ ...l, url: l.url ? Buffer.from(l.url).toString('base64') : null })) }));

  const encodedRecommendations = encodeAnimeSlugs(recommendations).filter(rec => !parentAnime || rec._id.toString() !== parentAnime._id.toString());
  const nav = { prev: null, next: null, all: null };

  if (parentAnime) {
   nav.all = `/anime/${parentAnime.pageSlug ? encodeURIComponent(parentAnime.pageSlug) : ''}`;
   const episodes_list = parentAnime.episodes || [];
   const currentIndex = episodes_list.findIndex(ep => ep.url === episodeSlug);

   if (currentIndex > -1) {
    if (currentIndex > 0) { 
     const prevSlug = episodes_list[currentIndex - 1].url;
     nav.prev = { ...episodes_list[currentIndex - 1], url: `/anime${prevSlug}` };
    }
    if (currentIndex < episodes_list.length - 1) { 
     const nextSlug = episodes_list[currentIndex + 1].url;
     nav.next = { ...episodes_list[currentIndex + 1], url: `/anime${nextSlug}` };
    }
   }
  }

  const description = `Nonton ${episodeData.title || episodeSlug} Subtitle Indonesia. ${parentAnime ? (parentAnime.synopsis || '').substring(0, 160) + '...' : ''}`;
  let seoImage = (parentAnime && parentAnime.imageUrl) ? encodeAnimeSlugs([parentAnime])[0].imageUrl : `${SITE_URL}/images/default.jpg`;

  res.render('nonton', {
   data: episodeData, 
   nav: nav, 
   recommendations: encodedRecommendations, 
   page: 'nonton',
   pageTitle: `${episodeData.title || episodeSlug} Subtitle Indonesia - ${siteName}`,
   pageDescription: description, 
   pageImage: seoImage, 
   pageUrl: SITE_URL + req.originalUrl, 
   parentAnime: parentAnime,
      latestSeries: latestSeries
  });

 } catch (error) {
  const episodeSlugForError = `/${req.params.animeId}/${req.params.episodeNum}`;
  console.error(`Watch Episode Error (${episodeSlugForError}):`, error);
   res.status(500).send('Gagal memuat video: ' + error.message);
 }
});

// RUTE DETAIL ANIME
app.get('/anime/:slug', async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    
    const latestSeriesQuery = Anime.find({})
      .sort({ createdAt: -1 })
      .limit(8)
      .select('pageSlug imageUrl title info.Type info.Released info.Status')
      .lean();

    const [animeData, recommendations, latestSeries] = await Promise.all([
      Anime.findOne({ pageSlug: pageSlug }).lean(),
      Anime.aggregate([{ $match: { pageSlug: { $ne: pageSlug } } }, { $sample: { size: 8 } }]),
      latestSeriesQuery 
    ]);

    if (!animeData) {
      console.log(`Data '${pageSlug}' not found in DB.`);
      return res.status(404).render('404', {
        page: '404', pageTitle: `404 - ${siteName}`, pageDescription: 'Anime tidak ditemukan.',
        pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', 
      });
    }

    Anime.updateOne({ pageSlug: pageSlug }, { $inc: { viewCount: 1 } })
      .exec()
      .catch(err => console.error(`Failed to increment view count for ${pageSlug}:`, err));

    const encodedRecommendations = encodeAnimeSlugs(recommendations);
    const description = (animeData.synopsis || '').substring(0, 160) + '...';

    const [encodedMainData] = encodeAnimeSlugs([animeData]);
    encodedMainData.pageSlugEncoded = animeData.pageSlug ? encodeURIComponent(animeData.pageSlug) : null;
    encodedMainData.episodes = animeData.episodes?.map(ep => ({ ...ep, url: `/anime${ep.url}` })) || [];

    res.render('anime', {
      data: encodedMainData, 
      recommendations: encodedRecommendations, 
      page: 'anime',
      pageTitle: `${animeData.title || pageSlug} Subtitle Indonesia - ${siteName}`,
      pageDescription: description, 
      pageImage: encodedMainData.imageUrl,
      pageUrl: SITE_URL + req.originalUrl, 
      latestSeries: latestSeries 
    });
  } catch (error) {
    console.error(`Anime Detail Error (${req.params.slug}):`, error);
    res.status(500).send('Terjadi kesalahan: ' + error.message);
  }
});

//redirect old pagination URLs to new format

function handleOldPagination(req, res, newBasePath) {
  const pageNumber = req.params.pageNumber;
  // Pastikan pageNumber adalah angka
  if (pageNumber && /^\d+$/.test(pageNumber)) {
    const newUrl = `${newBasePath}?page=${pageNumber}`;
    res.redirect(301, newUrl); // 301 Redirect Permanen
  } else {
    // Jika /page/bukan-angka, redirect ke basisnya
    res.redirect(301, newBasePath);
  }
}

// Redirect untuk /anime-list/page/..
app.get('/anime-list/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, '/hentai-list');
});

// Redirect untuk /genre/slug/page/..
app.get('/genre/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/genre/${req.params.slug}`);
});

// Redirect untuk /status/slug/page/..
app.get('/status/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/status/${req.params.slug}`);
});

// Redirect untuk /type/slug/page/..
app.get('/type/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/type/${req.params.slug}`);
});

// Redirect untuk /studio/slug/page/..
app.get('/studio/:slug/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/studio/${req.params.slug}`);
});

// Redirect untuk /tahun/tahun/page/..
app.get('/tahun/:year/page/:pageNumber(\\d+)/?', (req, res) => {
  handleOldPagination(req, res, `/tahun/${req.params.year}`);
});

// RUTE REDIRECT (URL LAMA)
app.get('/nonton/:episodeSlug(*)', (req, res) => {
  const episodeSlug = req.params.episodeSlug; 
  if (episodeSlug) {
    res.redirect(301, `${episodeSlug}`);
  } else {
    res.redirect(301, '/');
  }
});

app.get('/page/:pageNumber(\\d+)/?', (req, res) => {
  res.redirect(301, `/home?page=${req.params.pageNumber}`);
});

app.get('/:slug-episode-:episode(\\d+)-subtitle-indonesia/?', (req, res) => {
  const { slug, episode } = req.params;

  res.redirect(301, `/anime/${slug}/${episode}`);
});

app.get('/safelink', (req, res) => {
  const base64Url = req.query.url;
  if (!base64Url) {
    return res.status(404).render('404', {
      page: '404', pageTitle: `404 - ${siteName}`, pageDescription: 'Halaman tidak ditemukan.',
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', 
    });
  }
  try {
    res.render('safelink', {
      page: 'safelink',
      pageTitle: `Mengarahkan... - ${siteName}`,
      pageDescription: 'Harap tunggu untuk diarahkan ke link Anda.',
      pageImage: `${SITE_URL}/images/default.jpg`,
      pageUrl: SITE_URL + req.originalUrl,
      query: '',
      base64Url: base64Url
    });
  } catch (error) {
    console.error("Safelink render error:", error);
    res.status(500).send('Error saat memuat halaman safelink.');
  }
});

app.get('/bookmarks', (req, res) => {
  try {
    res.render('bookmarks', {
      animes: [], page: 'bookmarks', pageTitle: `Bookmark Saya - ${siteName}`, pageDescription: 'Lihat daftar anime...',
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', 
    });
  } catch (error) { console.error("Bookmarks Page Error:", error); res.status(500).send('Terjadi kesalahan.'); }
});

// ===================================
// --- RUTE AUTENTIKASI PENGGUNA ---
// ===================================

app.get('/login', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/bookmarks'); 
  }
  res.render('login', {
    page: 'login',
    pageTitle: `Login - ${siteName}`,
    pageDescription: 'Login untuk menyimpan bookmark.',
    pageImage: `${SITE_URL}/images/default.jpg`,
    pageUrl: SITE_URL + req.originalUrl,
    query: '',
    error: req.query.error
  });
});

app.get('/register', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/bookmarks');
  }
  res.render('register', {
    page: 'register',
    pageTitle: `Register - ${siteName}`,
    pageDescription: 'Buat akun baru untuk menyimpan bookmark.',
    pageImage: `${SITE_URL}/images/default.jpg`,
    pageUrl: SITE_URL + req.originalUrl,
    query: '',
    error: req.query.error
  });
});

app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const existingUser = await User.findOne({ $or: [{ username: username.toLowerCase() }] });
    if (existingUser) {
      return res.redirect('/register?error=Username sudah terdaftar');
    }
    const user = new User({ username, password });
    await user.save();
    req.session.userId = user._id;
    req.session.username = user.username;
    res.redirect('/bookmarks');
  } catch (error) {
    console.error("Register Error:", error);
    res.redirect(`/register?error=${encodeURIComponent(error.message)}`);
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) {
      return res.redirect('/login?error=Username atau Password salah');
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.redirect('/login?error=Username atau Password salah');
    }
    req.session.userId = user._id;
    req.session.username = user.username;
    res.redirect('/bookmarks');
  } catch (error) {
    console.error("Login Error:", error);
    res.redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout Error:", err);
    }
    res.redirect('/home'); 
  });
});


// ===================================
// --- API ROUTES ---
// ===================================
// Rute API untuk Lapor Error
app.post('/api/report-error',  isLoggedIn, async (req, res) => {
  try {
    const { pageUrl, message } = req.body;
    const userId = req.session.userId; // Ambil ID user jika login

    if (!pageUrl || !message || message.trim() === '') {
      return res.status(400).json({ success: false, message: 'Laporan tidak boleh kosong.' });
    }

    const newReport = new Report({
      pageUrl: pageUrl,
      message: message,
      user: userId,
      status: 'Baru'
    });
    await newReport.save();

    res.status(201).json({ success: true, message: 'Laporan berhasil terkirim. Terima kasih!' });
  } catch (error) {
    console.error("API /api/report-error Error:", error);
    res.status(500).json({ success: false, message: 'Gagal mengirim laporan.' });
  }
});

app.use('/api/popular', checkApiReferer);
app.use('/api/tahun-ini', checkApiReferer);
app.use('/api/genre/uncensored', checkApiReferer);

app.get('/api/popular', async (req, res) => {
  try {
    const range = req.query.range || 'weekly';
    let dateFilter = {};
    const now = new Date();

    if (range === 'weekly') {
      dateFilter = { updatedAt: { $gte: new Date(now.setDate(now.getDate() - 7)) } };
    } else if (range === 'monthly') {
      dateFilter = { updatedAt: { $gte: new Date(now.setMonth(now.getMonth() - 1)) } };
    }

    const popularAnime = await Anime.find(dateFilter)
      .sort({ viewCount: -1 })
      .limit(10)
      .select('title pageSlug imageUrl genres')
      .lean();
    const encodedResults = encodeAnimeSlugs(popularAnime);
    res.json(encodedResults);

  } catch (error) {
    console.error("API /api/popular Error:", error);
    res.status(500).json({ error: 'Gagal mengambil data populer' });
  }
});

app.get('/api/tahun-ini', async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const yearRegex = new RegExp(currentYear.toString()); 
    const animes = await Anime.find({ 'info.Released': yearRegex }) 
      .sort({ createdAt: -1 }) 
      .limit(6) 
      .select('pageSlug imageUrl title genres') 
      .lean();
    res.json(animes);
  } catch (error) {
    console.error('Error fetching API /api/tahun-ini:', error);
    res.status(500).json({ error: 'Gagal memuat data' });
  }
});

app.get('/api/genre/uncensored', async (req, res) => {
  try {
    const animes = await Anime.find({ 'genres': /uncensored/i }) 
      .sort({ createdAt: -1 }) 
      .limit(6) 
      .select('pageSlug imageUrl title genres') 
      .lean();
    res.json(animes);
  } catch (error) {
    console.error('Error fetching API /api/genre/uncensored:', error);
    res.status(500).json({ error: 'Gagal memuat data' });
  }
});

// --- Rute API Bookmark ---
app.get('/api/bookmark-status', async (req, res) => { try { const { userId, animeId } = req.query; if (!userId || !mongoose.Types.ObjectId.isValid(animeId)) return res.status(400).json({ isBookmarked: false, error: '...' }); const bookmark = await Bookmark.findOne({ userId: userId, animeRef: animeId }); res.json({ isBookmarked: !!bookmark }); } catch (error) { console.error("API /api/bookmark-status Error:", error); res.status(500).json({ isBookmarked: false, error: '...' }); } });
app.post('/api/bookmarks', async (req, res) => { try { const { userId, animeId } = req.body; if (!userId || !mongoose.Types.ObjectId.isValid(animeId)) return res.status(400).json({ success: false, error: '...' }); await Bookmark.findOneAndUpdate({ userId: userId, animeRef: animeId }, { $setOnInsert: { userId: userId, animeRef: animeId } }, { upsert: true }); res.status(200).json({ success: true, isBookmarked: true }); } catch (error) { console.error("API POST /api/bookmarks Error:", error); res.status(500).json({ success: false, error: '...' }); } });
app.delete('/api/bookmarks', async (req, res) => { try { const { userId, animeId } = req.query; if (!userId || !mongoose.Types.ObjectId.isValid(animeId)) return res.status(400).json({ success: false, error: '...' }); await Bookmark.deleteOne({ userId: userId, animeRef: animeId }); res.status(200).json({ success: true, isBookmarked: false }); } catch (error) { console.error("API DELETE /api/bookmarks Error:", error); res.status(500).json({ success: false, error: '...' }); } });
app.get('/api/my-bookmarks', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.json([]);
    const bookmarks = await Bookmark.find({ userId: userId })
      .populate({
        path: 'animeRef',
        model: 'Anime',
        select: 'title pageSlug imageUrl episodes info.Released info.Status'
      })
      .sort({ createdAt: -1 })
      .lean();
    const animes = bookmarks.map(b => b.animeRef).filter(Boolean);
    res.json(encodeAnimeSlugs(animes)); 
  } catch (error) {
    console.error("API /api/my-bookmarks Error:", error);
    res.status(500).json({ error: 'Gagal memuat bookmark' });
  }
});
app.delete('/api/bookmarks/all', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId diperlukan' });
    }
    const deleteResult = await Bookmark.deleteMany({ userId: userId });
    console.log(`Cleared ${deleteResult.deletedCount} bookmarks for userId: ${userId}`);
    res.status(200).json({ success: true, deletedCount: deleteResult.deletedCount });
  } catch (error) {
    console.error("API DELETE /api/bookmarks/all Error:", error);
    res.status(500).json({ success: false, error: 'Gagal menghapus semua bookmark' });
  }
});


// ==========================================================
// == API V1 (UNTUK FLUTTER/EXTERNAL) ==
// ==========================================================

// --- BARU: Gunakan file router eksternal ---
app.use('/api/v1', apiV1Routes);

// --- DIHAPUS ---
// Semua rute app.get('/api/v1/...') telah dipindahkan
// ke routes/api_v1.js
// -----------------


// ===================================
// --- UTILITY ROUTES (ADMIN & SEO) ---
// ===================================

/*
app.get('/batch-scrape', isAdmin, async (req, res) => { 
  // ... (Dinonaktifkan)
  res.status(503).json({ error: 'Fungsi batch-scrape telah dinonaktifkan.' });
});
*/

// Rute robots.txt (Versi Optimal)
app.get('/robots.txt', (req, res) => {
 res.type('text/plain');
 res.send(
  `User-agent: *\n` +
  `Allow: /\n` +
  `\n` +
  `# Path yang tidak boleh di-index\n` +
  `Disallow: /admin/\n` +
  `Disallow: /search\n` +
  `Disallow: /safelink\n` +
  `Disallow: /player\n` +
  `\n` +
  `# Blokir semua rute API\n` +
  `Disallow: /api/\n` + 
  `\n` +
  `Sitemap: ${SITE_URL}/sitemap_index.xml`
 );
});

app.get('/sitemap_index.xml', (req, res) => {
  const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  const xmlFooter = '</sitemapindex>';
  const lastMod = new Date().toISOString().split('T')[0]; 
  let xmlBody = '';
  const sitemaps = [
    'sitemap-static.xml', 'sitemap-anime.xml',
    'sitemap-episode.xml', 'sitemap-taxonomies.xml'
  ];
  sitemaps.forEach(sitemapUrl => {
    xmlBody += `<sitemap><loc>${SITE_URL}/${sitemapUrl}</loc><lastmod>${lastMod}</lastmod></sitemap>`;
  });
  res.header('Content-Type', 'application/xml');
  res.send(xmlHeader + xmlBody + xmlFooter);
});

app.get('/sitemap-static.xml', (req, res) => {
  const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
  const xmlFooter = '</urlset>';
  let xmlBody = '';
  const formatDate = (date) => date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const staticPages = [
    { url: '/', changefreq: 'monthly', priority: '0.8' },
    { url: '/home', changefreq: 'daily', priority: '1.0' },
    { url: '/anime-list', changefreq: 'daily', priority: '0.9' },
    { url: '/genre-list', changefreq: 'weekly', priority: '0.7' },
    { url: '/tahun-list', changefreq: 'yearly', priority: '0.7' },
    { url: '/jadwal', changefreq: 'daily', priority: '0.8' }
  ];
  staticPages.forEach(page => {
    xmlBody += `<url><loc>${SITE_URL}${page.url}</loc><lastmod>${formatDate(new Date())}</lastmod><changefreq>${page.changefreq}</changefreq><priority>${page.priority}</priority></url>`;
  });
  res.header('Content-Type', 'application/xml');
  res.send(xmlHeader + xmlBody + xmlFooter);
});

app.get('/sitemap-anime.xml', async (req, res) => {
  try {
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    const xmlFooter = '</urlset>';
    const formatDate = (date) => date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    res.header('Content-Type', 'application/xml');
    res.write(xmlHeader); 

    const cursor = Anime.find({}, 'pageSlug createdAt').lean().cursor();

    for (let anime = await cursor.next(); anime != null; anime = await cursor.next()) {
      if (anime.pageSlug) {
        const urlEntry = `<url><loc>${SITE_URL}/anime/${encodeURIComponent(anime.pageSlug)}</loc><lastmod>${formatDate(anime.createdAt)}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`;
        res.write(urlEntry); 
      }
    }
    
    res.end(xmlFooter); 

  } catch (error) {
    console.error('Error generating sitemap-anime.xml:', error.message);
    res.status(500).send('Gagal membuat sitemap');
  }
});

app.get('/sitemap-episode.xml', async (req, res) => {
  try {
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    const xmlFooter = '</urlset>';
    const formatDate = (date) => date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    
    res.header('Content-Type', 'application/xml');
    res.write(xmlHeader);

    const cursor = Episode.find({}, 'episodeSlug createdAt').lean().cursor();
    
    for (let episode = await cursor.next(); episode != null; episode = await cursor.next()) {
      if (episode.episodeSlug) { 
        const urlEntry = `<url><loc>${SITE_URL}/anime${episode.episodeSlug}</loc><lastmod>${formatDate(episode.createdAt)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
        res.write(urlEntry);
      }
    }

    res.end(xmlFooter);

  } catch (error) {
    console.error('Error generating sitemap-episode.xml:', error.message);
    res.status(500).send('Gagal membuat sitemap');
  }
});

app.get('/sitemap-taxonomies.xml', async (req, res) => {
  try {
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    const xmlFooter = '</urlset>';
    let xmlBody = '';

    let [genres, types, studios, allReleasedDates] = [
      appCache.get('allGenres'),
      appCache.get('allTypes'),
      appCache.get('allStudios'),
      appCache.get('allReleasedDates')
    ];

    if (!genres) { genres = await Anime.distinct('genres').exec(); appCache.set('allGenres', genres); }
    if (!types) { types = await Anime.distinct('info.Type').exec(); appCache.set('allTypes', types); }
    if (!studios) { studios = await Anime.distinct('info.Studio').exec(); appCache.set('allStudios', studios); }
    if (!allReleasedDates) { allReleasedDates = await Anime.distinct('info.Released'); appCache.set('allReleasedDates', allReleasedDates); }

    genres.forEach(genre => {
      if (genre) xmlBody += `<url><loc>${SITE_URL}/genre/${slugify(genre)}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`;
    });

    types.forEach(type => {
      if (type) xmlBody += `<url><loc>${SITE_URL}/type/${slugify(type)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
    });

    studios.forEach(studio => {
      if (studio) xmlBody += `<url><loc>${SITE_URL}/studio/${slugify(studio)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
    });

    const yearRegex = /(\d{4})/;
    const years = allReleasedDates.map(d => d.match(yearRegex) ? d.match(yearRegex)[1] : null).filter(Boolean);
    const uniqueYears = [...new Set(years)];
    uniqueYears.forEach(year => {
      xmlBody += `<url><loc>${SITE_URL}/tahun/${year}</loc><changefreq>yearly</changefreq><priority>0.6</priority></url>`;
    });

    res.header('Content-Type', 'application/xml');
    res.send(xmlHeader + xmlBody + xmlFooter);
  } catch (error) {
    console.error('Error generating sitemap-taxonomies.xml:', error.message);
    res.status(500).send('Gagal membuat sitemap');
  }
});

// ===================================
// --- 404 HANDLER (MUST BE LAST Route) ---
// ===================================
app.use((req, res, next) => {
  res.status(404).render('404', {
    page: '404', pageTitle: `404 - Halaman Tidak Ditemukan - ${siteName}`,
    pageDescription: 'Maaf, halaman yang Anda cari tidak ada.',
    pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl, query: '', 
  });
});

// ===================================
// --- START DATABASE & SERVER ---
// ===================================

if (!DB_URI) {
  console.error("FATAL ERROR: DB_URI is not defined in environment variables.");
  process.exit(1); 
}

const startServer = async () => {
  try {
    await mongoose.connect(DB_URI, {
      serverSelectionTimeoutMS: 30000
    });
    console.log('Successfully connected to MongoDB...');

    app.listen(PORT, () => {
      console.log(`Server is running on port: ${PORT}`);
      console.log(`Access at: ${SITE_URL}`); 
    });

  } catch (err) {
    console.error('Failed to connect to MongoDB. Server will not start.', err);
    process.exit(1); 
  }
};

startServer();
// --- PERBAIKAN: Hapus '}' ekstra dari sini ---
// (Sudah dihapus di versi ini)