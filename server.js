require('dotenv').config();
const siteName = process.env.SITE_NAME || 'RajaHentai';
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const compression = require('compression');
const NodeCache = require('node-cache');
const { slugify, formatCompactNumber, encodeAnimeSlugs } = require('./utils/helpers');
const apiV1Routes = require('./routes/api_v1');
const { uploadVideoToLewdHost } = require('./utils/lewdUpload');
const { uploadToR2 } = require('./utils/r2Upload');

// Models
const Anime = require('./models/Anime');
const Episode = require('./models/Episode');
const Bookmark = require('./models/Bookmark');
const User = require('./models/User');
const Comment = require('./models/Comment');
const Report = require('./models/Report');

const app = express();
const appCache = new NodeCache({ stdTTL: 3600 });
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/webp' || file.mimetype === 'application/json') {
    cb(null, true);
  } else {
    cb(new Error('Format file tidak diizinkan!'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

const PORT = process.env.PORT || 3000;
const ITEMS_PER_PAGE = 20;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const DB_URI = process.env.DB_URI;
const UPLOAD_WEB_PATH_NAME = 'images';
const UPLOAD_DISK_PATH = process.env.RENDER_DISK_PATH || path.join(__dirname, 'public', UPLOAD_WEB_PATH_NAME);

if (!process.env.RENDER_DISK_PATH) {
  if (!fs.existsSync(UPLOAD_DISK_PATH)) {
    fs.mkdirSync(UPLOAD_DISK_PATH, { recursive: true });
  }
}

async function checkApiReferer(req, res, next) {
  try {
    const referer = req.headers.referer;
    const allowedHostname = new URL(SITE_URL).hostname;
    if (!referer) return res.status(403).json({ error: 'Akses Ditolak' });
    const refererHostname = new URL(referer).hostname;
    if (refererHostname === allowedHostname) {
      next();
    } else {
      return res.status(403).json({ error: 'Akses Ditolak' });
    }
  } catch (error) {
    return res.status(403).json({ error: 'Akses Ditolak' });
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

app.locals.slugify = slugify;
app.locals.formatCompactNumber = formatCompactNumber;
app.locals.siteName = siteName;
app.locals.SITE_URL = SITE_URL;

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: DB_URI,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.userId ? {
    id: req.session.userId,
    username: req.session.username
  } : null;
  next();
});

const isLoggedIn = (req, res, next) => {
  if (req.session && req.session.userId) {
    return next();
  } else {
    res.status(401).json({ error: 'Anda harus login' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  } else {
    res.redirect('/admin/login');
  }
};

// --- ADMIN ROUTES ---

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', {
    page: 'admin-login', pageTitle: `Admin Login - ${siteName}`, error: req.query.error,
    pageDescription: '', pageImage: '', pageUrl: '', query: ''
  });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=Invalid credentials');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/admin/login');
  });
});

app.get('/admin', isAdmin, async (req, res) => {
  try {
    const [totalAnime, totalEpisodes, totalUsers, totalComments] = await Promise.all([
      Anime.countDocuments(),
      Episode.countDocuments(),
      User.countDocuments(),
      Comment.countDocuments()
    ]);
    res.render('admin/dashboard', {
      page: 'admin-dashboard', pageTitle: `Admin Dashboard - ${siteName}`,
      pageDescription: '', pageImage: '', pageUrl: '', query: '',
      totalAnime, totalEpisodes, totalUsers, totalComments
    });
  } catch (error) {
    res.status(500).send('Gagal memuat statistik.');
  }
});

app.get('/admin/backup', isAdmin, (req, res) => {
  res.render('admin/backup', {
    page: 'admin-backup', pageTitle: `Backup - ${siteName}`,
    pageDescription: '', pageImage: '', pageUrl: '', query: ''
  });
});

app.get('/admin/backup/export', isAdmin, async (req, res) => {
  try {
    const fileName = `backup_${siteName.toLowerCase()}_${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

    res.write(`{ "exportedAt": "${new Date().toISOString()}", "collections": {`);
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

    await streamCollection(Anime, 'animes'); res.write(',');
    await streamCollection(Episode, 'episodes'); res.write(',');
    await streamCollection(Bookmark, 'bookmarks'); res.write(',');
    await streamCollection(User, 'users'); res.write(',');
    await streamCollection(Comment, 'comments');

    res.write(`} }`);
    res.end();
  } catch (error) {
    res.status(500).send('Gagal mengekspor data.');
  }
});

app.post('/admin/backup/import', isAdmin, upload.single('backupFile'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/json') return res.status(400).send('File harus .json');
    const backupData = JSON.parse(req.file.buffer.toString('utf8'));
    const { animes, episodes, bookmarks, users, comments } = backupData.collections;

    await Promise.all([
      Anime.deleteMany({}), Episode.deleteMany({}), Bookmark.deleteMany({}),
      User.deleteMany({}), Comment.deleteMany({})
    ]);

    await Promise.all([
      Anime.insertMany(animes), Episode.insertMany(episodes),
      (bookmarks && bookmarks.length > 0) ? Bookmark.insertMany(bookmarks) : Promise.resolve(),
      (users && users.length > 0) ? User.insertMany(users) : Promise.resolve(),
      (comments && comments.length > 0) ? Comment.insertMany(comments) : Promise.resolve()
    ]);

    res.send('Impor Berhasil! <a href="/admin">Kembali</a>');
  } catch (error) {
    res.status(500).send('Gagal impor: ' + error.message);
  }
});

app.get('/admin/anime', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skipVal = (page - 1) * limit;
    const searchQuery = req.query.search || '';
    const query = searchQuery ? { $or: [{ title: new RegExp(searchQuery, 'i') }, { pageSlug: new RegExp(searchQuery, 'i') }] } : {};
    
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ updatedAt: -1 }).skip(skipVal).limit(limit).lean(),
      Anime.countDocuments(query)
    ]);
    
    res.render('admin/anime-list', {
      animes, page: 'admin-anime-list', pageTitle: `Admin Anime List`,
      currentPage: page, totalPages: Math.ceil(totalCount / limit),
      baseUrl: searchQuery ? `/admin/anime?search=${encodeURIComponent(searchQuery)}` : '/admin/anime',
      searchQuery, pageDescription: '', pageImage: '', pageUrl: '', query: ''
    });
  } catch (error) {
    res.status(500).send('Error loading anime list.');
  }
});

app.get('/admin/anime/:slug/edit', isAdmin, async (req, res) => {
  try {
    const anime = await Anime.findOne({ pageSlug: decodeURIComponent(req.params.slug) }).lean();
    if (!anime) return res.status(404).send('Anime not found.');
    res.render('admin/edit-anime', {
      anime, page: 'admin-edit-anime', pageTitle: `Edit Anime`,
      pageDescription: '', pageImage: '', pageUrl: '', query: ''
    });
  } catch (error) { res.status(500).send('Error loading form.'); }
});

app.post('/admin/anime/:slug/delete', isAdmin, async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const anime = await Anime.findOne({ pageSlug }).lean();
    if (!anime) return res.status(404).send('Not found');

    await Episode.deleteMany({ animeSlug: pageSlug });
    await Anime.deleteOne({ pageSlug });
    
    if (anime.episodes) {
      const epIds = anime.episodes.map(e => e._id);
      await Comment.deleteMany({ episode: { $in: epIds } });
    }
    
    res.redirect('/admin/anime');
  } catch (error) { res.status(500).send(error.message); }
});

app.post('/admin/anime/:slug/edit', isAdmin, async (req, res) => {
  try {
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
    await Anime.findOneAndUpdate({ pageSlug: decodeURIComponent(req.params.slug) }, { $set: dataToUpdate }, { new: true });
    res.redirect('/admin/anime');
  } catch (error) { res.status(500).send('Error updating.'); }
});

app.get('/admin/episodes', isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 30;
    const skipVal = (page - 1) * limit;
    const [episodes, totalCount] = await Promise.all([
      Episode.find().sort({ updatedAt: -1 }).skip(skipVal).limit(limit).lean(),
      Episode.countDocuments()
    ]);
    res.render('admin/episode-list', {
      episodes, page: 'admin-episode-list', pageTitle: `Admin Episodes`,
      currentPage: page, totalPages: Math.ceil(totalCount / limit), baseUrl: '/admin/episodes',
      pageDescription: '', pageImage: '', pageUrl: '', query: ''
    });
  } catch (error) { res.status(500).send('Error loading list.'); }
});

app.post('/admin/api/remote-upload-lewd', isAdmin, async (req, res) => {
  req.setTimeout(30 * 60 * 1000);
  const { episodeSlug, videoUrl } = req.body;
  if (!episodeSlug || !videoUrl) return res.status(400).json({ success: false, error: 'Data kurang' });
  try {
    const newLewdUrl = await uploadVideoToLewdHost(videoUrl);
    const newStreamLink = { name: "LewdHost", url: newLewdUrl };
    await Episode.findOneAndUpdate({ episodeSlug }, { $push: { streaming: newStreamLink } }, { new: true });
    res.json({ success: true, newLink: newStreamLink });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/api/remote-upload', isAdmin, delay, async (req, res) => {
  const { episodeSlug, videoUrl } = req.body;
  const DOOD_API_KEY = process.env.DOOD_API_KEY;
  if (!episodeSlug || !videoUrl || !DOOD_API_KEY) return res.status(400).json({ success: false, error: 'Data kurang' });

  try {
    const doodRes = await axios.get(`https://doodapi.co/api/upload/url?key=${DOOD_API_KEY}&url=${encodeURIComponent(videoUrl)}`);
    if (doodRes.data.status !== 200 || !doodRes.data.result) throw new Error('DoodAPI Error');
    
    const fileCode = doodRes.data.result.filecode;
    const newStreamLink = { name: "Mirror", url: `https://dsvplay.com/e/${fileCode}` };
    const newDownloadLink = { host: "DoodStream", url: `https://dsvplay.com/d/${fileCode}` };
    
    await Episode.findOneAndUpdate(
      { episodeSlug },
      { $push: { streaming: newStreamLink, downloads: { quality: "480p", links: [newDownloadLink] } } },
      { new: true }
    );
    res.json({ success: true, newLink: newStreamLink });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/api/clear-mirrors-start', isAdmin, async (req, res) => {
  try {
    const result = await Episode.updateMany({}, {
      $pull: {
        streaming: { name: { $in: ["Mirror", "Viplay", "EarnVids"] } },
        downloads: { quality: { $in: ["Mirror", "Viplay", "EarnVids", "480p", "720p"] } }
      }
    });
    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/admin/batch-upload', isAdmin, (req, res) => res.render('admin/batch-upload', { page: 'admin', pageTitle: 'Batch Upload', pageDescription: '', pageImage: '', pageUrl: '', query: '' }));
app.get('/admin/clear-mirrors', isAdmin, (req, res) => res.render('admin/clear-mirrors', { page: 'admin', pageTitle: 'Clear Mirrors', pageDescription: '', pageImage: '', pageUrl: '', query: '' }));

app.get('/admin/reports', isAdmin, async (req, res) => {
  try {
    const reports = await Report.find().populate('user', 'username').sort({ createdAt: -1 }).lean();
    res.render('admin/reports', {
      reports, page: 'admin-reports', pageTitle: 'Laporan Error',
      pageDescription: '', pageImage: '', pageUrl: '', query: ''
    });
  } catch (error) { res.status(500).send('Gagal memuat laporan.'); }
});

app.post('/admin/report/delete/:id', isAdmin, async (req, res) => {
  try { await Report.findByIdAndDelete(req.params.id); res.redirect('/admin/reports'); }
  catch (error) { res.status(500).send('Gagal.'); }
});

app.get('/admin/episode/:slug(*)/edit', isAdmin, async (req, res) => {
  try {
    const episode = await Episode.findOne({ episodeSlug: "/" + decodeURIComponent(req.params.slug) }).lean();
    if (!episode) return res.status(404).send('Episode not found.');
    res.render('admin/edit-episode', {
      episode, page: 'admin-edit-episode', pageTitle: `Edit Episode`,
      pageDescription: '', pageImage: '', pageUrl: '', query: ''
    });
  } catch (error) { res.status(500).send('Error loading form.'); }
});

app.post('/admin/episode/:slug(*)/edit', isAdmin, async (req, res) => {
  try {
    const episodeSlug = "/" + decodeURIComponent(req.params.slug);
    const formData = req.body;
    const dataToUpdate = {
      title: formData.title, thumbnailUrl: formData.thumbnailUrl,
      createdAt: new Date(), updatedAt: new Date()
    };
    
    dataToUpdate.streaming = (formData.streams || []).filter(s => s.name && s.url).map(s => ({ name: s.name.trim(), url: s.url.trim() }));
    dataToUpdate.downloads = (formData.downloads || []).filter(q => q.quality && q.links.length).map(q => ({
      quality: q.quality.trim(), links: q.links.filter(l => l.host && l.url).map(l => ({ host: l.host.trim(), url: l.url.trim() }))
    }));

    Object.keys(dataToUpdate).forEach(key => {
      if (key !== 'createdAt' && key !== 'updatedAt' && (dataToUpdate[key] === undefined || dataToUpdate[key] === '')) delete dataToUpdate[key];
    });

    await Episode.findOneAndUpdate({ episodeSlug }, { $set: dataToUpdate }, { new: true, runValidators: true, timestamps: false });
    res.redirect('/admin/episodes');
  } catch (error) { res.status(500).send(error.message); }
});

app.post('/admin/episode/:slug(*)/delete', isAdmin, async (req, res) => {
  try {
    const episodeSlug = "/" + decodeURIComponent(req.params.slug);
    const episode = await Episode.findOne({ episodeSlug });
    await Episode.deleteOne({ episodeSlug });
    await Anime.updateOne({ "episodes.url": episodeSlug }, { $pull: { episodes: { url: episodeSlug } } });
    if (episode) await Comment.deleteMany({ episode: episode._id });
    res.redirect('/admin/episodes');
  } catch (error) { res.status(500).send(error.message); }
});

app.get('/admin/anime/add', isAdmin, (req, res) => res.render('admin/add-anime', { page: 'admin-add', pageTitle: 'Add Anime', pageDescription: '', pageImage: '', pageUrl: '', query: '' }));

app.post('/admin/anime/add', isAdmin, upload.single('animeImage'), async (req, res) => {
  try {
    const formData = req.body;
    if (!formData.title || !formData.pageSlug) return res.status(400).send('Judul/Slug wajib.');
    if (await Anime.findOne({ pageSlug: formData.pageSlug })) return res.status(400).send('Slug ada.');

    let imageUrl = formData.imageUrl || '/images/default.jpg';
    if (req.file) {
      try {
        imageUrl = await uploadToR2(req.file.buffer, `${formData.pageSlug}${path.extname(req.file.originalname)}`, req.file.mimetype);
      } catch (e) { throw new Error('Upload R2 Gagal'); }
    }

    await Anime.create({
      title: formData.title, pageSlug: formData.pageSlug, imageUrl, synopsis: formData.synopsis,
      info: { Alternatif: formData['info.Alternatif'], Type: formData['info.Type'], Status: formData['info.Status'] || 'Unknown', Released: formData['info.Released'] },
      genres: formData.genres ? formData.genres.split(',').map(g => g.trim()) : [], episodes: []
    });
    res.redirect('/admin/anime');
  } catch (error) { res.status(500).send(error.message); }
});

app.post('/admin/anime/:slug/episodes/add', isAdmin, async (req, res) => {
  const parentPageSlug = decodeURIComponent(req.params.slug);
  try {
    const { episodeTitle, episodeSlug, episodeDate } = req.body;
    if (await Episode.findOne({ episodeSlug })) return res.status(400).send('Slug Episode ada.');
    const parentAnime = await Anime.findOne({ pageSlug: parentPageSlug });
    if (!parentAnime) return res.status(404).send('Anime tidak ada.');

    const createdEpisode = await Episode.create({
      episodeSlug, title: episodeTitle, streaming: [], downloads: [], thumbnailUrl: '/images/default_thumb.jpg',
      animeTitle: parentAnime.title, animeSlug: parentAnime.pageSlug, animeImageUrl: parentAnime.imageUrl
    });

    await Anime.updateOne(
      { pageSlug: parentPageSlug },
      { $push: { episodes: { title: episodeTitle, url: episodeSlug, date: episodeDate || new Date().toLocaleDateString('id-ID'), _id: createdEpisode._id } } }
    );
    res.redirect(`/admin/anime/${encodeURIComponent(parentPageSlug)}/edit`);
  } catch (error) { res.status(500).send('Gagal.'); }
});

// --- PUBLIC ROUTES ---

app.get('/player', (req, res) => res.render('player', { layout: false }));

app.get('/random', async (req, res) => {
  try {
    const randomAnime = await Anime.aggregate([{ $sample: { size: 1 } }]);
    if (randomAnime[0]?.pageSlug) res.redirect(`/anime/${encodeURIComponent(randomAnime[0].pageSlug)}`);
    else res.redirect('/');
  } catch (e) { res.redirect('/'); }
});

app.get('/jadwal', (req, res) => res.render('jadwal', { page: 'jadwal', pageTitle: `Jadwal - ${siteName}`, pageDescription: '', pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl }));

app.get('/', (req, res) => res.render('landing', { page: 'landing', pageTitle: siteName, pageDescription: '', pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL, query: '' }));

app.get('/home', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * ITEMS_PER_PAGE;

    const [episodes, totalCount, latestSeries] = await Promise.all([
      Episode.find().sort({ updatedAt: -1 }).skip(skip).limit(20).lean(),
      Episode.countDocuments(),
      Anime.find().sort({ createdAt: -1 }).limit(12).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    res.render('home', {
      page: 'home', pageTitle: `${siteName} - AV Hentai Subtitle Indonesia`,
      pageDescription: 'NekoPoi Nonton anime hentai subtitle indonesia. Nikmati sensasi menonton anime hentai, ecchi, uncensored, sub indo kualitas video HD 1080p 720p 480p.',
      pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: SITE_URL + req.originalUrl,
      episodes: episodes.map(ep => ({
        watchUrl: `/anime${ep.episodeSlug}`, title: ep.title, imageUrl: ep.animeImageUrl || '/images/default.jpg',
        quality: '720p', year: new Date(ep.updatedAt || ep.createdAt).getFullYear().toString(), createdAt: ep.updatedAt || ep.createdAt
      })),
      latestSeries, currentPage: page, totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), baseUrl: '/home'
    });
  } catch (error) { res.status(500).send(error.message); }
});

app.get('/trending', async (req, res) => {
  try {
    const animes = await Anime.find().sort({ viewCount: -1 }).limit(20).lean();
    res.render('trending', {
      animes: encodeAnimeSlugs(animes), page: 'trending', pageTitle: `Trending - ${siteName}`,
      pageDescription: 'Populer', pageImage: `${SITE_URL}/images/default.jpg`, pageUrl: `${SITE_URL}/trending`, totalCount: animes.length
    });
  } catch (e) { res.status(500).send('Error.'); }
});

app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    const page = parseInt(req.query.page) || 1;
    if (!q) return res.redirect('/');
    
    const query = { title: new RegExp(q, 'i') };
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip((page - 1) * ITEMS_PER_PAGE).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);
    
    // Logic Judul & URL
    const titleSuffix = page > 1 ? ` - Halaman ${page}` : '';
    const pageTitle = `Cari: ${q}${titleSuffix} - ${siteName}`;
    const currentUrl = SITE_URL + `/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;

    res.render('list', {
      animes: encodeAnimeSlugs(animes), 
      pageTitle: pageTitle, 
      query: q, 
      page: 'list',
      pageDescription: '', pageImage: '', 
      pageUrl: currentUrl, // URL Dinamis
      currentPage: page,
      totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), 
      baseUrl: `/search?q=${encodeURIComponent(q)}`, 
      totalCount
    });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/genre/:genreSlug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    let allGenres = appCache.get('allGenres');
    if (!allGenres) { allGenres = await Anime.distinct('genres'); appCache.set('allGenres', allGenres); }
    
    // Cari nama genre asli
    const originalGenre = allGenres.find(g => slugify(g) === req.params.genreSlug);
    if (!originalGenre) return res.status(404).send('Genre not found');

    // Query Regex (Case Insensitive)
    const query = { genres: { $regex: new RegExp(`^${originalGenre}$`, 'i') } };

    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip((page - 1) * ITEMS_PER_PAGE).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);

    // SETUP VARIABLE TEXT
    const titleSuffix = page > 1 ? ` - Halaman ${page}` : '';
    const pageTitle = `Genre: ${originalGenre}${titleSuffix} - ${siteName}`;
    const pageUrl = SITE_URL + `/genre/${req.params.genreSlug}${page > 1 ? `?page=${page}` : ''}`;
    
    // DESKRIPSI BARU
    const description = `Kumpulan Hentai Subtitle Indonesia Genre ${originalGenre}${titleSuffix} Terbaru, Nekopoi, rajahentai, minioppai,subnime hanya di ${siteName}.`;

    res.render('list', {
      animes: encodeAnimeSlugs(animes), 
      pageTitle: pageTitle, 
      query: '', 
      page: 'list',
      pageDescription: description,
      pageImage: '', 
      pageUrl: pageUrl,
      currentPage: page,
      totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), 
      baseUrl: `/genre/${req.params.genreSlug}`, 
      totalCount
    });
  } catch (e) { res.status(500).send(e.message); }
});



app.get('/status/:statusSlug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    let allStatuses = appCache.get('allStatuses');
    if (!allStatuses) { allStatuses = await Anime.distinct('info.Status'); appCache.set('allStatuses', allStatuses); }

    const originalStatus = allStatuses.find(s => slugify(s) === req.params.statusSlug);
    if (!originalStatus) return res.status(404).send('Status not found');

    const query = { "info.Status": new RegExp(`^${originalStatus}$`, 'i') };
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip((page - 1) * ITEMS_PER_PAGE).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);

    // Logic Judul & URL
    const titleSuffix = page > 1 ? ` - Halaman ${page}` : '';
    const pageTitle = `Status: ${originalStatus}${titleSuffix} - ${siteName}`;
    const currentUrl = SITE_URL + `/status/${req.params.statusSlug}${page > 1 ? `?page=${page}` : ''}`;

     const description = `Kumpulan Hentai Subtitle Indonesia Status ${originalStatus}${titleSuffix} Terbaru, Nekopoi, rajahentai, minioppai,subnime hanya di ${siteName}.`;

    res.render('list', {
      animes: encodeAnimeSlugs(animes), 
      pageTitle: pageTitle, 
      query: '', 
      page: 'list',
      pageDescription: description,
      pageImage: '', 
      pageUrl: currentUrl, // URL Dinamis
      currentPage: page,
      totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), 
      baseUrl: `/status/${req.params.statusSlug}`, 
      totalCount
    });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/type/:typeSlug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    let allTypes = appCache.get('allTypes');
    if (!allTypes) { allTypes = await Anime.distinct('info.Type'); appCache.set('allTypes', allTypes); }

    const originalType = allTypes.find(t => slugify(t) === req.params.typeSlug);
    if (!originalType) return res.status(404).send('Type not found');

    const query = { "info.Type": new RegExp(`^${originalType}$`, 'i') };
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip((page - 1) * ITEMS_PER_PAGE).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);

    // Logic Judul & URL
    const titleSuffix = page > 1 ? ` - Halaman ${page}` : '';
    const pageTitle = `Type: ${originalType}${titleSuffix} - ${siteName}`;
    const currentUrl = SITE_URL + `/type/${req.params.typeSlug}${page > 1 ? `?page=${page}` : ''}`;
    const description = `Kumpulan Hentai Subtitle Indonesia Type ${originalType}${titleSuffix} Terbaru, Nekopoi, rajahentai, minioppai,subnime hanya di ${siteName}.`;

    res.render('list', {
      animes: encodeAnimeSlugs(animes), 
      pageTitle: pageTitle, 
      query: '', 
      page: 'list',
      pageDescription: description,
      pageImage: '', 
      pageUrl: currentUrl, // URL Dinamis
      currentPage: page,
      totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), 
      baseUrl: `/type/${req.params.typeSlug}`, 
      totalCount
    });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/studio/:studioSlug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    let allStudios = appCache.get('allStudios');
    if (!allStudios) { allStudios = await Anime.distinct('info.Studio'); appCache.set('allStudios', allStudios); }

    const originalStudio = allStudios.find(s => slugify(s) === req.params.studioSlug);
    if (!originalStudio) return res.status(404).send('Studio not found');

    const query = { "info.Studio": new RegExp(`^${originalStudio}$`, 'i') };
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip((page - 1) * ITEMS_PER_PAGE).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);

    // Logic Judul & URL
    const titleSuffix = page > 1 ? ` - Halaman ${page}` : '';
    const pageTitle = `Studio: ${originalStudio}${titleSuffix} - ${siteName}`;
    const currentUrl = SITE_URL + `/studio/${req.params.studioSlug}${page > 1 ? `?page=${page}` : ''}`;

    res.render('list', {
      animes: encodeAnimeSlugs(animes), 
      pageTitle: pageTitle, 
      query: '', 
      page: 'list',
      pageDescription: '', pageImage: '', 
      pageUrl: currentUrl, // URL Dinamis
      currentPage: page,
      totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), 
      baseUrl: `/studio/${req.params.studioSlug}`, 
      totalCount
    });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/tahun/:year', async (req, res) => {
  try {
    const year = req.params.year;
    const page = parseInt(req.query.page) || 1;
    const query = { "info.Released": new RegExp(year, 'i') };
    const [animes, totalCount] = await Promise.all([
      Anime.find(query).sort({ _id: -1 }).skip((page - 1) * ITEMS_PER_PAGE).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(query)
    ]);

    // Logic Judul & URL
    const titleSuffix = page > 1 ? ` - Halaman ${page}` : '';
    const pageTitle = `Tahun: ${year}${titleSuffix} - ${siteName}`;
    const currentUrl = SITE_URL + `/tahun/${year}${page > 1 ? `?page=${page}` : ''}`;
    const description = `Download Hentai Dari Tahun ${year}${titleSuffix} terbaru hanya di ${siteName}.`;

    res.render('list', {
      animes: encodeAnimeSlugs(animes), 
      pageTitle: pageTitle, 
      query: '', 
      page: 'list',
      pageDescription: description,
      pageImage: '', 
      pageUrl: currentUrl, // URL Dinamis
      currentPage: page,
      totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), 
      baseUrl: `/tahun/${year}`, 
      totalCount
    });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/hentai-list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const [animes, totalCount, latestSeries] = await Promise.all([
      Anime.find().sort({ _id: 1 }).skip((page - 1) * ITEMS_PER_PAGE).limit(ITEMS_PER_PAGE).lean(),
      Anime.countDocuments(),
      Anime.find().sort({ createdAt: -1 }).limit(12).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    // Logic Judul & URL
    const titleSuffix = page > 1 ? ` - Halaman ${page}` : '';
    const pageTitle = `Hentai List${titleSuffix} - ${siteName}`;
    const currentUrl = SITE_URL + `/hentai-list${page > 1 ? `?page=${page}` : ''}`;
    const description = `Kumpulan Hentai Subtitle Indonesia Terbaru, Nekopoi, rajahentai, minioppai,subnime, ${titleSuffix}${titleSuffix} terbaru hanya di ${siteName}.`;

    res.render('hentai-list', {
      animes: encodeAnimeSlugs(animes), 
      page: 'hentai-list', 
      pageTitle: pageTitle,
      pageDescription: description,
      pageImage: '', 
      pageUrl: currentUrl, // URL Dinamis
      currentPage: page,
      totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE), 
      baseUrl: '/hentai-list', 
      totalCount,
      latestSeries: encodeAnimeSlugs(latestSeries)
    });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/genre-list', async (req, res) => {
  try {
    let genres = appCache.get('allGenres');
    if (!genres) { genres = await Anime.distinct('genres'); appCache.set('allGenres', genres); }
    res.render('genre-list', { genres: genres.sort(), page: 'genre-list', pageTitle: 'Genre List', pageDescription: '', pageImage: '', pageUrl: '' });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/tahun-list', async (req, res) => {
  try {
    let dates = appCache.get('allReleasedDates');
    if (!dates) { dates = await Anime.distinct('info.Released'); appCache.set('allReleasedDates', dates); }
    const years = [...new Set(dates.map(d => d.match(/(\d{4})/) ? d.match(/(\d{4})/)[1] : null).filter(Boolean))].sort((a, b) => b - a);
    res.render('tahun-list', { years, page: 'tahun-list', pageTitle: 'Tahun Rilis', pageDescription: '', pageImage: '', pageUrl: '', totalCount: years.length });
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/anime/:animeId/:episodeNum', async (req, res) => {
  try {
    const episodeSlug = `/${req.params.animeId}/${req.params.episodeNum}`;
    
    // Ambil semua data yang diperlukan secara paralel
    const [episodeData, parentAnime, recommendations, latestSeries] = await Promise.all([
      Episode.findOne({ episodeSlug }).lean(),
      Anime.findOne({ "episodes.url": episodeSlug }).lean(),
      Anime.aggregate([{ $sample: { size: 7 } }]),
      Anime.find({}).sort({ createdAt: -1 }).limit(12).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    // Jika episode tidak ditemukan, tampilkan 404
    if (!episodeData) {
      return res.status(404).render('404', { 
        page: '404', pageTitle: '404 - Tidak Ditemukan', pageDescription: '', 
        pageImage: '', pageUrl: '', query: '' 
      });
    }

    // Update View Count Anime Induk (Tanpa mengubah timestamp update)
    if (parentAnime) {
      Anime.updateOne(
        { _id: parentAnime._id }, 
        { $inc: { viewCount: 1 } }, 
        { timestamps: false }
      ).exec().catch(() => {});
    }
    if (episodeData.streaming) {
      episodeData.streaming = episodeData.streaming.map(s => ({ 
        ...s, 
        url: s.url ? Buffer.from(s.url).toString('base64') : null 
      }));
    }
    if (episodeData.downloads) {
      episodeData.downloads = episodeData.downloads.map(q => ({ 
        ...q, 
        links: q.links.map(l => ({ ...l, url: l.url ? Buffer.from(l.url).toString('base64') : null })) 
      }));
    }
    const nav = { prev: null, next: null, all: null };
    if (parentAnime) {
      nav.all = `/anime/${parentAnime.pageSlug ? encodeURIComponent(parentAnime.pageSlug) : ''}`;
      const idx = parentAnime.episodes.findIndex(ep => ep.url === episodeSlug);
      
      if (idx > -1) {
        if (idx > 0) {
          nav.prev = { ...parentAnime.episodes[idx - 1], url: `/anime${parentAnime.episodes[idx - 1].url}` };
        }
        if (idx < parentAnime.episodes.length - 1) {
          nav.next = { ...parentAnime.episodes[idx + 1], url: `/anime${parentAnime.episodes[idx + 1].url}` };
        }
      }
    }
    res.render('nonton', {
      data: episodeData, 
      nav: nav, 
      recommendations: encodeAnimeSlugs(recommendations), 
      page: 'nonton',
      pageTitle: `${episodeData.title} Subtitle Indonesia - ${siteName}`,
      pageDescription: `Nonton ${episodeData.title} Subtitle Indonesia tersedia dalam berbagai resolusi, mulai dari 360p hingga 1080p, nekopoi,rajahentai,minioppi,subnime ${parentAnime?.synopsis || ''}`,
      pageImage: parentAnime?.imageUrl || '',
      pageUrl: SITE_URL + req.originalUrl, 
      parentAnime: parentAnime, 
      latestSeries: latestSeries
    });

  } catch (error) { 
    console.error("Nonton Error:", error);
    res.status(500).send(error.message); 
  }
});


app.get('/anime/:slug', async (req, res) => {
  try {
    const pageSlug = decodeURIComponent(req.params.slug);
    const [animeData, recommendations, latestSeries] = await Promise.all([
      Anime.findOne({ pageSlug }).lean(),
      Anime.aggregate([{ $match: { pageSlug: { $ne: pageSlug } } }, { $sample: { size: 8 } }]),
      Anime.find().sort({ createdAt: -1 }).limit(12).select('pageSlug imageUrl title info.Type info.Released info.Status').lean()
    ]);

    if (!animeData) return res.status(404).render('404', { page: '404', pageTitle: '404', pageDescription: '', pageImage: '', pageUrl: '', query: '' });
    Anime.updateOne({ pageSlug }, { $inc: { viewCount: 1 } }, { timestamps: false }).exec().catch(() => {});

    const [encodedMainData] = encodeAnimeSlugs([animeData]);
    encodedMainData.episodes = animeData.episodes?.map(ep => ({ ...ep, url: `/anime${ep.url}` })) || [];

    res.render('anime', {
      data: encodedMainData, 
      recommendations: encodeAnimeSlugs(recommendations), 
      page: 'anime',
      pageTitle: `${animeData.title} Subtitle Indonesia - ${siteName}`, 
      pageDescription: `Nonton ${animeData.title} Subtitle Indonesia di ${siteName}. kamu juga bisa download gratis ${animeData.title} Sub Indo, jangan lupa ya untuk nonton streaming online berbagai kualitas 720P 360P 240P 480P sesuai koneksi kamu untuk menghemat kuota internet, ${animeData.title} di ${siteName} MP4 MKV hardsub softsub subtitle bahasa Indonesia sudah terdapat di dalam video.`,
      pageImage: encodedMainData.imageUrl,
      pageUrl: SITE_URL + req.originalUrl, 
      latestSeries
    });
  } catch (error) { res.status(500).send(error.message); }
});


// --- LEGACY REDIRECTS ---
app.get('/category/:slug', (req, res) => res.redirect(301, `/anime/${req.params.slug}`));
app.get('/hentai/:slug', (req, res) => res.redirect(301, `/anime/${req.params.slug}`));
app.get('/trending/page/:page', (req, res) => res.redirect(301, '/trending'));
app.get('/anime-list/', (req, res) => res.redirect(301, '/hentai-list'));
app.get('/anime-list/page/:pageNumber(\\d+)/?', (req, res) => res.redirect(301, `/hentai-list?page=${req.params.pageNumber}`));
app.get('/genre/:slug/page/:pageNumber(\\d+)/?', (req, res) => res.redirect(301, `/genre/${req.params.slug}?page=${req.params.pageNumber}`));
app.get('/nonton/:slug', (req, res) => {
  const match = req.params.slug.match(/^(.+)-episode-(\d+)$/i);
  if (match) return res.redirect(301, `/anime/${match[1]}/${match[2]}`);
  res.redirect(301, '/');
});
app.get(/^\/(.+)-episode-(\d+)-subtitle-indonesia\/?$/, (req, res) => res.redirect(301, `/anime/${req.params[0]}/${parseInt(req.params[1], 10)}`));

app.get('/safelink', (req, res) => {
  if (!req.query.url) return res.status(404).render('404', { page: '404', pageTitle: '404', pageDescription: '', pageImage: '', pageUrl: '', query: '' });
  res.render('safelink', { page: 'safelink', pageTitle: 'Redirecting...', pageDescription: '', pageImage: '', pageUrl: '', query: '', base64Url: req.query.url });
});

app.get('/bookmarks', (req, res) => res.render('bookmarks', { animes: [], page: 'bookmarks', pageTitle: 'Bookmarks', pageDescription: '', pageImage: '', pageUrl: '', query: '' }));

// --- AUTH & USER API ---

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/bookmarks');
  res.render('login', { page: 'login', pageTitle: 'Login', pageDescription: '', pageImage: '', pageUrl: '', query: '', error: req.query.error });
});

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/bookmarks');
  res.render('register', { page: 'register', pageTitle: 'Register', pageDescription: '', pageImage: '', pageUrl: '', query: '', error: req.query.error });
});

app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (await User.findOne({ username: username.toLowerCase() })) return res.redirect('/register?error=Username taken');
    const user = new User({ username, password });
    await user.save();
    req.session.userId = user._id;
    req.session.username = user.username;
    res.redirect('/bookmarks');
  } catch (e) { res.redirect(`/register?error=${encodeURIComponent(e.message)}`); }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user || !(await user.comparePassword(password))) return res.redirect('/login?error=Invalid credentials');
    req.session.userId = user._id;
    req.session.username = user.username;
    res.redirect('/bookmarks');
  } catch (e) { res.redirect(`/login?error=${encodeURIComponent(e.message)}`); }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/home')));

app.get('/api/search', async (req, res) => {
  try {
    if (!req.query.q) return res.json([]);
    const animes = await Anime.find({ title: new RegExp(req.query.q, 'i') }).sort({ _id: -1 }).limit(5).select('title pageSlug imageUrl info.Type info.Status').lean();
    res.json(animes);
  } catch (e) { res.json([]); }
});

app.post('/api/report-error', isLoggedIn, async (req, res) => {
  try {
    await Report.create({ pageUrl: req.body.pageUrl, message: req.body.message, user: req.session.userId, status: 'Baru' });
    res.status(201).json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.use('/api/tahun-ini', checkApiReferer);
app.use('/api/genre/uncensored', checkApiReferer);

app.get('/api/tahun-ini', async (req, res) => {
  const cached = appCache.get('api_tahun_ini');
  if (cached) return res.json(cached);
  try {
    const animes = await Anime.find({ 'info.Released': new RegExp(new Date().getFullYear().toString()) }).sort({ createdAt: -1 }).limit(6).select('pageSlug imageUrl title genres').lean();
    appCache.set('api_tahun_ini', animes);
    res.json(animes);
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/genre/uncensored', async (req, res) => {
  const cached = appCache.get('api_genre_uncensored');
  if (cached) return res.json(cached);
  try {
    const animes = await Anime.find({ 'genres': /uncensored/i }).sort({ createdAt: -1 }).limit(6).select('pageSlug imageUrl title genres').lean();
    appCache.set('api_genre_uncensored', animes);
    res.json(animes);
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/bookmark-status', async (req, res) => {
  try {
    const { userId, animeId } = req.query;
    if (!userId || !mongoose.Types.ObjectId.isValid(animeId)) return res.json({ isBookmarked: false });
    const bookmark = await Bookmark.findOne({ userId, animeRef: animeId });
    res.json({ isBookmarked: !!bookmark });
  } catch (e) { res.status(500).json({ isBookmarked: false }); }
});

app.post('/api/bookmarks', async (req, res) => {
  try {
    const { userId, animeId } = req.body;
    await Bookmark.findOneAndUpdate({ userId, animeRef: animeId }, { $setOnInsert: { userId, animeRef: animeId } }, { upsert: true });
    res.json({ success: true, isBookmarked: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/bookmarks', async (req, res) => {
  try {
    const { userId, animeId } = req.query;
    await Bookmark.deleteOne({ userId, animeRef: animeId });
    res.json({ success: true, isBookmarked: false });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/my-bookmarks', async (req, res) => {
  try {
    if (!req.query.userId) return res.json([]);
    const bookmarks = await Bookmark.find({ userId: req.query.userId }).populate('animeRef', 'title pageSlug imageUrl episodes info.Released info.Status').sort({ createdAt: -1 }).lean();
    res.json(encodeAnimeSlugs(bookmarks.map(b => b.animeRef).filter(Boolean)));
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/bookmarks/all', async (req, res) => {
  try {
    await Bookmark.deleteMany({ userId: req.query.userId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.use('/api/v1', apiV1Routes);

// --- SEO & SITEMAPS ---

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /search\nDisallow: /safelink\nDisallow: /player\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap_index.xml`);
});

app.get('/sitemap_index.xml', (req, res) => {
  const lastMod = new Date().toISOString().split('T')[0];
  const sitemaps = ['sitemap-static.xml', 'sitemap-anime.xml', 'sitemap-episode.xml', 'sitemap-taxonomies.xml'];
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemaps.map(s => `<sitemap><loc>${SITE_URL}/${s}</loc><lastmod>${lastMod}</lastmod></sitemap>`).join('')}</sitemapindex>`);
});

app.get('/sitemap-static.xml', (req, res) => {
  const pages = [
    { url: '/', cf: 'monthly', p: '0.8' }, { url: '/home', cf: 'daily', p: '1.0' },
    { url: '/hentai-list', cf: 'daily', p: '0.9' }, { url: '/genre-list', cf: 'weekly', p: '0.7' },
    { url: '/tahun-list', cf: 'yearly', p: '0.7' }, { url: '/jadwal', cf: 'daily', p: '0.8' }
  ];
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p => `<url><loc>${SITE_URL}${p.url}</loc><lastmod>${new Date().toISOString().split('T')[0]}</lastmod><changefreq>${p.cf}</changefreq><priority>${p.p}</priority></url>`).join('')}</urlset>`);
});

app.get('/sitemap-anime.xml', async (req, res) => {
  res.header('Content-Type', 'application/xml');
  res.write('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  const cursor = Anime.find({}, 'pageSlug updatedAt').lean().cursor();
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    if (doc.pageSlug) res.write(`<url><loc>${SITE_URL}/anime/${encodeURIComponent(doc.pageSlug)}</loc><lastmod>${doc.updatedAt ? new Date(doc.updatedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`);
  }
  res.end('</urlset>');
});

app.get('/sitemap-episode.xml', async (req, res) => {
  res.header('Content-Type', 'application/xml');
  res.write('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  const cursor = Episode.find({}, 'episodeSlug updatedAt').lean().cursor();
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    if (doc.episodeSlug) res.write(`<url><loc>${SITE_URL}/anime${doc.episodeSlug}</loc><lastmod>${doc.updatedAt ? new Date(doc.updatedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  }
  res.end('</urlset>');
});

app.get('/sitemap-taxonomies.xml', async (req, res) => {
  let [genres, types, studios, dates] = [appCache.get('allGenres'), appCache.get('allTypes'), appCache.get('allStudios'), appCache.get('allReleasedDates')];
  if (!genres) genres = await Anime.distinct('genres');
  if (!types) types = await Anime.distinct('info.Type');
  if (!studios) studios = await Anime.distinct('info.Studio');
  if (!dates) dates = await Anime.distinct('info.Released');
  
  const years = [...new Set(dates.map(d => d.match(/(\d{4})/) ? d.match(/(\d{4})/)[1] : null).filter(Boolean))];
  let xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
  
  genres.forEach(g => xml += `<url><loc>${SITE_URL}/genre/${slugify(g)}</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`);
  types.forEach(t => xml += `<url><loc>${SITE_URL}/type/${slugify(t)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  studios.forEach(s => xml += `<url><loc>${SITE_URL}/studio/${slugify(s)}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  years.forEach(y => xml += `<url><loc>${SITE_URL}/tahun/${y}</loc><changefreq>yearly</changefreq><priority>0.6</priority></url>`);
  
  res.header('Content-Type', 'application/xml');
  res.send(xml + '</urlset>');
});

app.use((req, res) => res.status(404).render('404', { page: '404', pageTitle: '404 Not Found', pageDescription: '', pageImage: '', pageUrl: '', query: '' }));

if (!DB_URI) {
  console.error("FATAL: DB_URI missing.");
  process.exit(1);
}

const startServer = async () => {
  try {
    await mongoose.connect(DB_URI, { serverSelectionTimeoutMS: 30000 });
    console.log('Connected to MongoDB.');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to connect DB.', err);
    process.exit(1);
  }
};

startServer();