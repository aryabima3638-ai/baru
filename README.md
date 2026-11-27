# 🤖 Flutter SC Builder (Telegram → APK / Web)

Bot Telegram yang menerima ZIP project Flutter lalu membuild **APK (Release/Debug)** atau **Web**.
Bot berjalan di **panel (Pterodactyl)**, proses compile dikerjakan **GitHub Actions (ubuntu-latest)**.

> Panel hanya menjalankan bot (ringan). Flutter/Android SDK TIDAK perlu ada di panel.

## Alur kerja
`ZIP (file/link, s/d 2GB)` → validasi aman → upload ke **GitHub Release** (asset maks 2GB) → workflow build → hasil APK/ZIP diambil → dikirim ke user → release & file sementara dihapus.

## File
| File | Fungsi |
|---|---|
| `index.js` | Menu utama, role, credit, maintenance, command |
| `package.json` | Dependency & `npm start` untuk panel |
| `telegram.js` | **ID owner Telegram** (hanya ID ini yang boleh maintenance) |
| `setting.js` | Token bot, foto URL, channel, GitHub, limit |
| `lib/builder.js` | Siklus job, progres nyata, log error, refund, anti-stuck |
| `lib/github.js` | Release, upload 2GB, dispatch, polling Actions |
| `lib/zip.js` | Validasi ZIP (zip-slip, symlink, enkripsi, ukuran) |
| `lib/db.js` | Database JSON atomik (user, role, credit) |
| `.github/workflows/build.yml` | Workflow build (di-push otomatis ke repo oleh bot) |

## Instalasi
1. **Buat bot** di @BotFather → salin token.
2. **Buat channel**, jadikan bot **admin** channel.
3. **Buat repo GitHub** (boleh private) dan isi minimal 1 commit (mis. README).
4. **Buat token GitHub**: Classic PAT scope `repo` + `workflow` (atau fine-grained: Contents, Actions, Workflows = Read & Write).
5. Edit **`telegram.js`** → ID Telegram owner. Edit **`setting.js`** → token bot, `photoUrl`, `channel`, `github`.
6. Upload semua file ke panel. Egg **Node.js 18 atau lebih baru**. Startup: `npm install && node index.js` (atau `npm start`).
7. Saat start, bot otomatis memasang/memperbarui `build.yml` di repo. Cek log: `[GitHub] build.yml dibuat`.

## Role & Command
| Role | Hak |
|---|---|
| 👤 Member | Semua fitur build, **5 credit gratis**; habis → reset 24 jam |
| 💼 Reseller | Build **unlimited** + `/addcredit` |
| 👑 Owner | Semua + `/address`, `/addowner`, maintenance, broadcast |

- `/addcredit ID [jumlah]` — reseller & owner (default 5; reseller maks 100/command)
- `/address ID` — owner: naikkan member → reseller
- `/addowner ID` — owner: jadikan owner
- `/delreseller ID`, `/broadcast teks`, `/maintenance on|off`, `/id`, `/menu`, `/cancel`
- User biasa yang memakai command terlarang mendapat teks **WARNING**.

## Maintenance
Dinyalakan dari **Panel Owner** atau `/maintenance on` — **hanya ID di `telegram.js`**. Semua build yang sedang jalan dihentikan (run GitHub dibatalkan), credit dikembalikan, user melihat:
`MAAF BOT SEDANG DITUTUP OLEH OWNER DIKARENAKAN ADA SEDIKIT MASALAH`
Build baru ditolak sampai maintenance dimatikan.

## ZIP besar (sampai 2GB)
- Lewat **link direct download** (http/https): sampai ~2GB. ✔ (tanpa setup tambahan)
- Lewat **upload langsung di Telegram**: Bot API biasa hanya bisa mengunduh **20MB**. `api_id/api_hash` saja tidak menaikkan batas ini. Untuk 2GB langsung, jalankan **Local Bot API Server** lalu isi `telegramApiRoot` + `localBotApi: true`.
- Hasil APK > 49MB dikirim sebagai **link GitHub** (butuh repo public).

## Jika build gagal
Bot mengirim: tahap yang gagal, **penyebab (potongan error Gradle/Flutter)**, dan file **log lengkap** (4000 baris terakhir). Token disamarkan otomatis. Credit dikembalikan (atur `refundOnBuildError`).

## Troubleshooting
| Gejala | Solusi |
|---|---|
| `401 Bad credentials` | Token GitHub salah / kedaluwarsa |
| `404` saat dispatch | Repo kosong, nama repo salah, atau token tanpa scope `workflow` |
| Verifikasi gagal | Bot belum admin di channel / `channel.id` salah |
| Workflow tidak muncul | Aktifkan Actions di repo (Settings → Actions) |
| `Gradle` / `compileSdk` error | Lihat log; sering karena dependency project lama vs Flutter stable terbaru |
| Bot tidak jalan | Pastikan Node ≥ 18 dan `npm install` sukses |
