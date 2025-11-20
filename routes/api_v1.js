const express = require('express');
const router = express.Router();
const Anime = require('../models/Anime');
const Episode = require('../models/Episode');

// Impor helper yang baru kita buat
const { encodeAnimeSlugs } = require('../utils/helpers');

// Definisikan konstanta yang relevan
const ITEMS_PER_PAGE = 20;

// ==========================================================
// == API V1 (UNTUK FLUTTER/EXTERNAL) ==
// ==========================================================
router.get('/home', async (req, res) => {
 try {
  const limit = ITEMS_PER_PAGE || 20; // Menambahkan fallback
 
  const page = parseInt(req.query.page) || 1;
  const skip = (page - 1) * limit;
 
  const latestSeriesQuery = Anime.find({})
   .sort({ createdAt: -1 })
   .limit(7)
   .select('pageSlug imageUrl title info.Type info.Released info.Status')
   .lean();
   
  const episodesQuery = Episode.find({})
   .sort({ createdAt: -1 })
   .skip(skip)
   .limit(18)
   .lean();
 
  const totalEpisodesQuery = Episode.countDocuments({});
 
  const [episodes, totalCount, latestSeries] = await Promise.all([
   episodesQuery,
   totalEpisodesQuery,
   latestSeriesQuery
  ]);
 
  const totalPages = Math.ceil(totalCount / limit);
 
    // Gunakan helper 'encodeAnimeSlugs' untuk URL gambar yang benar
    const encodedLatestSeries = encodeAnimeSlugs(latestSeries);

  const formattedEpisodes = episodes.map(ep => {
   let duration = '??:??';
   if (ep.duration) {
    duration = ep.duration.replace('PT', '').replace('H', ':').replace('M', ':').replace('S', '');
   }
      // Pastikan URL gambar juga di-encode
      const [ encodedEp ] = encodeAnimeSlugs([{ imageUrl: ep.animeImageUrl || '/images/default.jpg' }]);

   return {
    watchUrl: `/anime${ep.episodeSlug}`, 
    title: ep.title,
    imageUrl: encodedEp.imageUrl, // Gunakan URL yang sudah di-encode
    duration: duration,
    quality: '720p',
    year: new Date(ep.createdAt).getFullYear().toString(),
    createdAt: ep.createdAt
   };
  });
 
  res.json({
   episodes: formattedEpisodes,
   latestSeries: encodedLatestSeries, 
   pagination: {
     currentPage: page,
     totalPages: totalPages,
     totalEpisodes: totalCount
   }
  });
 
 } catch (error) {
  console.error("API Home Error:", error);
  res.status(500).json({ error: 'Gagal memuat homepage.' });
 }
});

router.get('/anime/:slug', async (req, res) => {
 try {
  const pageSlug = decodeURIComponent(req.params.slug);
  const animeData = await Anime.findOne({ pageSlug: pageSlug }).lean();
  if (!animeData) {
   return res.status(404).json({ error: 'Anime tidak ditemukan.' });
  }
  const animeWithFullUrls = { ...animeData, episodes: animeData.episodes.map(ep => ({ ...ep, url: ep.url })) };
  const [encodedData] = encodeAnimeSlugs([animeWithFullUrls]);
  res.json(encodedData);
 } catch (error) {
  console.error(`API Detail Anime Error (${req.params.slug}):`, error);
  res.status(500).json({ error: 'Gagal memuat data anime.' });
 }
});

router.get('/search', async (req, res) => {
 try {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 24; 
  const skip = (page - 1) * limit;
  if (!query) {
   return res.status(400).json({ error: 'Query pencarian (q) diperlukan.' });
  }
  const searchRegex = new RegExp(query, 'i');
  const [results, totalCount] = await Promise.all([
   Anime.find({ title: searchRegex })
    .select('pageSlug title imageUrl info.Status')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean(),
   Anime.countDocuments({ title: searchRegex })
  ]);
  const totalPages = Math.ceil(totalCount / limit);
  const encodedResults = encodeAnimeSlugs(results);
  res.json({
   pagination: { currentPage: page, totalPages: totalPages, totalResults: totalCount },
   results: encodedResults
  });
 } catch (error) {
  console.error("API Search Error:", error);
  res.status(500).json({ error: 'Gagal melakukan pencarian.' });
 }
});

router.get('/episode/:animeId/:episodeNum', async (req, res) => {
 try {
  const { animeId, episodeNum } = req.params;
  const episodeSlug = `/${animeId}/${episodeNum}`; 
  const episodeData = await Episode.findOne({ episodeSlug: episodeSlug }).lean();
  if (!episodeData) {
   console.error(`API Gagal mendapatkan data episode dari DB untuk slug: ${episodeSlug}`);
   return res.status(404).json({ error: 'Episode tidak ditemukan.' });
  }
  const filteredStreams = episodeData.streaming
   ? episodeData.streaming.filter(stream => stream.name.toLowerCase() !== 'bonus')
   : [];
    // Encode thumbnail URL
    const [ encodedEp ] = encodeAnimeSlugs([{ imageUrl: episodeData.thumbnailUrl }]);

  res.json({
   title: episodeData.title,
   animeTitle: episodeData.animeTitle,
   animeSlug: episodeData.animeSlug,
   thumbnailUrl: encodedEp.imageUrl, // URL yang sudah di-encode
   duration: episodeData.duration,
   streaming: filteredStreams, 
   downloads: episodeData.downloads
  });
 } catch (error) {
  const episodeSlugForError = `/${req.params.animeId}/${req.params.episodeNum}`;
  console.error(`API Watch Episode Error (${episodeSlugForError}):`, error);
  res.status(500).json({ error: 'Gagal memuat data episode.' });
 }
});

// Fungsi helper ini sekarang lokal untuk file router ini
async function handleTaxonomyRequest(req, res, filter, pageTitle) {
 try {
  const page = parseInt(req.query.page) || 1;
  const limit = 24; 
  const skip = (page - 1) * limit;
  const [results, totalCount] = await Promise.all([
   Anime.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .select('pageSlug title imageUrl info.Status')
    .lean(),
   Anime.countDocuments(filter)
  ]);
  const totalPages = Math.ceil(totalCount / limit);
  const encodedResults = encodeAnimeSlugs(results);
  res.json({
   title: pageTitle,
   pagination: { currentPage: page, totalPages: totalPages, totalResults: totalCount },
   results: encodedResults
  });
 } catch (error) {
  console.error(`API Taxonomy Error (${pageTitle}):`, error);
  res.status(500).json({ error: 'Gagal mengambil data.' });
 }
}

router.get('/genre/:genreSlug', (req, res) => {
 const genreName = req.params.genreSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
 const filter = { genres: genreName };
 handleTaxonomyRequest(req, res, filter, `Genre: ${genreName}`);
});

router.get('/status/:statusSlug', (req, res) => {
 const statusName = req.params.statusSlug.charAt(0).toUpperCase() + req.params.statusSlug.slice(1);
 const filter = { 'info.Status': statusName };
 handleTaxonomyRequest(req, res, filter, `Status: ${statusName}`);
});

router.get('/type/:typeSlug', (req, res) => {
 const typeName = req.params.typeSlug.toUpperCase();
 const filter = { 'info.Type': typeName };
 handleTaxonomyRequest(req, res, filter, `Tipe: ${typeName}`);
});

router.get('/tahun/:year', (req, res) => {
 const year = req.params.year;
 const yearRegex = new RegExp(year);
 const filter = { 'info.Released': yearRegex };
 handleTaxonomyRequest(req, res, filter, `Tahun: ${year}`);
});

// Ekspor router agar bisa digunakan di server.js
module.exports = router;