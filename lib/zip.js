const yauzl = require('yauzl');

// Validasi ZIP tanpa mengekstrak (aman untuk ZIP besar): cek path traversal,
// symlink, enkripsi, jumlah file, total ukuran, dan cari pubspec.yaml.
function validateZip(file, { maxEntries, maxUncompressed }) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: false }, (err, zf) => {
      if (err) return reject(new Error('ZIP rusak / bukan file ZIP valid: ' + err.message));
      let n = 0, total = 0, pub = null, hasAndroid = false, hasMain = false, done = false;

      const fail = (m) => {
        if (done) return;
        done = true;
        try { zf.close(); } catch {}
        reject(new Error(m));
      };

      zf.on('error', (e) => fail('ZIP rusak: ' + e.message));
      zf.on('end', () => {
        if (done) return;
        done = true;
        if (!pub) return reject(new Error('pubspec.yaml tidak ditemukan di dalam ZIP. Pastikan ini project Flutter.'));
        resolve({ entries: n, uncompressed: total, pubspec: pub, hasAndroid, hasMain });
      });
      zf.on('entry', (e) => {
        n++;
        if (n > maxEntries) return fail(`Jumlah file terlalu banyak (>${maxEntries}).`);
        const name = e.fileName.replace(/\\/g, '/');
        if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
          return fail(`ZIP berisi path berbahaya: ${name.slice(0, 80)}`);
        }
        if (e.isEncrypted()) return fail('ZIP terenkripsi / pakai password tidak didukung.');
        const mode = (e.externalFileAttributes >>> 16) & 0xf000;
        if (mode === 0xa000) return fail(`ZIP berisi symlink (tidak diizinkan): ${name.slice(0, 80)}`);
        total += e.uncompressedSize;
        if (total > maxUncompressed) return fail('Total ukuran setelah ekstrak terlalu besar.');

        if (!name.startsWith('__MACOSX')) {
          const depth = name.split('/').length;
          if (/(^|\/)pubspec\.yaml$/.test(name) && depth <= 5 && !/(^|\/)\./.test(name)) {
            if (!pub || name.length < pub.length) pub = name;
          }
          if (/(^|\/)android\/app\/build\.gradle(\.kts)?$/.test(name)) hasAndroid = true;
          if (/(^|\/)lib\/main\.dart$/.test(name)) hasMain = true;
        }
        zf.readEntry();
      });
      zf.readEntry();
    });
  });
}

module.exports = { validateZip };
