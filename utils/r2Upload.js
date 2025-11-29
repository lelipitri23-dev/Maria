const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Konfigurasi Client (Ambil dari .env)
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT, // Contoh: https://<accountid>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN; // Contoh: https://cdn.domainanda.com

/**
 * Mengupload buffer file ke Cloudflare R2
 * @param {Buffer} fileBuffer - Buffer dari file yang diupload (req.file.buffer)
 * @param {String} fileName - Nama file yang ingin disimpan (misal: slug.jpg)
 * @param {String} mimeType - Tipe konten (misal: image/jpeg)
 * @returns {Promise<String>} - URL publik gambar
 */
async function uploadToR2(fileBuffer, fileName, mimeType) {
  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileName,
      Body: fileBuffer,
      ContentType: mimeType,
      // ACL: 'public-read' // Cloudflare R2 biasanya mengatur akses via Bucket Policy, bukan ACL per file
    });

    await s3Client.send(command);

    // Kembalikan URL Publik
    // Pastikan R2_PUBLIC_DOMAIN tidak diakhiri slash '/' di .env, atau sesuaikan di sini
    return `${R2_PUBLIC_DOMAIN}/${fileName}`;
  } catch (error) {
    console.error("R2 Upload Error:", error);
    throw error;
  }
}

module.exports = { uploadToR2 };