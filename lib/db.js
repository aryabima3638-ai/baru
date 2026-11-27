const fs = require('fs');
const path = require('path');

// Database JSON sederhana (tanpa dependency native, aman untuk panel).
// Semua mutasi sinkron -> atomik di Node single-thread. Simpan via tmp+rename.
class Store {
  constructor(file, cfg) {
    this.file = file;
    this.cfg = cfg;
    this.d = { users: {}, active: {}, history: [], settings: { maintenance: false, maintenanceBy: null, maintenanceAt: null, photoCache: {} } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.d = { ...this.d, ...raw, settings: { ...this.d.settings, ...(raw.settings || {}) } };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
        console.error('[DB] File rusak, dibuat baru:', e.message);
      }
    }
    this._t = null;
  }

  save() {
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.flush(); }, 300);
  }

  flush() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.d));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[DB] Gagal simpan:', e.message); }
  }

  // ---- user ----
  ensure(from) {
    const id = String(from.id);
    let u = this.d.users[id];
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || id;
    if (!u) {
      u = this.d.users[id] = { id: Number(id), name, username: from.username || null, role: 'member', credits: this.cfg.freeCredits, emptiedAt: null, verified: false, joinedAt: Date.now(), builds: 0, startNotified: false };
      this.save();
    } else if (u.name !== name || u.username !== (from.username || null)) {
      if (from.first_name || from.username) { u.name = name; u.username = from.username || null; this.save(); }
    }
    return u;
  }

  stub(id) {
    const k = String(id);
    if (!this.d.users[k]) {
      this.d.users[k] = { id: Number(id), name: '(belum /start)', username: null, role: 'member', credits: this.cfg.freeCredits, emptiedAt: null, verified: false, joinedAt: Date.now(), builds: 0, startNotified: false };
      this.save();
    }
    return this.d.users[k];
  }

  isRoot(id) { return this.cfg.owners.includes(Number(id)); }
  role(id) { return this.isRoot(id) ? 'owner' : (this.d.users[String(id)]?.role || 'member'); }
  unlimited(id) { return this.role(id) !== 'member'; }

  refill(u) {
    if (u.role === 'member' && u.credits <= 0 && u.emptiedAt && Date.now() - u.emptiedAt >= this.cfg.creditResetHours * 3600e3) {
      u.credits = this.cfg.freeCredits;
      u.emptiedAt = null;
      this.save();
    }
  }

  hasCredit(id) {
    if (this.unlimited(id)) return true;
    const u = this.stub(id);
    this.refill(u);
    return u.credits >= 1;
  }

  creditText(id) {
    if (this.unlimited(id)) return '∞ (UNLIMITED)';
    const u = this.stub(id);
    this.refill(u);
    if (u.credits <= 0 && u.emptiedAt) {
      const left = Math.max(0, this.cfg.creditResetHours * 3600e3 - (Date.now() - u.emptiedAt));
      const h = Math.floor(left / 3600e3), m = Math.ceil((left % 3600e3) / 60e3);
      return `0 (reset ${h}j ${m}m lagi)`;
    }
    return String(u.credits);
  }

  // ---- credit: charge/settle/refund idempoten lewat tabel `active` ----
  charge(jobId, userId) {
    const u = this.stub(userId);
    if (this.unlimited(userId)) { this.d.active[jobId] = { userId: Number(userId), charged: 0 }; this.save(); return true; }
    this.refill(u);
    if (u.credits < 1) return false;
    u.credits -= 1;
    if (u.credits === 0) u.emptiedAt = Date.now();
    this.d.active[jobId] = { userId: Number(userId), charged: 1 };
    this.save();
    return true;
  }

  settle(jobId) { delete this.d.active[jobId]; this.save(); }

  refund(jobId) {
    const a = this.d.active[jobId];
    if (!a) return false; // sudah di-settle/refund -> tidak dobel
    delete this.d.active[jobId];
    if (a.charged) {
      const u = this.stub(a.userId);
      u.credits += 1;
      u.emptiedAt = null;
    }
    this.save();
    return !!a.charged;
  }

  addCredit(id, n) {
    const u = this.stub(id);
    u.credits += n;
    if (u.credits > 0) u.emptiedAt = null;
    this.save();
    return u.credits;
  }

  setRole(id, role) { const u = this.stub(id); u.role = role; this.save(); return u; }

  addHistory(h) {
    this.d.history.push(h);
    if (this.d.history.length > 500) this.d.history.splice(0, this.d.history.length - 500);
    const u = this.d.users[String(h.userId)];
    if (u && h.state === 'success') u.builds = (u.builds || 0) + 1;
    this.save();
  }
}

module.exports = { Store };
