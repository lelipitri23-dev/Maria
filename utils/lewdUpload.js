const axios = require('axios');
const FormData = require('form-data');

async function uploadVideoToLewdHost(videoUrl) {
  try {
    // Pastikan token ada di .env
    if (!process.env.LEWD_HOST_TOKEN) {
      throw new Error('LEWD_HOST_TOKEN tidak ditemukan di .env');
    }

    console.log(`[LewdHost] Memulai stream dari: ${videoUrl}`);

    // 1. Request Stream dari Source
    const sourceResponse = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream' // PENTING: Streaming mode
    });

    // 2. Deteksi Ekstensi
    let extension = 'mp4';
    const contentType = sourceResponse.headers['content-type'];
    if (contentType && contentType.includes('video/')) {
        extension = contentType.split('/')[1].split(';')[0];
    } else if (videoUrl.includes('.mkv')) {
        extension = 'mkv';
    }

    // 3. Siapkan Form Data
    const form = new FormData();
    form.append('files[]', sourceResponse.data, {
      filename: `vid_${Date.now()}.${extension}`,
      contentType: contentType || 'video/mp4'
    });

    // 4. Upload ke Lewd.host
    const uploadResponse = await axios.post('https://lewd.host/api/upload', form, {
      headers: {
        ...form.getHeaders(),
        'token': process.env.LEWD_HOST_TOKEN
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const result = uploadResponse.data;

    if (result.success && result.files && result.files.length > 0) {
      console.log(`[LewdHost] Sukses: ${result.files[0].url}`);
      return result.files[0].url;
    } else {
      throw new Error('Gagal upload: Response API Lewd.host tidak valid.');
    }

  } catch (error) {
    console.error('[LewdHost] Error:', error.message);
    throw error; // Lempar error ke server.js untuk ditangani
  }
}

module.exports = { uploadVideoToLewdHost };
