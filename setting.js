// ============================================================
//  setting.js  -  SEMUA PENGATURAN BOT (isi sebelum start)
// ============================================================
const path = require('path');
const { owners } = require('./telegram.js');

module.exports = {
  // ---- Telegram ----
  botToken: 'ISI_TOKEN_BOT_DARI_BOTFATHER',
  owners, // diambil dari telegram.js
  ownerUsername: '@polisiband', // tampil di pesan credit habis

  // Foto/logo: tampil saat /start, setelah user berhasil join channel,
  // dan dikirim ke channel saat ada user baru. Isi URL gambar langsung (jpg/png).
  photoUrl: 'https://example.com/logo.jpg',

  // Channel wajib join. Bot HARUS jadi admin di channel ini.
  // id: '@usernamechannel' atau '-100xxxxxxxxxx'
  channel: {
    id: '@usernamechannel',
    url: 'https://t.me/usernamechannel',
  },

  // ---- GitHub Actions (tempat build sebenarnya) ----
  // Buat repo (boleh private), isi minimal 1 commit (mis. README).
  // Token: Classic PAT scope "repo" + "workflow"
  //   atau Fine-grained: Contents RW, Actions RW, Workflows RW.
  github: {
    token: 'ISI_GITHUB_TOKEN',
    owner: 'ISI_USERNAME_GITHUB',
    repo: 'ISI_NAMA_REPO',
    branch: 'main',
    workflow: 'build.yml',
  },

  // ---- Telegram Bot API ----
  // Bawaan: https://api.telegram.org  (download file maks 20MB, upload hasil maks ~49MB)
  // Jika kamu punya Local Bot API Server (--local), isi URL-nya & set localBotApi: true
  // supaya ZIP sampai 2GB bisa dikirim langsung lewat Telegram.
  telegramApiRoot: 'https://api.telegram.org',
  localBotApi: false,

  // ---- Credit / Role ----
  freeCredits: 5, // credit gratis member
  creditResetHours: 24, // credit habis -> reset setelah X jam
  resellerMaxPerCommand: 100, // batas credit per /addcredit untuk reseller
  defaultAddCredit: 5, // jumlah jika /addcredit tanpa angka
  refundOnBuildError: true, // credit dikembalikan juga jika build gagal karena kode project

  // ---- Build ----
  maxConcurrentBuilds: 3,
  buildTimeoutMinutes: 85,
  retainHours: 24, // release GitHub lama dibersihkan otomatis
  limits: {
    maxZipBytes: 2 * 1024 * 1024 * 1024 - 8 * 1024 * 1024, // batas asset GitHub = 2GB
    maxEntries: 300000,
    maxUncompressedBytes: 10 * 1024 * 1024 * 1024,
  },

  // ---- Path (absolut) ----
  workspaceRoot: path.resolve(__dirname, 'builds'),
  dbFile: path.resolve(__dirname, 'data', 'db.json'),
};
