const fs = require('fs');
const http = require('http');
const https = require('https');

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

// Download streaming ke file, ikut redirect, bisa dibatalkan, ada batas ukuran.
function download(url, dest, { headers = {}, maxBytes = Infinity, onProgress, signal, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Terlalu banyak redirect'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('URL tidak valid')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Hanya link http/https yang didukung'));
    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u);
        const h = { ...headers };
        if (next.host !== u.host) delete h.Authorization; // jangan bocorkan token ke host lain
        return resolve(download(next.toString(), dest, { headers: h, maxBytes, onProgress, signal, redirects: redirects + 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Server membalas HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      if (total > maxBytes) {
        res.destroy();
        return reject(new Error(`File ${fmtBytes(total)} melebihi batas ${fmtBytes(maxBytes)}`));
      }
      const out = fs.createWriteStream(dest);
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (got > maxBytes) return req.destroy(new Error('File melebihi batas ukuran'));
        if (onProgress) onProgress(got, total);
      });
      res.on('aborted', () => reject(new Error('Koneksi download terputus')));
      res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', () => {
        if (total && got < total) return reject(new Error('Download tidak lengkap'));
        resolve(got);
      });
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout koneksi (60 detik tanpa data)')));
    if (signal) {
      const onAbort = () => req.destroy(new Error('Dibatalkan'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

module.exports = { esc, sleep, fmtBytes, fmtDur, download };
