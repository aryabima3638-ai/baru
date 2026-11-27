const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { esc, sleep, fmtBytes, fmtDur, download } = require('./util');
const { validateZip } = require('./zip');

class AbortError extends Error { constructor(reason) { super('aborted:' + reason); this.reason = reason; } }
class BuildError extends Error { constructor(msg, o = {}) { super(msg); Object.assign(this, o); } }

const MAINT_TEXT = 'MAAF BOT SEDANG DITUTUP OLEH OWNER DIKARENAKAN ADA SEDIKIT MASALAH';

function createBuilder({ tg, db, cfg, gh }) {
  const jobs = new Map();
  const root = path.resolve(cfg.workspaceRoot);
  fs.mkdirSync(root, { recursive: true });
  const tgLimit = cfg.localBotApi ? 1900 * 1024 * 1024 : 49 * 1024 * 1024;
  const secrets = [cfg.botToken, cfg.github.token].filter(Boolean);
  const scrub = (t) => secrets.reduce((s, x) => s.split(x).join('***'), String(t));

  const label = (j) => (j.target === 'web' ? '🌐 Flutter Web' : `🐦 Flutter APK ${j.mode === 'debug' ? 'Debug 🐞' : 'Release 🚀'}`);
  const ICON = { wait: '⬜', run: '⏳', ok: '✅', fail: '❌' };

  // ---------- tampilan progres (hanya tahap nyata) ----------
  function stage(job, name, s, extra) {
    let st = job.local.find((x) => x.n === name);
    if (!st) { st = { n: name }; job.local.push(st); }
    st.s = s; st.x = extra || '';
    refresh(job);
  }
  function ghIcon(s) {
    if (s.status === 'completed') return { success: '✅', failure: '❌', skipped: '⏭', cancelled: '🚫' }[s.conclusion] || '✅';
    return s.status === 'in_progress' ? '⏳' : '⬜';
  }
  function render(job) {
    const lines = job.local.map((s) => `${ICON[s.s]} ${esc(s.n)}${s.x ? ` <i>${esc(s.x)}</i>` : ''}`);
    (job.gh || []).forEach((s) => lines.push(`${ghIcon(s)} ${esc(s.name)}`));
    return `🔨 <b>BUILD BERJALAN</b>\n━━━━━━━━━━━━━━\n🆔 <code>${job.id}</code>\n📦 ${label(job)}\n⏱ ${fmtDur(Date.now() - job.t0)}\n━━━━━━━━━━━━━━\n${lines.join('\n')}`;
  }
  const cancelKb = (job) => ({ inline_keyboard: [[{ text: '❌ Batalkan Build', callback_data: 'cancel:' + job.id }]] });
  async function edit(job, text, kb) {
    try { await tg.editMessageText(job.chatId, job.msgId, undefined, text, { parse_mode: 'HTML', reply_markup: kb }); }
    catch (e) { if (!/not modified|429|Too Many|message to edit not found/i.test(e.message)) console.error('[edit]', e.message); }
  }
  function refresh(job, force) {
    if (job.done) return;
    const now = Date.now();
    if (!force && now - (job.lastEdit || 0) < 3000) return;
    const t = render(job);
    if (t === job.lastText) return;
    job.lastText = t; job.lastEdit = now;
    edit(job, t, cancelKb(job));
  }
  const send = (chatId, text, extra = {}) => tg.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra }).catch((e) => console.error('[send]', e.message));

  // ---------- util job ----------
  const checkAbort = (job) => { if (job.aborted) throw new AbortError(job.aborted); };
  async function wait(job, ms) { await sleep(ms); checkAbort(job); }

  async function fetchSource(job, zipPath) {
    const onProgress = (g, t) => stage(job, 'Unduh ZIP', 'run', t ? `${fmtBytes(g)} / ${fmtBytes(t)}` : fmtBytes(g));
    const opts = { maxBytes: cfg.limits.maxZipBytes, onProgress, signal: job.ac.signal };
    if (job.source.type === 'url') return download(job.source.url, zipPath, { ...opts, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const f = await tg.getFile(job.source.fileId);
    if (path.isAbsolute(f.file_path)) { // Local Bot API server
      await fsp.copyFile(f.file_path, zipPath);
      return (await fsp.stat(zipPath)).size;
    }
    return download(`${cfg.telegramApiRoot.replace(/\/$/, '')}/file/bot${cfg.botToken}/${f.file_path}`, zipPath, opts);
  }

  async function waitRun(job) {
    let run = null;
    for (let i = 0; i < 40 && !run; i++) {
      checkAbort(job);
      run = await gh.findRun(job.id).catch(() => null);
      if (!run) await wait(job, 3000);
    }
    if (!run) throw new BuildError('Workflow tidak muncul di GitHub Actions. Pastikan Actions aktif di repo dan token punya scope "workflow".');
    job.runId = run.id;
    stage(job, 'Menjalankan workflow', 'run', 'GitHub Actions');
    const started = Date.now();
    let errs = 0;
    for (;;) {
      checkAbort(job);
      if (Date.now() - started > cfg.buildTimeoutMinutes * 60e3) {
        await gh.cancelRun(run.id);
        throw new BuildError(`Build melebihi batas waktu ${cfg.buildTimeoutMinutes} menit dan dihentikan.`);
      }
      try {
        run = await gh.getRun(run.id);
        const js = await gh.getJobs(run.id);
        if (js[0]) {
          job.ghJob = js[0];
          job.gh = (js[0].steps || []).filter((s) => !/^(Set up job|Complete job|Post )/.test(s.name));
        }
        errs = 0;
        refresh(job);
        if (run.status === 'completed') return run;
      } catch (e) {
        if (++errs >= 8) throw new BuildError('Gagal memantau GitHub Actions berulang kali: ' + e.message);
      }
      await wait(job, 5000);
    }
  }

  function extractReason(log) {
    const lines = log.split('\n');
    let i = lines.findIndex((l) => /What went wrong|FAILURE:/.test(l));
    if (i < 0) i = lines.findIndex((l) => /(Error:|error:|ERROR:|Exception|Execution failed|Could not|Unhandled)/.test(l));
    if (i < 0) return lines.slice(-30).join('\n');
    return lines.slice(Math.max(0, i - 2), i + 28).join('\n');
  }

  async function collectLog(job) {
    let text = '';
    try {
      const rel = await gh.getRelease(job.release.id);
      const a = (rel.assets || []).find((x) => x.name === 'log.txt');
      if (a) { const p = path.join(job.dir, 'log.txt'); await gh.downloadAsset(a, p, {}); text = await fsp.readFile(p, 'utf8'); }
    } catch {}
    if (!text && job.ghJob) {
      try { const p = path.join(job.dir, 'joblog.txt'); await gh.downloadJobLog(job.ghJob.id, p); text = (await fsp.readFile(p, 'utf8')).split('\n').slice(-4000).join('\n'); } catch {}
    }
    return scrub(text);
  }

  async function reportFailure(job, run) {
    const failed = (job.gh || []).find((s) => s.conclusion === 'failure');
    const log = await collectLog(job);
    const reason = log ? extractReason(log) : 'Log tidak berhasil diambil dari GitHub.';
    const link = run?.html_url ? `\n🔗 <a href="${esc(run.html_url)}">Lihat run di GitHub</a>` : '';
    const msg = `❌ <b>BUILD GAGAL</b>\n🆔 <code>${job.id}</code> • ${label(job)}\n🧱 Tahap gagal: <b>${esc(failed?.name || 'tidak diketahui')}</b>\n\n<b>Penyebab:</b>\n<pre>${esc(reason.slice(0, 2600))}</pre>${link}`;
    await send(job.chatId, msg, { disable_web_page_preview: true });
    if (log) {
      const p = path.join(job.dir, `log-${job.id}.txt`);
      await fsp.writeFile(p, log);
      await tg.sendDocument(job.chatId, { source: fs.createReadStream(p), filename: `log-${job.id}.txt` }, { caption: '📄 Log lengkap build (4000 baris terakhir)' }).catch((e) => console.error('[log]', e.message));
    }
  }

  // ---------- alur utama ----------
  async function run(job) {
    let refund = true, outcome = 'failed';
    try {
      // 1. unduh
      stage(job, 'Unduh ZIP', 'run');
      const zip = path.join(job.dir, 'project.zip');
      const size = await fetchSource(job, zip);
      checkAbort(job);
      stage(job, 'Unduh ZIP', 'ok', fmtBytes(size));

      // 2. validasi
      stage(job, 'Validasi ZIP', 'run');
      let info;
      try { info = await validateZip(zip, { maxEntries: cfg.limits.maxEntries, maxUncompressed: cfg.limits.maxUncompressedBytes }); }
      catch (e) { throw new BuildError('ZIP ditolak: ' + e.message); }
      checkAbort(job);
      stage(job, 'Validasi ZIP', 'ok', `${info.entries} file`);

      // 3. upload ke GitHub release
      stage(job, 'Upload ke GitHub', 'run');
      job.release = await gh.createRelease('job-' + job.id, 'Job ' + job.id);
      let lastP = 0;
      await gh.uploadAsset(job.release.id, zip, 'project.zip', (s, t) => {
        if (Date.now() - lastP > 2500) { lastP = Date.now(); stage(job, 'Upload ke GitHub', 'run', `${fmtBytes(s)} / ${fmtBytes(t)}`); }
      }, job.ac.signal);
      checkAbort(job);
      await fsp.rm(zip, { force: true }); // hemat disk panel
      stage(job, 'Upload ke GitHub', 'ok');

      // 4. jalankan workflow
      stage(job, 'Menjalankan workflow', 'run', 'memulai...');
      job.dispatched = true;
      await gh.dispatch({ job_id: job.id, target: job.target, mode: job.mode });
      const result = await waitRun(job);

      if (result.conclusion !== 'success') {
        if (result.conclusion === 'cancelled' && job.aborted) throw new AbortError(job.aborted);
        job.buildFailed = true;
        refund = cfg.refundOnBuildError;
        await reportFailure(job, result);
        return;
      }

      // 5. ambil & verifikasi hasil
      stage(job, 'Mengambil hasil build', 'run');
      const want = job.target === 'web' ? 'result.zip' : 'result.apk';
      const rel = await gh.getRelease(job.release.id);
      const asset = (rel.assets || []).find((a) => a.name === want);
      if (!asset || !asset.size) throw new BuildError(`Workflow sukses tetapi file hasil (${want}) tidak ada / kosong.`);
      const outName = job.target === 'web' ? `web-${job.id}.zip` : `app-${job.mode}-${job.id}.apk`;
      const outPath = path.join(job.dir, outName);

      if (asset.size > tgLimit) {
        job.keepRelease = true;
        refund = false; outcome = 'success';
        db.settle(job.id);
        await send(job.chatId, `✅ <b>BUILD BERHASIL</b>\nUkuran hasil <b>${fmtBytes(asset.size)}</b> melebihi batas kirim Telegram.\n\n🔗 <a href="${esc(asset.browser_download_url)}">Download dari GitHub</a>\n<i>(butuh repo public / login akun GitHub pemilik repo; file dihapus otomatis ${cfg.retainHours} jam lagi)</i>`);
      } else {
        const got = await gh.downloadAsset(asset, outPath, { signal: job.ac.signal });
        const st = await fsp.stat(outPath);
        if (!st.size || st.size !== asset.size || got !== asset.size) throw new BuildError('File hasil rusak/tidak lengkap saat diunduh.');
        if (job.target === 'apk') {
          const fd = await fsp.open(outPath, 'r'); const b = Buffer.alloc(2); await fd.read(b, 0, 2, 0); await fd.close();
          if (b.toString() !== 'PK') throw new BuildError('File hasil bukan APK yang valid.');
        }
        checkAbort(job);
        stage(job, 'Mengambil hasil build', 'ok', fmtBytes(st.size));
        db.settle(job.id); refund = false; outcome = 'success';
        await tg.sendDocument(job.chatId, { source: fs.createReadStream(outPath), filename: outName }, {
          parse_mode: 'HTML',
          caption: `✅ <b>BUILD BERHASIL</b>\n📦 ${label(job)}\n📏 ${fmtBytes(st.size)} • ⏱ ${fmtDur(Date.now() - job.t0)}\n💳 Sisa credit: <b>${esc(db.creditText(job.userId))}</b>`,
        });
      }
    } catch (e) {
      if (e instanceof AbortError) {
        outcome = e.reason;
        const text = e.reason === 'maintenance' ? `🔧 <b>${MAINT_TEXT}</b>\n\n💳 Credit kamu sudah dikembalikan.`
          : e.reason === 'user' ? '🚫 <b>Build dibatalkan.</b>\n💳 Credit kamu sudah dikembalikan.'
          : e.reason === 'shutdown' ? '♻️ <b>Bot sedang restart.</b> Build dihentikan dan credit dikembalikan. Silakan coba lagi sebentar lagi.'
          : '⏱ <b>Build dihentikan (timeout).</b>\n💳 Credit kamu sudah dikembalikan.';
        await send(job.chatId, text);
      } else {
        console.error(`[job ${job.id}]`, e);
        const msg = e instanceof BuildError ? e.message : (e.message || String(e));
        await send(job.chatId, `❌ <b>BUILD GAGAL</b>\n🆔 <code>${job.id}</code>\n\n<b>Penyebab:</b>\n<pre>${esc(scrub(msg).slice(0, 1500))}</pre>\n💳 Credit kamu dikembalikan.`);
      }
    } finally {
      job.done = true;
      clearInterval(job.timer); clearTimeout(job.guard);
      const refunded = refund ? db.refund(job.id) : false;
      if (outcome === 'success') db.settle(job.id);
      if (job.buildFailed && refunded) await send(job.chatId, '💳 Credit dikembalikan.');
      if (job.buildFailed && !refunded && !cfg.refundOnBuildError) await send(job.chatId, '💳 Credit tetap terpakai karena build gagal akibat kode project.');
      // batalkan run yang masih menggantung
      if (job.aborted) {
        try { const r = job.runId ? { id: job.runId } : (job.dispatched ? await gh.findRun(job.id) : null); if (r) await gh.cancelRun(r.id); } catch {}
      }
      const final = outcome === 'success' ? '✅ Selesai' : outcome === 'failed' ? '❌ Gagal' : '🚫 Dihentikan';
      await edit(job, `${render(job).split('\n')[0].replace('BUILD BERJALAN', 'BUILD SELESAI')}\n🆔 <code>${job.id}</code> • ${label(job)}\n⏱ ${fmtDur(Date.now() - job.t0)}\n${final}`, { inline_keyboard: [] });
      db.addHistory({ id: job.id, userId: job.userId, target: job.target, mode: job.mode, state: outcome === 'success' ? 'success' : outcome === 'failed' ? 'failed' : 'aborted', at: Date.now(), dur: Date.now() - job.t0 });
      // bersihkan file lokal & release GitHub
      try { const d = path.resolve(job.dir); if (d.startsWith(root + path.sep)) await fsp.rm(d, { recursive: true, force: true }); } catch {}
      if (job.release && !job.keepRelease) gh.deleteRelease(job.release.id, 'job-' + job.id).catch(() => {});
      jobs.delete(job.id);
    }
  }

  function start(job) {
    job.dir = path.resolve(root, job.id);
    if (!job.dir.startsWith(root + path.sep)) throw new Error('Path job tidak valid');
    fs.mkdirSync(job.dir, { recursive: true });
    job.t0 = Date.now(); job.local = []; job.ac = new AbortController(); job.aborted = null;
    jobs.set(job.id, job);
    job.timer = setInterval(() => refresh(job), 5000);
    // pengaman terakhir: job tidak pernah boleh menggantung selamanya
    job.guard = setTimeout(() => abort(job.id, 'timeout'), (cfg.buildTimeoutMinutes + 15) * 60e3);
    refresh(job, true);
    run(job).catch((e) => console.error('[run]', e));
  }

  function abort(id, reason) {
    const job = jobs.get(id);
    if (!job || job.done) return false;
    job.aborted = reason;
    try { job.ac.abort(); } catch {}
    if (job.runId) gh.cancelRun(job.runId);
    return true;
  }
  function abortAll(reason) { let n = 0; for (const id of [...jobs.keys()]) if (abort(id, reason)) n++; return n; }

  return {
    start, abort, abortAll,
    get: (id) => jobs.get(id),
    count: () => jobs.size,
    userActive: (uid) => [...jobs.values()].some((j) => j.userId === uid),
    activeTags: () => [...jobs.keys()].map((i) => 'job-' + i),
    MAINT_TEXT,
  };
}

module.exports = { createBuilder, MAINT_TEXT };
