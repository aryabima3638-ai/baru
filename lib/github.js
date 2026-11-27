const fs = require('fs');
const path = require('path');
const https = require('https');
const { download } = require('./util');

const API = 'https://api.github.com';

class GhError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function mapError(status, json, headers) {
  const msg = json?.message || '';
  if (status === 401) return new GhError(status, 'Token GitHub tidak valid (401 Bad credentials). Periksa github.token di setting.js.');
  if (status === 403 || status === 429) {
    if (headers?.get?.('x-ratelimit-remaining') === '0') return new GhError(status, 'Rate limit GitHub tercapai. Coba lagi beberapa menit.');
    return new GhError(status, `Akses ditolak GitHub (403): ${msg}. Pastikan token punya scope repo + workflow.`);
  }
  if (status === 404) return new GhError(status, `GitHub 404: repo/workflow/file tidak ditemukan atau token tidak punya akses. (${msg})`);
  if (status === 422) return new GhError(status, `GitHub 422: ${msg} ${JSON.stringify(json?.errors || '')}`);
  return new GhError(status, `GitHub error ${status}: ${msg}`);
}

function createGithub(cfg) {
  const { token, owner, repo, branch, workflow } = cfg.github;
  const H = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'flutter-sc-builder',
  };
  const R = `/repos/${owner}/${repo}`;

  async function api(method, p, body, expect = [200, 201, 204]) {
    const res = await fetch(API + p, {
      method,
      headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!expect.includes(res.status)) throw mapError(res.status, json, res.headers);
    return json;
  }

  // Pasang / perbarui .github/workflows/build.yml di repo otomatis.
  async function ensureWorkflow() {
    const local = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'build.yml'));
    const p = `${R}/contents/.github/workflows/${workflow}`;
    let sha = null;
    try {
      const r = await api('GET', `${p}?ref=${encodeURIComponent(branch)}`);
      sha = r.sha;
      if (r.content && Buffer.from(r.content, 'base64').equals(local)) return 'sudah terbaru';
    } catch (e) { if (e.status !== 404) throw e; }
    await api('PUT', p, { message: 'chore: update build workflow', content: local.toString('base64'), branch, ...(sha ? { sha } : {}) });
    return sha ? 'diperbarui' : 'dibuat';
  }

  const createRelease = (tag, name) =>
    api('POST', `${R}/releases`, { tag_name: tag, name, prerelease: true, target_commitish: branch, body: 'Job otomatis dari bot. Akan dihapus otomatis.' });

  const getRelease = (id) => api('GET', `${R}/releases/${id}`);

  async function deleteRelease(id, tag) {
    await api('DELETE', `${R}/releases/${id}`, null, [204, 404]).catch(() => {});
    if (tag) await api('DELETE', `${R}/git/refs/tags/${encodeURIComponent(tag)}`, null, [204, 404, 422]).catch(() => {});
  }

  function uploadAsset(releaseId, file, name, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const size = fs.statSync(file).size;
      const u = new URL(`https://uploads.github.com${R}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`);
      const req = https.request(u, { method: 'POST', headers: { ...H, 'Content-Type': 'application/zip', 'Content-Length': size } }, (res) => {
        const ch = [];
        res.on('data', (c) => ch.push(c));
        res.on('end', () => {
          const t = Buffer.concat(ch).toString();
          let j = null; try { j = JSON.parse(t); } catch {}
          if (res.statusCode === 201) return resolve(j);
          reject(mapError(res.statusCode, j, null));
        });
      });
      req.on('error', reject);
      req.setTimeout(180000, () => req.destroy(new Error('Timeout upload ke GitHub (180 detik tanpa respon)')));
      if (signal) {
        const onAbort = () => req.destroy(new Error('Dibatalkan'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const rs = fs.createReadStream(file);
      let sent = 0;
      rs.on('data', (c) => { sent += c.length; if (onProgress) onProgress(sent, size); });
      rs.on('error', reject);
      rs.pipe(req);
    });
  }

  async function dispatch(inputs) {
    // workflow yang baru di-push kadang butuh beberapa detik untuk terdaftar
    for (let i = 0; i < 8; i++) {
      try {
        await api('POST', `${R}/actions/workflows/${workflow}/dispatches`, { ref: branch, inputs }, [204]);
        return;
      } catch (e) {
        if (e.status !== 404 || i === 7) throw e;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  async function findRun(jobId) {
    const j = await api('GET', `${R}/actions/runs?event=workflow_dispatch&per_page=30`);
    return (j.workflow_runs || []).find((r) => `${r.display_title || ''} ${r.name || ''}`.includes(jobId)) || null;
  }
  const getRun = (id) => api('GET', `${R}/actions/runs/${id}`);
  async function getJobs(runId) { return (await api('GET', `${R}/actions/runs/${runId}/jobs?per_page=10`)).jobs || []; }
  const cancelRun = (id) => api('POST', `${R}/actions/runs/${id}/cancel`, null, [202, 409, 404]).catch(() => {});

  const dl = (url, dest, opts = {}) => download(url, dest, { ...opts, headers: { ...H, Accept: 'application/octet-stream' } });
  const downloadAsset = (asset, dest, opts) => dl(`${API}${R}/releases/assets/${asset.id}`, dest, opts);
  const downloadJobLog = (jobId, dest) => dl(`${API}${R}/actions/jobs/${jobId}/logs`, dest, {});

  // hapus release job-* yang sudah lebih tua dari `hours` (kecuali tag yang sedang aktif)
  async function sweep(hours, keepTags = []) {
    let n = 0;
    const list = await api('GET', `${R}/releases?per_page=100`);
    for (const r of list) {
      if (!String(r.tag_name).startsWith('job-') || keepTags.includes(r.tag_name)) continue;
      if (Date.now() - new Date(r.created_at).getTime() >= hours * 3600e3) { await deleteRelease(r.id, r.tag_name); n++; }
    }
    return n;
  }

  return { api, ensureWorkflow, createRelease, getRelease, deleteRelease, uploadAsset, dispatch, findRun, getRun, getJobs, cancelRun, downloadAsset, downloadJobLog, sweep, GhError };
}

module.exports = { createGithub };
