const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Ambil Account ID dari Environment Variables
const accountId = process.env.R2_ACCOUNT_ID;

// Validasi agar tidak bingung saat error
if (!accountId) {
  // Jika ini muncul di logs Vercel, berarti Env Var R2_ACCOUNT_ID belum masuk/salah ketik
  throw new Error("R2_ACCOUNT_ID belum diset di Environment Variables Vercel."); 
}

// Konfigurasi Client
const s3Client = new S3Client({
  region: 'auto',
  // --- BAGIAN PENTING ---
  // Kita susun URL endpoint secara manual menggunakan Account ID
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN; 

/**
 * Mengupload buffer file ke Cloudflare R2
 */
async function uploadToR2(fileBuffer, fileName, mimeType) {
  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileName,
      Body: fileBuffer,
      ContentType: mimeType,
    });

    await s3Client.send(command);

    // Kembalikan URL Publik
    // Logika: Jika R2_PUBLIC_DOMAIN ada, pakai itu. 
    // Pastikan tidak ada double slash (//) di antara domain dan nama file.
    if (R2_PUBLIC_DOMAIN) {
        const cleanDomain = R2_PUBLIC_DOMAIN.replace(/\/$/, ''); // Hapus slash di akhir jika ada
        return `${cleanDomain}/${fileName}`;
    } else {
        throw new Error("R2_PUBLIC_DOMAIN belum diset di Environment Variables.");
    }

  } catch (error) {
    console.error("R2 Upload Error:", error);
    throw error; // Lempar error agar ditangkap oleh server.js
  }
}

module.exports = { uploadToR2 };
